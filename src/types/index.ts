export interface NetworkInfo {
  name: string;
  rpcUrl: string;
  chainId: number;
  currency: string;
  blockExplorer: string;
  estimatedGasCostUsd: number;
  seaportAddress?: string;
  conduitKey?: string;
  wethAddress?: string;
  usdgAddress?: string;
  usdgDecimals?: number;
  dexRouterAddress?: string;
}

export interface CapitalConfig {
  totalTradingCapitalUsd: number; // e.g. $10.0
  maxActiveTrades?: number;       // e.g. 999 (Unlimited by count, constrained by capital)
  minNetProfitUsd: number;        // e.g. $0.20
  minOfferPriceUsd?: number;      // Strict floor: minimum $1.00 offer price per NFT
  maxBuyPriceUsd?: number;        // Strict ceiling / monitor max: maximum $9.00 NFT price
  maxOfferCapitalPercent?: number; // e.g. 70.0 (Max share of total capital committed to offers + purchased NFTs; capped at 70%, 30% reserved)
}

export interface LiquidityConfig {
  minSales3Hours: number;           // Minimum 10 completed floor sales in last 3 hours in native ETH (WETH & offers excluded)
  minUniqueWallets3Hours: number;    // Minimum 5 unique wallets in last 3 hours
  minFloorMultiplier?: number;      // Floor must be >= 1.30 * Offer (30% higher)
  floorRangeMinPercent?: number;    // Floor sales range min (e.g. 80%)
  floorRangeMaxPercent?: number;    // Floor sales range max (e.g. 135%)
  minSales24Hours?: number;
  minSales1Hour?: number;           // Backward compatibility
  minUniqueWallets1Hour?: number;   // Backward compatibility
}

export interface BotConfig {
  opensea?: {
    requestsPerSecond?: number;
    maxConcurrent?: number;
    maxRetries?: number;
    baseRetryDelayMs?: number;
    maxRetryDelayMs?: number;
    cacheTtlMs?: { collection?: number; stats?: number; offers?: number; salesEvents?: number; mintComplete?: number; mintIncomplete?: number };
  };
  general: {
    network?: 'robinhood' | 'mainnet' | 'base' | 'polygon' | 'sepolia';
    activeNetworks: string[];
    currency: string;
    minBalanceReserveEth: number;
    maxTotalActiveOfferVolumeEth: number;
    loopIntervalMs: number;
    offerExpirationMinutes: number;
    listingExpirationDays: number;
    relistCooldownMinutes?: number; // min minutes between competitive reprices (default 0.25 = ~15s for near-continuous top priority)
    ignoredCollections?: string[];
    postSaleWethConvertPercent?: number;
    postSaleGasReservePercent?: number;
  };
  capital: CapitalConfig;
  liquidity: LiquidityConfig;
  networks: Record<string, NetworkInfo>;
  fees: {
    openseaFeeBps: number; // 50 bps = 0.5%, 250 bps = 2.5%
    defaultRoyaltyBps: number;
    maxAcceptableRoyaltyBps: number;
  };
  profitTargets: {
    defaultMinNetProfitUsd: number;
    defaultMinMarginPercent: number; // 12% default and hard minimum for tier 2
    tier1MaxPriceUsd?: number; // $4.00 ceiling for 30% margin tier
    tier1MinMarginPercent?: number; // 30% minimum margin for $1 to $4 NFTs
    tier2MinMarginPercent?: number; // 12% minimum margin after creator fee for >$4-$9 NFTs
    undercutFloorByPercent: number;
    bidUnderFloorPercent: number;
    bidIncrementUsd?: number;
  };
  riskManagement: {
    maxInventoryPerCollection: number;
    maxTotalInventoryItems: number;
    floorPriceDropThresholdPercent: number;
    maxConsecutiveErrors: number;
    emergencyStopOnLargeDrawdown: boolean;
    maxAllowedFloorDeclinePercent?: number; // e.g. 40.0% decline ceiling
    extremeFloorDeclinePercent?: number;    // e.g. 90.0% - 99.0% permanent exclusion
  };
  targetCollections: TargetCollectionConfig[];
  seaport: {
    version: string;
    contractAddress: string;
    conduitKey: string;
    zoneAddress: string;
  };
}

export interface FeeRecipient {
  fee: number;
  recipient: string;
  required?: boolean;
  disabled?: boolean;
}

export interface TargetCollectionConfig {
  name: string;
  slug: string;
  contractAddress: string;
  network?: string;
  enabled: boolean;
  maxBidEth: number;
  targetNetProfitUsd: number;
  maxInventory: number;
  floorPriceMultiple?: number;
  minMarginPercent?: number;
  minSales24Hours?: number;
  singleTokenBids?: boolean;
}

export interface CollectionMarketData {
  slug: string;
  contractAddress: string;
  floorPriceEth: number;
  topOfferEth: number;
  numListings: number;
  openseaFeeBps: number;
  royaltyFeeBps: number;
  ethPriceUsd: number;
  timestamp: number;
  fees?: FeeRecipient[];
  mandatoryRoyaltyFeeBps?: number;
  optionalRoyaltyFeeBps?: number;
  creatorFeeDisabled?: boolean;
  sales1Hour?: number;
  uniqueWallets1Hour?: number;
  sales3Hours?: number;
  uniqueWallets3Hours?: number;
  sales24Hours?: number;
  floorSalesCount?: number;
  liquidityPassed: boolean;
  liquidityReason?: string;
  // Mint & Market Dump Protection
  isMinting?: boolean;
  mintCompleted?: boolean;
  mintStatusVerified?: boolean;
  totalSupply?: number;
  maxSupply?: number;
  mintDemandPassed?: boolean;
  mintDemandReason?: string;
  /** Data could not be fetched (rate limit / API error after retries): skip this cycle, never offer. */
  dataUnavailable?: boolean;
  dataUnavailableReason?: string;
  /** Rejected by a cheap check (mint-out / creator fee) before expensive fetches; sales were not fetched. */
  earlyRejectReason?: string;
  /** Lowest COMPETING listing (excludes our own listings). */
  listingFloorEth?: number;
  /** Raw OpenSea stats floor (may include our own listings). */
  statsFloorEth?: number;
  referenceFloorEth?: number;
  referenceFloorUsd?: number;
  floorDeclinePercent?: number;
  currency?: 'ETH' | 'USDG';
  floorPriceUsdg?: number;
}

export interface ProfitCalculationResult {
  network?: string;
  bidPriceEth: number;
  bidPriceUsd: number;
  targetListPriceEth: number;
  targetListPriceUsd: number;
  grossProfitEth: number;
  grossProfitUsd: number;
  openseaFeeEth: number;
  openseaFeeUsd: number;
  royaltyFeeEth: number;
  royaltyFeeUsd: number;
  totalFeesEth: number;
  totalFeesUsd: number;
  estimatedGasCostEth: number;
  estimatedGasCostUsd: number;
  expectedSaleRevenueUsd?: number;
  purchasePriceUsd?: number;
  creatorFeeUsd?: number;
  totalCostsUsd?: number;
  netProfitEth: number;
  netProfitUsd: number;
  marginPercent: number;
  currency?: 'ETH' | 'USDG';
  bidPriceUsdg?: number;
  targetListPriceUsdg?: number;
  sales1Hour?: number;
  uniqueWallets1Hour?: number;
  sales3Hours?: number;
  uniqueWallets3Hours?: number;
  checkLLiquidityPassed: boolean;
  checkFFloorRatioPassed: boolean;
  checkACapitalPassed: boolean;
  checkBProfitPassed: boolean;
  checkMintCompletedPassed?: boolean;
  checkMarketDumpPassed?: boolean;
  floorDeclinePercent?: number;
  minAcceptableFloorEth?: number;
  checkMinFloorPassed?: boolean;
  isProfitable: boolean;
  decision: 'ACCEPT' | 'REJECT';
  reason?: string;
}

export type NftOwnershipStatus = 'OWNED' | 'UNRESOLVED' | 'SOLD' | 'NONE';
export type NftListingStatus = 'UNLISTED' | 'PENDING_LISTING' | 'LISTED' | 'HOLDING' | 'SOLD';

export interface NftSaleConfirmation {
  confirmed: boolean;
  soldAtTimestamp: number;
  salePriceEth?: number;
  salePriceUsd?: number;
  realizedProfitUsd?: number;
  transactionHash?: string;
  orderId?: string;
  currency?: 'ETH' | 'USDG';
  salePriceUsdg?: number;
  saleProceedsUsdg?: number;
}

export interface TrackedNft {
  identifier: string; // contract:tokenId
  tokenId: string;
  collectionSlug: string;
  contractAddress: string;
  network?: string;
  name?: string;
  ownershipStatus: NftOwnershipStatus;
  listingStatus: NftListingStatus;
  activeOffers: ActiveOffer[];
  saleConfirmation?: NftSaleConfirmation;
  acquiredPriceEth?: number;
  acquiredPriceUsd?: number;
  acquiredAtTimestamp?: number;
  currentListingPriceEth?: number;
  currentListingPriceUsd?: number;
  listingOrderId?: string;
  holdReason?: string;
  currency?: 'ETH' | 'USDG';
  acquiredPriceUsdg?: number;
}

export interface InventoryItem {
  identifier: string; // contract:tokenId
  collectionSlug: string;
  contractAddress: string;
  network?: string;
  tokenId: string;
  name?: string;
  acquiredPriceEth: number;
  acquiredPriceUsd?: number;
  acquiredAtTimestamp: number;
  currentListingPriceEth?: number;
  currentListingPriceUsd?: number;
  listingOrderId?: string;
  status: 'PENDING_LISTING' | 'LISTED' | 'HOLDING' | 'SOLD' | 'ERROR' | 'TRANSFERRED';
  ownershipStatus?: NftOwnershipStatus;
  listingStatus?: NftListingStatus;
  saleConfirmation?: NftSaleConfirmation;
  holdReason?: string;
  salePriceEth?: number;
  salePriceUsd?: number;
  realizedProfitEth?: number;
  realizedProfitUsd?: number;
  isExternalWalletItem?: boolean;
  lastListingUpdateAt?: number;
  /** Instant-listing retry time (ms) after a HOLD / data-unavailable attempt. */
  nextListingAttemptAt?: number;
  currency?: 'ETH' | 'USDG';
  acquiredPriceUsdg?: number;
  saleProceedsUsdg?: number;
  stopLossTriggeredThresholds?: number[]; // [45, 60, 80]
}

export type OfferStatus = 'ACTIVE' | 'EXPIRED' | 'FULFILLED' | 'CANCELLED' | 'CANCELLATION_PENDING' | 'CANCELLATION_FAILED';

export interface ActiveOffer {
  orderHash: string;
  collectionSlug: string;
  contractAddress: string;
  tokenId?: string;
  network?: string;
  priceEth: number;
  priceUsd: number;
  createdTimestamp: number;
  expiresTimestamp: number;
  status: OfferStatus;
  cancellationAttempts?: number;
  cancellationVerified?: boolean;
  cancellationError?: string;
  currency?: 'ETH' | 'USDG';
  priceUsdg?: number;
  lastCancellationAttempt?: number;
  flaggedForAttention?: boolean;
  fillableUntil?: number; // offchain-cancelled offer may still be filled until this time (ms)
  orderComponents?: any;
  signature?: string;
}

export interface MarkItemSoldResult {
  realizedProfitUsd: number;
  newTotalCapitalUsd: number;
  saleConfirmation: NftSaleConfirmation;
  soldItem?: InventoryItem;
  netProceedsEth: number;
}


export interface OfferCyclePauseState {
  paused: boolean;
  pausedAt?: number;
  purchasedCountAtPause: number;
  soldSincePause: number;
}

export interface MintSupplySources {
  collectionTotalSupply?: number;
  collectionIsMinting?: boolean;
  dropTotalSupply?: number;
  dropMaxSupply?: number;
  dropIsMinting?: boolean;
  onChainTotalSupply?: number;
  onChainMaxSupply?: number;
}
