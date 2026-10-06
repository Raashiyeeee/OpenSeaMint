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
  minSales1Hour: number;        // Minimum 15 sales in last 1 hour
  minUniqueWallets1Hour: number; // Minimum 4 unique wallets in last 1 hour
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

export interface TargetCollectionConfig {
  name: string;
  slug: string;
  contractAddress: string;
  network?: string;
  enabled: boolean;
  maxBidEth: number;
  targetNetProfitUsd: number;
  maxInventory: number;
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
  sales1Hour: number;
  uniqueWallets1Hour: number;
  liquidityPassed: boolean;
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
  checkLLiquidityPassed: boolean;
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
  status: 'PENDING_LISTING' | 'LISTED' | 'SOLD' | 'ERROR';
  salePriceEth?: number;
  salePriceUsd?: number;
  realizedProfitEth?: number;
  realizedProfitUsd?: number;
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
