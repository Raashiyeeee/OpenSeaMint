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
}

export interface CapitalConfig {
  totalTradingCapitalUsd: number; // e.g. $10.0
  maxActiveTrades: number;        // e.g. 1 (One active trade at a time)
  minNetProfitUsd: number;        // e.g. $0.20
  maxBuyPriceUsd?: number;        // Strict ceiling: maximum $3.00 buy price
}

export interface LiquidityConfig {
  minSales3Hours: number;           // Minimum 20 sales in last 3 hours
  minUniqueWallets3Hours: number;    // Minimum 5 unique wallets in last 3 hours
  minFloorMultiplier?: number;      // Floor must be >= 1.40 * Offer
  floorRangeMinPercent?: number;    // Floor sales range min (e.g. 80%)
  floorRangeMaxPercent?: number;    // Floor sales range max (e.g. 135%)
  minSales24Hours?: number;
  minSales1Hour?: number;           // Backward compatibility
  minUniqueWallets1Hour?: number;   // Backward compatibility
}

export interface BotConfig {
  general: {
    network?: 'robinhood' | 'mainnet' | 'base' | 'polygon' | 'sepolia';
    activeNetworks: string[];
    currency: string;
    minBalanceReserveEth: number;
    maxTotalActiveOfferVolumeEth: number;
    loopIntervalMs: number;
    offerExpirationMinutes: number;
    listingExpirationDays: number;
    ignoredCollections?: string[];
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
    defaultMinMarginPercent: number; // 13% default
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
  sales1Hour?: number;
  uniqueWallets1Hour?: number;
  sales3Hours?: number;
  uniqueWallets3Hours?: number;
  sales24Hours?: number;
  floorSalesCount?: number;
  liquidityPassed: boolean;
  liquidityReason?: string;
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
  netProfitEth: number;
  netProfitUsd: number;
  marginPercent: number;
  sales1Hour?: number;
  uniqueWallets1Hour?: number;
  sales3Hours?: number;
  uniqueWallets3Hours?: number;
  checkLLiquidityPassed: boolean;
  checkFFloorRatioPassed: boolean;
  checkACapitalPassed: boolean;
  checkBProfitPassed: boolean;
  isProfitable: boolean;
  decision: 'ACCEPT' | 'REJECT';
  reason?: string;
}

export interface InventoryItem {
  identifier: string; // collection:tokenId
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
  status: 'PENDING_LISTING' | 'LISTED' | 'HOLDING' | 'SOLD' | 'ERROR';
  holdReason?: string;
  salePriceEth?: number;
  salePriceUsd?: number;
  realizedProfitEth?: number;
  realizedProfitUsd?: number;
  isExternalWalletItem?: boolean;
}

export interface ActiveOffer {
  orderHash: string;
  collectionSlug: string;
  contractAddress: string;
  network?: string;
  priceEth: number;
  priceUsd: number;
  createdTimestamp: number;
  expiresTimestamp: number;
  status: 'ACTIVE' | 'EXPIRED' | 'FULFILLED' | 'CANCELLED';
}
