import { ethers, Wallet } from 'ethers';
import { BotConfig, FeeRecipient } from '../types';
import { toWeiString, roundToPrecision } from '../utils/math';
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

  public getWalletAddress(): string {
    return this.signer.address;
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
    fees?: FeeRecipient[],
    options?: { currency?: 'ETH' | 'USDG'; bidPriceUsdg?: number }
  ): Promise<{ orderComponents: any; signature: string }> {
    const offerer = this.signer.address;
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationMinutes * 60;
    const salt = '0x' + Buffer.from(ethers.randomBytes(16)).toString('hex');

    const isUsdg = options?.currency === 'USDG';
    const networkInfo = (networkKey && this.config.networks[networkKey]) || undefined;
    const paymentToken = isUsdg
      ? (networkInfo?.usdgAddress || this.config.networks?.['robinhood']?.usdgAddress || '0x595a8910ba11e38ada602430b8b1122644247b0c')
      : (networkInfo?.wethAddress || this.wethAddress);
    const decimals = isUsdg ? (networkInfo?.usdgDecimals || 6) : 18;
    const conduitKey = (networkKey && this.config.networks[networkKey]?.conduitKey)
      || this.config.seaport.conduitKey;

    let bidUnits: string;
    if (isUsdg) {
      const usdgVal = options?.bidPriceUsdg ?? (bidPriceEth * 2500);
      bidUnits = ethers.parseUnits(usdgVal.toFixed(decimals), decimals).toString();
    } else {
      bidUnits = toWeiString(bidPriceEth);
    }

    const offer = [
      {
        itemType: 1, // ERC20 (WETH or USDG)
        token: ethers.getAddress(paymentToken),
        identifierOrCriteria: '0',
        startAmount: bidUnits,
        endAmount: bidUnits
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
        const feeWei = ((BigInt(bidUnits) * BigInt(Math.round(f.fee * 100))) / 10000n).toString();
        consideration.push({
          itemType: 1, // ERC20 (WETH or USDG)
          token: ethers.getAddress(paymentToken),
          identifierOrCriteria: '0',
          startAmount: feeWei,
          endAmount: feeWei,
          recipient: ethers.getAddress(f.recipient)
        });
      }
    } else {
      const defaultFeeWei = ((BigInt(bidUnits) * BigInt(this.config.fees.openseaFeeBps || 100)) / 10000n).toString();
      consideration.push({
        itemType: 1,
        token: ethers.getAddress(paymentToken),
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
    fees?: FeeRecipient[],
    options?: { currency?: 'ETH' | 'USDG'; bidPriceUsdg?: number }
  ): Promise<{ orderComponents: any; signature: string }> {
    const offerer = this.signer.address;
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationMinutes * 60;
    const salt = '0x' + Buffer.from(ethers.randomBytes(16)).toString('hex');

    const isUsdg = options?.currency === 'USDG';
    const networkInfo = (networkKey && this.config.networks[networkKey]) || undefined;
    const paymentToken = isUsdg
      ? (networkInfo?.usdgAddress || this.config.networks?.['robinhood']?.usdgAddress || '0x595a8910ba11e38ada602430b8b1122644247b0c')
      : (networkInfo?.wethAddress || this.wethAddress);
    const decimals = isUsdg ? (networkInfo?.usdgDecimals || 6) : 18;
    const conduitKey = (networkKey && this.config.networks[networkKey]?.conduitKey)
      || this.config.seaport.conduitKey;

    let bidUnits: string;
    if (isUsdg) {
      const usdgVal = options?.bidPriceUsdg ?? (bidPriceEth * 2500);
      bidUnits = ethers.parseUnits(usdgVal.toFixed(decimals), decimals).toString();
    } else {
      bidUnits = toWeiString(bidPriceEth);
    }

    const offer = [
      {
        itemType: 1, // ERC20 (WETH or USDG)
        token: ethers.getAddress(paymentToken),
        identifierOrCriteria: '0',
        startAmount: bidUnits,
        endAmount: bidUnits
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
        const feeWei = ((BigInt(bidUnits) * BigInt(Math.round(f.fee * 100))) / 10000n).toString();
        consideration.push({
          itemType: 1, // ERC20 (WETH or USDG)
          token: ethers.getAddress(paymentToken),
          identifierOrCriteria: '0',
          startAmount: feeWei,
          endAmount: feeWei,
          recipient: ethers.getAddress(f.recipient)
        });
      }
    } else {
      const defaultFeeWei = ((BigInt(bidUnits) * BigInt(this.config.fees.openseaFeeBps || 100)) / 10000n).toString();
      consideration.push({
        itemType: 1,
        token: ethers.getAddress(paymentToken),
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

    // Mandatory Creator Fee Disable Rule:
    // If the creator fee is optional and can be disabled, the bot must disable it before executing any NFT sale.
    const feeDisableResult = this.verifyAndDisableOptionalCreatorFees(fees);
    const effectiveFees = feeDisableResult.effectiveFees;

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

    // Verify optional creator fees are truly disabled in listing order considerations before proceeding
    this.verifyOrderFees(feeConsiderations, fees);
    const preSaleCheck = this.verifyCreatorFeeDisabledBeforeSale(feeConsiderations, fees);
    if (!preSaleCheck.verified) {
      throw new Error(`NFT sale execution aborted: ${preSaleCheck.reason}`);
    }

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
   * Pre-approves an ERC20 token (USDG / WETH) for the OpenSea conduit
   */
  public async ensureTokenConduitApproval(
    tokenAddress: string,
    networkKey?: string
  ): Promise<void> {
    if (process.env.BOT_MODE === 'SIMULATION') {
      logger.info({ tokenAddress }, '[SIMULATION] Token conduit pre-approved ✅');
      return;
    }
    try {
      const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
      const networkInfo = this.config.networks?.[activeNetworkKey];
      const conduitAddress = activeNetworkKey === 'robinhood'
        ? '0x963F00d3ff000064fFCbA824b800c0000000C300'
        : '0x1E0049783F008A0085193E00003D00cd54003c71';
      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);
      const connectedSigner = this.signer.provider ? this.signer : (this.signer as any).connect(provider);

      const tokenContract = new ethers.Contract(
        tokenAddress,
        [
          'function allowance(address owner, address spender) view returns (uint256)',
          'function approve(address spender, uint256 amount) returns (bool)'
        ],
        connectedSigner
      );

      const currentAllowance: bigint = await tokenContract.allowance(this.signer.address, conduitAddress);
      if (currentAllowance > ethers.parseUnits('1000', 6)) {
        return;
      }
      const tx = await tokenContract.approve(conduitAddress, ethers.MaxUint256);
      await tx.wait(1);
      logger.info({ tokenAddress, conduitAddress, txHash: tx.hash }, '✅ Token approved for OpenSea conduit!');
    } catch (err: any) {
      logger.warn({ tokenAddress, err: err.message }, 'Could not verify/approve token for conduit');
    }
  }

  /**
   * Mandatory Creator Fee Disable Rule:
   * If the creator fee is optional and can be disabled, the bot must disable it before executing any NFT sale.
   * The bot must verify that the fee is disabled before proceeding with the sale.
   */
  public verifyAndDisableOptionalCreatorFees(rawFees?: FeeRecipient[]): {
    effectiveFees: FeeRecipient[];
    disabledCount: number;
    optionalFees: FeeRecipient[];
    verified: boolean;
  } {
    const fees = rawFees || [];
    const optionalFees: FeeRecipient[] = [];
    const effectiveFees: FeeRecipient[] = [];

    for (const f of fees) {
      if (f.required === false || f.disabled === true) {
        optionalFees.push({ ...f, fee: 0, disabled: true });
      } else {
        effectiveFees.push(f);
      }
    }

    // Verify: ensure no optional fees remain in effectiveFees
    const anyOptionalInEffective = effectiveFees.some((f) => f.required === false || f.disabled === true);
    if (anyOptionalInEffective) {
      throw new Error('Creator fee verification failure: Optional creator fee was not disabled before sale!');
    }

    if (optionalFees.length > 0) {
      logger.info(
        {
          totalFees: fees.length,
          optionalFeesDisabled: optionalFees.length,
          effectiveFeesCount: effectiveFees.length
        },
        `Mandatory Creator Fee Disable Rule: ${optionalFees.length} optional creator fee(s) disabled (0 bps) and verified before sale execution ✅`
      );
    }

    return {
      effectiveFees,
      disabledCount: optionalFees.length,
      optionalFees,
      verified: true
    };
  }

  /**
   * Pre-Sale Verification:
   * Verifies that all optional creator fees are strictly disabled (0 amount and excluded from considerations)
   * before proceeding with the sale. If an optional creator fee is found enabled or receiving consideration,
   * verification fails and the sale must not proceed.
   */
  public verifyCreatorFeeDisabledBeforeSale(
    consideration: any[],
    rawFees?: FeeRecipient[]
  ): { verified: boolean; disabledFeesCount: number; reason?: string } {
    if (!rawFees || rawFees.length === 0) {
      return { verified: true, disabledFeesCount: 0 };
    }

    let disabledFeesCount = 0;
    for (const f of rawFees) {
      const isOptional = f.required === false || f.disabled === true;
      if (!isOptional) continue;

      const recipient = f.recipient.toLowerCase();
      const matched = consideration.find(
        (c) => c.recipient && c.recipient.toLowerCase() === recipient && BigInt(c.startAmount || '0') > 0n
      );

      if (matched) {
        const reason = `Mandatory Creator Fee Disable Rule VIOLATION ❌: Optional creator fee for ${f.recipient} (${f.fee}%) is present in sale considerations with amount ${matched.startAmount}. Sale execution aborted!`;
        logger.error({ recipient: f.recipient, fee: f.fee, amount: matched.startAmount }, reason);
        return {
          verified: false,
          disabledFeesCount,
          reason
        };
      }

      disabledFeesCount++;
    }

    logger.debug(
      { disabledFeesCount },
      'Mandatory Creator Fee Disable Rule: Pre-sale verification PASSED ✅ All optional creator fees verified disabled before proceeding with sale.'
    );

    return { verified: true, disabledFeesCount };
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

  /**
   * On-chain Seaport order cancellation fallback
   */
  public async cancelOrderOnChain(orderComponents: any, networkKey?: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (process.env.BOT_MODE === 'SIMULATION' || !orderComponents) {
      logger.info({ networkKey }, '[SIMULATION] Simulated on-chain Seaport cancelOrder');
      return { success: true, txHash: `0xsim_cancel_${Date.now()}` };
    }

    try {
      const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
      const networkInfo = this.config.networks?.[activeNetworkKey];
      const seaportAddress = networkInfo?.seaportAddress || this.config.seaport.contractAddress;
      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);
      const connectedSigner = this.signer.provider ? this.signer : (this.signer as any).connect(provider);

      const seaportContract = new ethers.Contract(
        seaportAddress,
        ['function cancel(tuple(address offerer, address zone, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter)[] orders) external returns (bool)'],
        connectedSigner
      );

      const tx = await seaportContract.cancel([orderComponents]);
      const receipt = await tx.wait(1);
      logger.info({ txHash: receipt.hash, network: activeNetworkKey }, '✅ On-chain Seaport order cancellation confirmed');
      return { success: true, txHash: receipt.hash };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed on-chain Seaport order cancellation');
      return { success: false, error: err.message };
    }
  }

  /**
   * Queries on-chain Seaport order status
   */
  public async isOrderCancelledOnChain(orderHash: string, networkKey?: string): Promise<boolean> {
    if (process.env.BOT_MODE === 'SIMULATION') {
      return true;
    }
    try {
      const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
      const networkInfo = this.config.networks?.[activeNetworkKey];
      const seaportAddress = networkInfo?.seaportAddress || this.config.seaport.contractAddress;
      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);

      const seaportContract = new ethers.Contract(
        seaportAddress,
        ['function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)'],
        provider
      );

      const status = await seaportContract.getOrderStatus(orderHash);
      return status.isCancelled === true;
    } catch (err: any) {
      logger.debug({ orderHash, err: err.message }, 'Could not query on-chain Seaport order status');
      return false;
    }
  }

  /**
   * Query on-chain native ETH balance of trading signer on the target network
   */
  public async getNativeBalance(networkKey?: string): Promise<number> {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    if (!networkInfo) return 0;
    try {
      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo.rpcUrl);
      const bal = await provider.getBalance(this.signer.address);
      return parseFloat(ethers.formatEther(bal));
    } catch (err: any) {
      logger.debug({ network: activeNetworkKey, err: err.message }, 'Could not query native ETH balance');
      return 0;
    }
  }

  /**
   * Automatic Post-Sale ETH to WETH Swap Rule:
   * Once an NFT is sold at the floor price, the ETH received must be automatically swapped
   * back into WETH immediately via the canonical WETH deposit() function.
   *
   * @param amountEth Optional specific amount of ETH to wrap. If omitted, wraps all available native ETH above the gas reserve.
   * @param networkKey Target network (defaults to configured network or 'robinhood')
   */
  public async swapEthToWeth(
    amountEth?: number,
    networkKey?: string
  ): Promise<{ success: boolean; verified?: boolean; txHash?: string; amountWrappedEth: number; error?: string }> {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const wethAddress = networkInfo?.wethAddress || this.wethAddress;

    logger.info(
      { network: activeNetworkKey, targetAmountEth: amountEth, wethAddress },
      'AUTOMATIC WETH SWAP: Initiating immediate swap of received ETH into WETH...'
    );

    try {
      // Simulation mode guard
      if (process.env.BOT_MODE === 'SIMULATION') {
        const wrapAmount = amountEth && amountEth > 0 ? amountEth : 0.002;
        const simTxHash = `0xsim_weth_deposit_${Date.now()}`;
        logger.info(
          { network: activeNetworkKey, amountWrappedEth: wrapAmount, txHash: simTxHash },
          `[SIMULATION] ✅ Swapped ${wrapAmount} ETH to WETH successfully`
        );
        return { success: true, verified: true, txHash: simTxHash, amountWrappedEth: wrapAmount };
      }

      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);
      const connectedSigner = this.signer.provider ? this.signer : (this.signer as any).connect(provider);

      // 1. Fetch current on-chain native ETH balance
      const nativeBalWei = await provider.getBalance(this.signer.address);
      const nativeBalEth = parseFloat(ethers.formatEther(nativeBalWei));

      // 2. Determine reserve to keep for network gas
      const minReserveEth = this.config.general.minBalanceReserveEth ?? 0.0001;
      const maxWrappableEth = Math.max(0, nativeBalEth - minReserveEth);

      if (maxWrappableEth <= 0.000005) {
        logger.warn(
          { nativeBalEth, minReserveEth, maxWrappableEth },
          'AUTOMATIC WETH SWAP: Native ETH balance is at or below gas reserve threshold. No ETH available to wrap.'
        );
        return { success: true, amountWrappedEth: 0 };
      }

      // If specific amount requested, wrap min(requested, maxWrappable); otherwise wrap all wrappable ETH
      const amountToWrap = amountEth && amountEth > 0
        ? Math.min(amountEth, maxWrappableEth)
        : maxWrappableEth;

      if (amountToWrap <= 0.000005) {
        logger.debug({ amountToWrap }, 'AUTOMATIC WETH SWAP: Amount to wrap is negligible, skipping transaction.');
        return { success: true, amountWrappedEth: 0 };
      }

      logger.info(
        {
          network: activeNetworkKey,
          amountToWrapEth: amountToWrap,
          nativeBalanceBefore: nativeBalEth,
          reserveRetained: minReserveEth
        },
        `AUTOMATIC WETH SWAP: Executing deposit() to wrap ${amountToWrap} ETH -> WETH...`
      );

      // 3. Execute WETH deposit({ value }) on-chain
      const wethContract = this.getWethContract(wethAddress, connectedSigner);

      // toFixed(12) avoids binary float artifacts (e.g. 0.009 -> 0.008999999999999999) in the wei amount
      const valueWei = ethers.parseEther(amountToWrap.toFixed(12));
      const wethBefore: bigint = await wethContract.balanceOf(this.signer.address);
      const tx = await wethContract.deposit({ value: valueWei });
      logger.info({ txHash: tx.hash }, 'WETH deposit transaction broadcasted. Waiting for confirmation...');
      const receipt = await tx.wait(1);

      // 4. Verify the wrap: receipt must be successful AND the WETH balance must have grown by the wrapped amount
      const wethAfter: bigint = await wethContract.balanceOf(this.signer.address);
      if (!receipt || receipt.status !== 1 || wethAfter - wethBefore < valueWei) {
        const error = `WETH wrap verification failed (status: ${receipt?.status}, WETH delta: ${(wethAfter - wethBefore).toString()} wei, expected: ${valueWei.toString()} wei)`;
        logger.error({ network: activeNetworkKey, txHash: receipt?.hash || tx.hash }, `❌ ${error}`);
        return { success: false, verified: false, txHash: receipt?.hash || tx.hash, amountWrappedEth: 0, error };
      }

      logger.info(
        {
          network: activeNetworkKey,
          amountWrappedEth: amountToWrap,
          txHash: receipt.hash,
          wethAddress
        },
        `✅ AUTOMATIC WETH SWAP COMPLETE: Successfully swapped ${amountToWrap} ETH to WETH immediately!`
      );

      return { success: true, verified: true, txHash: receipt.hash, amountWrappedEth: amountToWrap };
    } catch (err: any) {
      logger.error(
        { network: activeNetworkKey, error: err.message, wethAddress },
        '❌ AUTOMATIC WETH SWAP FAILED: Could not swap received ETH to WETH'
      );
      return { success: false, verified: false, error: err.message, amountWrappedEth: 0 };
    }
  }

  /** WETH contract handle (separate method so it can be stubbed in tests). */
  protected getWethContract(wethAddress: string, runner: any): any {
    return new ethers.Contract(
      wethAddress,
      [
        'function deposit() public payable',
        'function balanceOf(address) view returns (uint256)'
      ],
      runner
    );
  }

  /** Cache of recent sale identifiers/hashes that have already undergone post-sale conversion. */
  private processedSaleConversions: Map<string, { timestamp: number; result: any }> = new Map();

  /**
   * Automatic Post-Sale ETH to WETH Conversion Rule:
   * After every NFT sale is confirmed, the bot must combine the newly received ETH with the existing
   * ETH balance, then automatically swap 90% of the total available ETH capital into WETH, retaining
   * the remaining 10% in ETH for gas fees.
   * This process must repeat after every successful NFT sale, using the updated total ETH balance each time.
   *
   * @param receivedEth The net ETH proceeds received from the NFT sale
   * @param networkKey Target network (defaults to configured network or 'robinhood')
   * @param saleIdentifier Optional unique sale txHash or identifier to deduplicate triggers
   */
  public async handlePostSaleEthConversion(
    receivedEth: number,
    networkKey?: string,
    saleIdentifier?: string
  ): Promise<{
    success: boolean;
    verified: boolean;
    txHash?: string;
    amountWrappedEth: number;
    gasReserveRetainedEth: number;
    error?: string;
  }> {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const convertPercent = this.config.general.postSaleWethConvertPercent ?? 90.0;
    const gasReservePercent = this.config.general.postSaleGasReservePercent ?? 10.0;

    // Deduplication check: prevent duplicate conversion if both WebSocket stream and wallet reconciliation fire
    if (saleIdentifier) {
      const existing = this.processedSaleConversions.get(saleIdentifier.toLowerCase());
      if (existing && Date.now() - existing.timestamp < 3600000) {
        logger.info(
          { saleIdentifier, network: activeNetworkKey },
          'POST-SALE CONVERSION: Sale already processed and converted. Skipping duplicate wrap.'
        );
        return existing.result;
      }
    }

    // Determine total available ETH capital by combining newly received ETH with existing ETH balance
    let totalEthCapital = receivedEth;
    if (process.env.BOT_MODE !== 'SIMULATION') {
      try {
        const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);
        const nativeBalWei = await provider.getBalance(this.signer.address);
        const onChainBalEth = parseFloat(ethers.formatEther(nativeBalWei));
        // The on-chain native balance reflects the updated total ETH balance in the wallet
        if (onChainBalEth > 0) {
          totalEthCapital = Math.max(onChainBalEth, receivedEth);
        }
      } catch (err: any) {
        logger.warn(
          { network: activeNetworkKey, err: err.message },
          'POST-SALE CONVERSION: Could not read on-chain native balance for total capital; using received proceeds'
        );
      }
    }

    // Convert 90% of total available ETH capital into WETH, retain remaining 10% in ETH for gas fees
    const amountToWrap = roundToPrecision((totalEthCapital * convertPercent) / 100, 6);
    const gasReserveRetained = roundToPrecision(totalEthCapital - amountToWrap, 6);

    logger.info(
      {
        network: activeNetworkKey,
        saleReceivedEth: receivedEth,
        totalEthCapital,
        convertPercent: `${convertPercent}%`,
        amountToWrapEth: amountToWrap,
        gasReservePercent: `${gasReservePercent}%`,
        gasReserveRetainedEth: gasReserveRetained
      },
      `POST-SALE CONVERSION: Combining received ETH with existing balance (total ${totalEthCapital} ETH). Automatically swapping ${convertPercent}% (${amountToWrap} ETH) into WETH and retaining ${gasReservePercent}% (${gasReserveRetained} ETH) as gas fee reserve.`
    );

    if (amountToWrap <= 0.000005) {
      logger.warn(
        { amountToWrap, totalEthCapital, receivedEth },
        'POST-SALE CONVERSION: Amount to wrap is below dust threshold. Skipping swap.'
      );
      const res = {
        success: true,
        verified: true,
        amountWrappedEth: 0,
        gasReserveRetainedEth: gasReserveRetained
      };
      if (saleIdentifier) {
        this.processedSaleConversions.set(saleIdentifier.toLowerCase(), { timestamp: Date.now(), result: res });
      }
      return res;
    }

    const swapRes = await this.swapEthToWeth(amountToWrap, activeNetworkKey);
    // The full 90% must actually be wrapped and verified; a partial wrap (e.g. capped by low balance) is a failure
    const fullyWrapped = Math.abs(swapRes.amountWrappedEth - amountToWrap) < 0.0000005;
    const verified = swapRes.success && swapRes.verified === true && fullyWrapped;
    if (!verified) {
      logger.error(
        { amountToWrap, amountWrappedEth: swapRes.amountWrappedEth, error: swapRes.error },
        'POST-SALE CONVERSION FAILED ❌: 90% WETH wrap was not completed and verified.'
      );
    }
    // Refresh deposit baseline so the next deposit-sync cycle does not re-wrap sale proceeds / gas reserve
    await this.refreshNativeEthBaseline(activeNetworkKey);

    const result = {
      success: verified,
      verified,
      txHash: swapRes.txHash,
      amountWrappedEth: swapRes.amountWrappedEth,
      gasReserveRetainedEth: gasReserveRetained,
      error: swapRes.error || (verified ? undefined : `Wrapped ${swapRes.amountWrappedEth} ETH of required ${amountToWrap} ETH`)
    };
    if (saleIdentifier) {
      this.processedSaleConversions.set(saleIdentifier.toLowerCase(), { timestamp: Date.now(), result });
    }
    return result;
  }

  /** Updates the per-network native ETH baseline used by deposit detection (best-effort). */
  private async refreshNativeEthBaseline(networkKey: string): Promise<void> {
    try {
      if (process.env.BOT_MODE === 'SIMULATION') return;
      const networkInfo = this.config.networks?.[networkKey];
      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);
      const bal = await provider.getBalance(this.signer.address);
      this.lastKnownNativeEth[networkKey] = parseFloat(ethers.formatEther(bal));
    } catch {
      // non-fatal — next sync cycle will re-read
    }
  }

  /** Last observed native ETH balance per network — used to detect fresh deposits. */
  private lastKnownNativeEth: Record<string, number> = {};

  /**
   * Automatic ETH Deposit → WETH Conversion Rule:
   * When ETH is deposited into the wallet, automatically convert 90% to WETH and hold 10% as gas reserve.
   * Protects the 10% native ETH gas reserve so it is never treated as an unwrapped deposit.
   * Post-sale conversion remains handled separately by handlePostSaleEthConversion.
   */
  public async syncNativeEthAndWrapDeposits(networkKey?: string): Promise<{
    success: boolean;
    verified?: boolean;
    txHash?: string;
    amountWrappedEth: number;
    gasReserveRetainedEth: number;
    depositedEth?: number;
    error?: string;
  }> {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const minReserveEth = this.config.general.minBalanceReserveEth ?? 0.0001;
    // Treat balances above this as an unwrapped deposit that should be converted (not just gas dust)
    const catchUpThresholdEth = Math.max(minReserveEth * 5, 0.001);

    try {
      if (process.env.BOT_MODE === 'SIMULATION') {
        return { success: true, verified: true, amountWrappedEth: 0, gasReserveRetainedEth: 0 };
      }

      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);
      const nativeBalWei = await provider.getBalance(this.signer.address);
      const nativeBalEth = parseFloat(ethers.formatEther(nativeBalWei));
      const wethBalEth = await this.getWethBalance(activeNetworkKey);

      // Total ETH capital (native + WETH)
      const totalCapitalEth = nativeBalEth + wethBalEth;
      const gasReservePercent = this.config.general.postSaleGasReservePercent ?? 10.0;
      const tenPercentReserve = (totalCapitalEth * gasReservePercent) / 100;
      const gasReserve = Math.max(minReserveEth, tenPercentReserve);

      // If native ETH is at or below the 10% gas reserve requirement, NEVER convert it!
      if (nativeBalEth <= gasReserve + 0.00005) {
        this.lastKnownNativeEth[activeNetworkKey] = nativeBalEth;
        return { success: true, verified: true, amountWrappedEth: 0, gasReserveRetainedEth: nativeBalEth, depositedEth: 0 };
      }

      const last = this.lastKnownNativeEth[activeNetworkKey];

      let amountToConvert = 0;
      if (last === undefined) {
        // First observation: convert sizable unwrapped ETH in excess of the gas reserve
        if (nativeBalEth >= catchUpThresholdEth && nativeBalEth > gasReserve) {
          amountToConvert = nativeBalEth - gasReserve;
          logger.info(
            { network: activeNetworkKey, nativeBalEth, gasReserve, amountToConvert },
            'DEPOSIT WETH SYNC: Unwrapped ETH detected on startup above gas reserve — converting 90% to WETH...'
          );
        }
      } else if (nativeBalEth > last + 0.00001 && nativeBalEth > gasReserve) {
        amountToConvert = Math.min(nativeBalEth - last, nativeBalEth - gasReserve);
        logger.info(
          { network: activeNetworkKey, depositedEth: amountToConvert, previousBal: last, currentBal: nativeBalEth },
          'DEPOSIT DETECTED: Automatically converting 90% of deposited ETH into WETH (10% held for gas reserve)...'
        );
      }

      if (amountToConvert <= 0.000005) {
        this.lastKnownNativeEth[activeNetworkKey] = nativeBalEth;
        return { success: true, verified: true, amountWrappedEth: 0, gasReserveRetainedEth: 0, depositedEth: 0 };
      }

      const conversion = await this.handlePostSaleEthConversion(amountToConvert, activeNetworkKey);
      // Refresh baseline after wrap (and any gas spent)
      const afterWei = await provider.getBalance(this.signer.address);
      this.lastKnownNativeEth[activeNetworkKey] = parseFloat(ethers.formatEther(afterWei));
      return {
        ...conversion,
        depositedEth: amountToConvert
      };
    } catch (err: any) {
      logger.error({ network: activeNetworkKey, error: err.message }, 'DEPOSIT WETH SYNC FAILED ❌');
      return {
        success: false,
        verified: false,
        amountWrappedEth: 0,
        gasReserveRetainedEth: 0,
        error: err.message
      };
    }
  }

  /**
   * Auto-rebalance / wrap available native ETH when WETH balance is insufficient for a bid.
   * Protects the 10% gas fee reserve from being wrapped into WETH.
   */
  public async autoWrapAvailableEthIfDeficit(
    requiredWeth: number,
    networkKey?: string
  ): Promise<{ success: boolean; amountWrappedEth: number; txHash?: string }> {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];

    try {
      if (process.env.BOT_MODE === 'SIMULATION') {
        return { success: true, amountWrappedEth: 0 };
      }

      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);
      const nativeBalWei = await provider.getBalance(this.signer.address);
      const nativeBalEth = parseFloat(ethers.formatEther(nativeBalWei));
      const wethBalEth = await this.getWethBalance(activeNetworkKey);

      const totalCapitalEth = nativeBalEth + wethBalEth;
      const gasReservePercent = this.config.general.postSaleGasReservePercent ?? 10.0;
      const minGasReserve = this.config.general.minBalanceReserveEth ?? 0.0001;

      // The 10% gas reserve belongs to the total capital (ETH + WETH).
      // Native ETH held as the 10% gas reserve must NEVER be wrapped to fund bids.
      const tenPercentReserve = (totalCapitalEth * gasReservePercent) / 100;
      const gasReserve = Math.max(minGasReserve, tenPercentReserve);

      const wrappableEth = Math.max(0, nativeBalEth - gasReserve);
      if (wrappableEth <= 0.00005) {
        logger.debug(
          { network: activeNetworkKey, nativeBalEth, gasReserve, wrappableEth },
          'AUTO-REBALANCE: Native ETH is at or below the 10% gas reserve. Retaining for gas fees, skipping wrap.'
        );
        return { success: true, amountWrappedEth: 0 };
      }

      const convertPercent = this.config.general.postSaleWethConvertPercent ?? 90.0;
      const amountToWrap = roundToPrecision(Math.min(wrappableEth, (wrappableEth * convertPercent) / 100), 6);
      if (amountToWrap <= 0.00005) {
        return { success: true, amountWrappedEth: 0 };
      }

      logger.info(
        {
          network: activeNetworkKey,
          nativeBalEth,
          gasReserveRetainedEth: gasReserve,
          amountToWrapEth: amountToWrap,
          requiredWeth
        },
        'AUTO-REBALANCE: Excess native ETH detected above 10% gas reserve. Wrapping into WETH...'
      );

      return await this.swapEthToWeth(amountToWrap, activeNetworkKey);
    } catch (err: any) {
      logger.error({ err: err.message, network: activeNetworkKey }, 'Failed to auto-wrap native ETH');
      return { success: false, amountWrappedEth: 0 };
    }
  }

  /**
   * Automatic 100% USDG to WETH Post-Sale Swap Rule:
   * When an NFT purchased through a USDG offer is sold at the floor price and the sale is confirmed,
   * the bot must automatically swap 100% of the USDG proceeds into WETH.
   *
   * @param amountUsdg Exact or total amount of USDG proceeds to swap into WETH
   * @param networkKey Target network
   */
  public async swapUsdgToWeth(
    amountUsdg: number,
    networkKey?: string
  ): Promise<{ success: boolean; verified?: boolean; txHash?: string; amountSwappedUsdg: number; amountReceivedWeth?: number; error?: string }> {
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const usdgAddress = networkInfo?.usdgAddress || '0x595a8910ba11e38ada602430b8b1122644247b0c';
    const wethAddress = networkInfo?.wethAddress || this.wethAddress;
    const dexRouterAddress = networkInfo?.dexRouterAddress || '0xE592427A0AEce92De3Edee1F18E0157C05861564';
    const usdgDecimals = networkInfo?.usdgDecimals || 6;

    logger.info(
      {
        network: activeNetworkKey,
        amountUsdg,
        usdgAddress,
        wethAddress,
        dexRouterAddress
      },
      `AUTOMATIC USDG->WETH SWAP: Swapping 100% (${amountUsdg} USDG) of sale proceeds into WETH...`
    );

    if (amountUsdg <= 0.001) {
      logger.warn({ amountUsdg }, 'AUTOMATIC USDG->WETH SWAP: Amount is below dust threshold. Skipping swap.');
      return { success: true, verified: true, amountSwappedUsdg: 0 };
    }

    try {
      // Simulation mode guard
      if (process.env.BOT_MODE === 'SIMULATION') {
        const simTxHash = `0xsim_usdg_to_weth_${Date.now()}`;
        const simWethReceived = amountUsdg / 2500;
        logger.info(
          { network: activeNetworkKey, amountSwappedUsdg: amountUsdg, amountReceivedWeth: simWethReceived, txHash: simTxHash },
          `[SIMULATION] ✅ Swapped 100% (${amountUsdg} USDG) to WETH successfully`
        );
        return {
          success: true,
          verified: true,
          txHash: simTxHash,
          amountSwappedUsdg: amountUsdg,
          amountReceivedWeth: simWethReceived
        };
      }

      const provider = this.signer.provider || new ethers.JsonRpcProvider(networkInfo?.rpcUrl);
      const connectedSigner = this.signer.provider ? this.signer : (this.signer as any).connect(provider);

      const usdgContract = new ethers.Contract(
        usdgAddress,
        [
          'function balanceOf(address account) view returns (uint256)',
          'function allowance(address owner, address spender) view returns (uint256)',
          'function approve(address spender, uint256 amount) returns (bool)'
        ],
        connectedSigner
      );

      const balanceWei: bigint = await usdgContract.balanceOf(this.signer.address);
      const amountInWei = ethers.parseUnits(amountUsdg.toFixed(usdgDecimals), usdgDecimals);
      const swapWei = balanceWei < amountInWei ? balanceWei : amountInWei;

      if (swapWei <= 0n) {
        logger.warn('AUTOMATIC USDG->WETH SWAP: Wallet USDG balance is 0. Skipping swap.');
        return { success: true, verified: true, amountSwappedUsdg: 0 };
      }

      // Check allowance & approve DEX Router
      const allowance: bigint = await usdgContract.allowance(this.signer.address, dexRouterAddress);
      if (allowance < swapWei) {
        logger.info({ dexRouterAddress }, 'Approving DEX Router to spend USDG...');
        const approveTx = await usdgContract.approve(dexRouterAddress, ethers.MaxUint256);
        await approveTx.wait(1);
      }

      // Execute Swap: Uniswap V2 / V3 compatible SwapRouter
      const routerContract = new ethers.Contract(
        dexRouterAddress,
        [
          'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
          'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
        ],
        connectedSigner
      );

      const deadline = Math.floor(Date.now() / 1000) + 600;
      let tx: any;
      try {
        tx = await routerContract.exactInputSingle({
          tokenIn: usdgAddress,
          tokenOut: wethAddress,
          fee: 3000,
          recipient: this.signer.address,
          deadline,
          amountIn: swapWei,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0
        });
      } catch {
        tx = await routerContract.swapExactTokensForTokens(
          swapWei,
          0,
          [usdgAddress, wethAddress],
          this.signer.address,
          deadline
        );
      }

      const receipt = await tx.wait(1);
      const swappedUsdg = parseFloat(ethers.formatUnits(swapWei, usdgDecimals));
      logger.info(
        { network: activeNetworkKey, amountSwappedUsdg: swappedUsdg, txHash: receipt.hash },
        `✅ AUTOMATIC USDG->WETH SWAP COMPLETE: Swapped 100% (${swappedUsdg} USDG) to WETH!`
      );

      return {
        success: true,
        verified: true,
        txHash: receipt.hash,
        amountSwappedUsdg: swappedUsdg
      };
    } catch (err: any) {
      logger.error(
        { network: activeNetworkKey, error: err.message, amountUsdg },
        '❌ AUTOMATIC USDG->WETH SWAP FAILED: Could not swap USDG to WETH'
      );
      return {
        success: false,
        verified: false,
        amountSwappedUsdg: 0,
        error: err.message
      };
    }
  }
}

