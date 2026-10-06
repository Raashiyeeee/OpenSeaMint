import { ethers, Wallet } from 'ethers';
import { BotConfig } from '../types';
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
    networkKey?: string
  ): Promise<{ orderComponents: any; signature: string }> {
    const offerer = this.signer.address;
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationMinutes * 60;
    const salt = ethers.toBigInt(ethers.hexlify(ethers.randomBytes(16))).toString();

    const wethToken = (networkKey && this.config.networks[networkKey]?.wethAddress)
      || this.wethAddress;
    const conduitKey = (networkKey && this.config.networks[networkKey]?.conduitKey)
      || this.config.seaport.conduitKey;

    const bidWei = toWeiString(bidPriceEth);
    const feeBps = this.config.fees.openseaFeeBps || 100;
    const feeWei = ((BigInt(bidWei) * BigInt(feeBps)) / 10000n).toString();

    const offer = [
      {
        itemType: 1, // ERC20 (WETH)
        token: ethers.getAddress(wethToken),
        identifierOrCriteria: '0',
        startAmount: bidWei,
        endAmount: bidWei
      }
    ];

    const consideration = [
      {
        itemType: 4, // ERC721_WITH_CRITERIA
        token: ethers.getAddress(contractAddress),
        identifierOrCriteria: '0', // 0 indicates collection-wide criteria
        startAmount: '1',
        endAmount: '1',
        recipient: ethers.getAddress(offerer)
      },
      {
        itemType: 1, // ERC20 (WETH) OpenSea protocol fee
        token: ethers.getAddress(wethToken),
        identifierOrCriteria: '0',
        startAmount: feeWei,
        endAmount: feeWei,
        recipient: '0x0000a26b00c1f0df003000390027140000faa719'
      }
    ];

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
      counter: 0,
      totalOriginalConsiderationItems: consideration.length
    };

    const domain = this.getEip712Domain(networkKey);
    logger.debug({ offerer, bidPriceEth, domain, conduitKey }, 'Signing Seaport Collection Offer via EIP-712');

    const signature = await this.signer.signTypedData(
      domain,
      SEAPORT_ORDER_TYPES,
      {
        offerer: orderComponents.offerer,
        zone: orderComponents.zone,
        offer: orderComponents.offer,
        consideration: orderComponents.consideration,
        orderType: orderComponents.orderType,
        startTime: orderComponents.startTime,
        endTime: orderComponents.endTime,
        zoneHash: orderComponents.zoneHash,
        salt: orderComponents.salt,
        conduitKey: orderComponents.conduitKey,
        counter: orderComponents.counter
      }
    );

    return { orderComponents, signature };
  }

  /**
   * Constructs and signs an off-chain EIP-712 Listing order.
   * In Seaport:
   * OfferItem: ERC721 (ItemType 2)
   * ConsiderationItem 1: Net ETH to seller (offerer)
   * ConsiderationItem 2: OpenSea fee ETH to OpenSea fee recipient
   */
  public async createSignedListing(
    contractAddress: string,
    tokenId: string,
    listPriceEth: number,
    openseaFeeBps: number = 50,
    durationDays: number = 7,
    networkKey?: string
  ): Promise<{ orderComponents: any; signature: string }> {
    const offerer = this.signer.address;
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationDays * 86400;
    const salt = ethers.toBigInt(ethers.hexlify(ethers.randomBytes(16))).toString();

    const totalWei = ethers.parseEther(listPriceEth.toFixed(8));
    const feeWei = (totalWei * BigInt(openseaFeeBps)) / 10000n;
    const sellerWei = totalWei - feeWei;

    const offer = [
      {
        itemType: 2, // ERC721
        token: ethers.getAddress(contractAddress),
        identifierOrCriteria: tokenId,
        startAmount: '1',
        endAmount: '1'
      }
    ];

    const consideration = [
      {
        itemType: 0, // NATIVE ETH
        token: ethers.ZeroAddress,
        identifierOrCriteria: '0',
        startAmount: sellerWei.toString(),
        endAmount: sellerWei.toString(),
        recipient: ethers.getAddress(offerer)
      },
      {
        itemType: 0, // NATIVE ETH
        token: ethers.ZeroAddress,
        identifierOrCriteria: '0',
        startAmount: feeWei.toString(),
        endAmount: feeWei.toString(),
        recipient: ethers.getAddress('0x0000a26b00c1F0DF003000390027140000fAa719') // OpenSea fee recipient
      }
    ];

    const orderComponents = {
      offerer: ethers.getAddress(offerer),
      zone: ethers.getAddress(this.config.seaport.zoneAddress),
      offer,
      consideration,
      orderType: 2, // FULL_RESTRICTED
      startTime,
      endTime,
      zoneHash: ethers.ZeroHash,
      salt,
      conduitKey: this.config.seaport.conduitKey,
      counter: 0
    };

    const domain = this.getEip712Domain(networkKey);
    logger.debug({ offerer, tokenId, listPriceEth, domain }, 'Signing Seaport Listing via EIP-712');

    const signature = await this.signer.signTypedData(
      domain,
      SEAPORT_ORDER_TYPES,
      orderComponents
    );

    return { orderComponents, signature };
  }
}
