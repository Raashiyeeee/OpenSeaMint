import { ethers, Wallet } from 'ethers';
import { BotConfig, FeeRecipient } from '../types';
import { toWeiString } from '../utils/math';
import { logger } from '../utils/logger';

// Standard Seaport EIP-712 types
export const EIP712_SEAPORT_DOMAINS = {
  name: 'Seaport',
  version: '1.6',
  chainId: 1, // Mainnet
  verifyingContract: '0x0000000000000068F116a894984e2DB1123eB395'
};

export const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' }
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' }
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' }
  ]
};

export class SeaportService {
  private config: BotConfig;
  private signer: Wallet | ethers.HDNodeWallet;
  private wethAddress: string = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

  constructor(config: BotConfig, signer: Wallet | ethers.HDNodeWallet) {
    this.config = config;
    this.signer = signer;
  }

  /**
   * Query on-chain WETH balance of trading signer on the target network
   */
  public async getWethBalance(networkKey?: string): Promise<number> {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    if (!networkInfo) return 0;
    const wethToken = networkInfo.wethAddress || this.wethAddress;
    try {
      const provider = new ethers.JsonRpcProvider(networkInfo.rpcUrl);
      const erc20 = new ethers.Contract(wethToken, ['function balanceOf(address) view returns (uint256)'], provider);
      const bal = await erc20.balanceOf(this.signer.address);
      return parseFloat(ethers.formatEther(bal));
    } catch (err: any) {
      logger.debug({ network: activeNetworkKey, err: err.message }, 'Could not query WETH balance');
      return 0;
    }
  }

  /**
   * Constructs and signs an off-chain EIP-712 Collection Offer order.
   * In Seaport:
   * OfferItem: WETH (ItemType 1 ERC20)
   * ConsiderationItem: ERC721_WITH_CRITERIA (ItemType 4) with criteria 0 (any token in collection)
   */
  public getEip712Domain(networkKey?: string): any {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const chainId = networkInfo?.chainId ?? (activeNetworkKey === 'robinhood' ? 4663 : 1);
    const verifyingContract = networkInfo?.seaportAddress || this.config.seaport.contractAddress;

    return {
      name: 'Seaport',
      version: this.config.seaport.version || '1.6',
      chainId,
      verifyingContract
    };
  }

  public async createSignedCollectionOffer(
    contractAddress: string,
    bidPriceEth: number,
    durationMinutes: number = 60,
    networkKey?: string,
    fees?: FeeRecipient[]
  ): Promise<{ orderComponents: any; signature: string }> {
    const offerer = this.signer.address;
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationMinutes * 60;
    const salt = '0x' + Buffer.from(ethers.randomBytes(16)).toString('hex');

    const wethToken = (networkKey && this.config.networks[networkKey]?.wethAddress)
      || this.wethAddress;
    const conduitKey = (networkKey && this.config.networks[networkKey]?.conduitKey)
      || this.config.seaport.conduitKey;

    const bidWei = toWeiString(bidPriceEth);

    const offer = [
      {
        itemType: 1, // ERC20 (WETH)
        token: ethers.getAddress(wethToken),
        identifierOrCriteria: '0',
        startAmount: bidWei,
        endAmount: bidWei
      }
    ];

    const consideration: any[] = [
      {
        itemType: 4, // ERC721_WITH_CRITERIA
        token: ethers.getAddress(contractAddress),
        identifierOrCriteria: '0', // 0 indicates collection-wide criteria
        startAmount: '1',
        endAmount: '1',
        recipient: ethers.getAddress(offerer)
      }
    ];

    // Mandatory vs Optional Creator Fee Rule:
    // Filter out optional creator fees (required === false or disabled === true)
    const effectiveFees = (fees || []).filter((f) => f.required !== false && f.disabled !== true);

    if (effectiveFees.length > 0) {
      for (const f of effectiveFees) {
        const feeWei = ((BigInt(bidWei) * BigInt(Math.round(f.fee * 100))) / 10000n).toString();
        consideration.push({
          itemType: 1, // ERC20 (WETH)
          token: ethers.getAddress(wethToken),
          identifierOrCriteria: '0',
          startAmount: feeWei,
          endAmount: feeWei,
          recipient: ethers.getAddress(f.recipient)
        });
      }
    } else {
      const defaultFeeWei = ((BigInt(bidWei) * BigInt(this.config.fees.openseaFeeBps || 100)) / 10000n).toString();
      consideration.push({
        itemType: 1,
        token: ethers.getAddress(wethToken),
        identifierOrCriteria: '0',
        startAmount: defaultFeeWei,
        endAmount: defaultFeeWei,
        recipient: '0x0000a26b00c1f0df003000390027140000faa719'
      });
    }

    // Verify optional creator fees are truly disabled
    this.verifyOrderFees(consideration, fees);

    const domain = this.getEip712Domain(networkKey);
    let counter = '0';
    try {
      const seaportContract = new ethers.Contract(
        domain.verifyingContract,
        ['function getCounter(address) view returns (uint256)'],
        this.signer.provider || new ethers.JsonRpcProvider(this.config.networks[networkKey || 'robinhood']?.rpcUrl)
      );
      const c = await seaportContract.getCounter(offerer);
      counter = c.toString();
    } catch {
      counter = '0';
    }

    const orderComponents = {
      offerer: ethers.getAddress(offerer),
      zone: ethers.getAddress(this.config.seaport.zoneAddress),
      offer,
      consideration,
      orderType: 2, // FULL_RESTRICTED (zone can validate)
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      zoneHash: ethers.ZeroHash,
      salt,
      conduitKey,
      counter,
      totalOriginalConsiderationItems: consideration.length
    };

    logger.debug({ offerer, bidPriceEth, domain, conduitKey }, 'Signing Seaport Collection Offer via EIP-712');

    const signature = await this.signer.signTypedData(
      domain,
      SEAPORT_ORDER_TYPES,
      orderComponents
    );

    return { orderComponents, signature };
  }

  /**
   * Constructs and signs an off-chain EIP-712 Single Item Buy Order (Larry offerSingle style)
   */
  public async createSignedItemOffer(
    contractAddress: string,
    tokenId: string,
    bidPriceEth: number,
    durationMinutes: number = 60,
    networkKey?: string,
    fees?: FeeRecipient[]
  ): Promise<{ orderComponents: any; signature: string }> {
    const offerer = this.signer.address;
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationMinutes * 60;
    const salt = '0x' + Buffer.from(ethers.randomBytes(16)).toString('hex');

    const wethToken = (networkKey && this.config.networks[networkKey]?.wethAddress)
      || this.wethAddress;
    const conduitKey = (networkKey && this.config.networks[networkKey]?.conduitKey)
      || this.config.seaport.conduitKey;

    const bidWei = toWeiString(bidPriceEth);

    const offer = [
      {
        itemType: 1, // ERC20 (WETH)
        token: ethers.getAddress(wethToken),
        identifierOrCriteria: '0',
        startAmount: bidWei,
        endAmount: bidWei
      }
    ];

    const consideration: any[] = [
      {
        itemType: 2, // ERC721 Single Token
        token: ethers.getAddress(contractAddress),
        identifierOrCriteria: tokenId,
        startAmount: '1',
        endAmount: '1',
        recipient: ethers.getAddress(offerer)
      }
    ];

    // Mandatory vs Optional Creator Fee Rule:
    const effectiveFees = (fees || []).filter((f) => f.required !== false && f.disabled !== true);

    if (effectiveFees.length > 0) {
      for (const f of effectiveFees) {
        const feeWei = ((BigInt(bidWei) * BigInt(Math.round(f.fee * 100))) / 10000n).toString();
        consideration.push({
          itemType: 1, // ERC20 (WETH)
          token: ethers.getAddress(wethToken),
          identifierOrCriteria: '0',
          startAmount: feeWei,
          endAmount: feeWei,
          recipient: ethers.getAddress(f.recipient)
        });
      }
    } else {
      const defaultFeeWei = ((BigInt(bidWei) * BigInt(this.config.fees.openseaFeeBps || 100)) / 10000n).toString();
      consideration.push({
        itemType: 1,
        token: ethers.getAddress(wethToken),
        identifierOrCriteria: '0',
        startAmount: defaultFeeWei,
        endAmount: defaultFeeWei,
        recipient: '0x0000a26b00c1f0df003000390027140000faa719'
      });
    }

    // Verify optional creator fees are truly disabled
    this.verifyOrderFees(consideration, fees);

    const domain = this.getEip712Domain(networkKey);
    let counter = '0';
    try {
      const seaportContract = new ethers.Contract(
        domain.verifyingContract,
        ['function getCounter(address) view returns (uint256)'],
        this.signer.provider || new ethers.JsonRpcProvider(this.config.networks[networkKey || 'robinhood']?.rpcUrl)
      );
      const c = await seaportContract.getCounter(offerer);
      counter = c.toString();
    } catch {
      counter = '0';
    }

    const orderComponents = {
      offerer: ethers.getAddress(offerer),
      zone: ethers.getAddress(this.config.seaport.zoneAddress),
      offer,
      consideration,
      orderType: 2, // FULL_RESTRICTED
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      zoneHash: ethers.ZeroHash,
      salt,
      conduitKey,
      counter,
      totalOriginalConsiderationItems: consideration.length
    };

    logger.debug({ offerer, tokenId, bidPriceEth, domain }, 'Signing Seaport Item Offer via EIP-712');

    const signature = await this.signer.signTypedData(
      domain,
      SEAPORT_ORDER_TYPES,
      orderComponents
    );

    return { orderComponents, signature };
  }

  /**
   * Constructs and signs an off-chain EIP-712 Listing order.
   */
  public async createSignedListing(
    contractAddress: string,
    tokenId: string,
    listPriceEth: number,
    openseaFeeBps: number = 50,
    durationDays: number = 7,
    networkKey?: string,
    fees?: FeeRecipient[]
  ): Promise<{ orderComponents: any; signature: string }> {
    const offerer = this.signer.address;
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationDays * 86400;
    const salt = '0x' + Buffer.from(ethers.randomBytes(16)).toString('hex');

    const totalWei = ethers.parseEther(listPriceEth.toFixed(8));

    const offer = [
      {
        itemType: 2, // ERC721
        token: ethers.getAddress(contractAddress),
        identifierOrCriteria: tokenId,
        startAmount: '1',
        endAmount: '1'
      }
    ];

    let totalFeesWei = 0n;
    const feeConsiderations: any[] = [];

    // Mandatory vs Optional Creator Fee Rule:
    // Filter out optional creator fees (required === false or disabled === true)
    const effectiveFees = (fees || []).filter((f) => f.required !== false && f.disabled !== true);

    if (effectiveFees.length > 0) {
      for (const f of effectiveFees) {
        const feeWei = (totalWei * BigInt(Math.round(f.fee * 100))) / 10000n;
        totalFeesWei += feeWei;
        feeConsiderations.push({
          itemType: 0, // NATIVE ETH
          token: ethers.ZeroAddress,
          identifierOrCriteria: '0',
          startAmount: feeWei.toString(),
          endAmount: feeWei.toString(),
          recipient: ethers.getAddress(f.recipient)
        });
      }
    } else {
      const feeWei = (totalWei * BigInt(openseaFeeBps)) / 10000n;
      totalFeesWei += feeWei;
      feeConsiderations.push({
        itemType: 0,
        token: ethers.ZeroAddress,
        identifierOrCriteria: '0',
        startAmount: feeWei.toString(),
        endAmount: feeWei.toString(),
        recipient: ethers.getAddress('0x0000a26b00c1F0DF003000390027140000fAa719')
      });
    }

    // Verify optional creator fees are truly disabled in listing order considerations
    this.verifyOrderFees(feeConsiderations, fees);

    const sellerWei = totalWei - totalFeesWei;

    const consideration = [
      {
        itemType: 0, // NATIVE ETH to seller
        token: ethers.ZeroAddress,
        identifierOrCriteria: '0',
        startAmount: sellerWei.toString(),
        endAmount: sellerWei.toString(),
        recipient: ethers.getAddress(offerer)
      },
      ...feeConsiderations
    ];

    const domain = this.getEip712Domain(networkKey);
    let counter = '0';
    try {
      const seaportContract = new ethers.Contract(
        domain.verifyingContract,
        ['function getCounter(address) view returns (uint256)'],
        this.signer.provider || new ethers.JsonRpcProvider(this.config.networks[networkKey || 'robinhood']?.rpcUrl)
      );
      const c = await seaportContract.getCounter(offerer);
      counter = c.toString();
    } catch {
      counter = '0';
    }

    const conduitKey = (networkKey && this.config.networks[networkKey]?.conduitKey)
      || this.config.seaport.conduitKey;

    const orderComponents = {
      offerer: ethers.getAddress(offerer),
      zone: ethers.getAddress(this.config.seaport.zoneAddress),
      offer,
      consideration,
      orderType: 2, // FULL_RESTRICTED
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      zoneHash: ethers.ZeroHash,
      salt,
      conduitKey,
      counter,
      totalOriginalConsiderationItems: consideration.length
    };

    logger.debug({ offerer, tokenId, listPriceEth, domain }, 'Signing Seaport Listing via EIP-712');

    const signature = await this.signer.signTypedData(
      domain,
      SEAPORT_ORDER_TYPES,
      orderComponents
    );

    return { orderComponents, signature };
  }

  /**
   * Ensures the NFT contract has granted setApprovalForAll to the OpenSea conduit
   */
  public async ensureNftConduitApproval(contractAddress: string, networkKey?: string): Promise<boolean> {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    if (!networkInfo) return false;
    const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo.rpcUrl);
    const conduitAddress = activeNetworkKey === 'robinhood'
      ? '0x963F00d3ff000064fFCbA824b800c0000000C300'
      : '0x1E0049783F008A0085193E00003D00cd54003c71';

    try {
      const connectedSigner = this.signer.provider ? this.signer : (this.signer as any).connect(provider);
      const nft = new ethers.Contract(
        contractAddress,
        [
          'function isApprovedForAll(address owner, address operator) view returns (bool)',
          'function setApprovalForAll(address operator, bool approved) returns ()'
        ],
        connectedSigner
      );

      const isApproved = await nft.isApprovedForAll(this.signer.address, conduitAddress);
      if (isApproved) {
        return true;
      }

      logger.info({ contractAddress, conduitAddress, network: activeNetworkKey }, 'Approving OpenSea conduit for NFT contract...');
      const tx = await nft.setApprovalForAll(conduitAddress, true);
      await tx.wait(1);
      logger.info({ contractAddress, txHash: tx.hash }, '✅ NFT Contract approved for OpenSea conduit!');
      return true;
    } catch (err: any) {
      logger.error({ contractAddress, err: err.message }, 'Failed to approve OpenSea conduit for NFT');
      return false;
    }
  }

  /**
   * Mandatory Creator Fee Verification Rule:
   * Verifies that optional creator fees are strictly disabled (excluded from order considerations),
   * and that mandatory fees are preserved.
   */
  public verifyOrderFees(consideration: any[], rawFees?: FeeRecipient[]): void {
    if (!rawFees || rawFees.length === 0) return;

    for (const f of rawFees) {
      const isOptional = f.required === false || f.disabled === true;
      const recipient = f.recipient.toLowerCase();
      const isPresent = consideration.some((c) => c.recipient?.toLowerCase() === recipient);

      if (isOptional && isPresent) {
        logger.error({ recipient, fee: f.fee }, 'Creator fee verification failed: Optional creator fee found in order considerations!');
        throw new Error(`Creator fee violation: Optional creator fee for ${f.recipient} must be disabled but was found in considerations.`);
      }

      if (!isOptional && !isPresent && !recipient.includes('opensea')) {
        logger.warn({ recipient, fee: f.fee }, 'Mandatory creator fee missing from order considerations.');
      }
    }

    logger.debug('Creator fee check passed: Optional creator fees verified disabled, mandatory fees preserved.');
  }
}
