import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { BotConfig } from '../types';
import { logger } from '../utils/logger';

dotenv.config();

const TargetCollectionSchema = z.object({
  name: z.string(),
  slug: z.string(),
  contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  network: z.string().optional(),
  enabled: z.boolean(),
  maxBidEth: z.number().positive(),
  targetNetProfitUsd: z.number().positive(),
  maxInventory: z.number().int().positive(),
  floorPriceMultiple: z.number().positive().optional(),
  minMarginPercent: z.number().nonnegative().optional(),
  minSales24Hours: z.number().nonnegative().optional(),
  singleTokenBids: z.boolean().optional()
});

const CapitalSchema = z.object({
  totalTradingCapitalUsd: z.number().positive().default(10.0),
  maxActiveTrades: z.number().int().positive().default(999),
  minNetProfitUsd: z.number().nonnegative().default(0.20),
  minOfferPriceUsd: z.number().positive().default(1.00),
  maxBuyPriceUsd: z.number().positive().default(9.0),
  maxOfferCapitalPercent: z.number().positive().max(70).default(70.0)
});

const LiquiditySchema = z.object({
  minSales3Hours: z.number().int().nonnegative().default(10),
  minUniqueWallets3Hours: z.number().int().nonnegative().default(5),
  minFloorMultiplier: z.number().positive().default(1.30),
  floorRangeMinPercent: z.number().nonnegative().default(80.0),
  floorRangeMaxPercent: z.number().nonnegative().default(135.0),
  minSales24Hours: z.number().int().nonnegative().optional(),
  minSales1Hour: z.number().int().nonnegative().optional(),
  minUniqueWallets1Hour: z.number().int().nonnegative().optional()
});

const NetworkInfoSchema = z.object({
  name: z.string(),
  rpcUrl: z.string(),
  chainId: z.number().int().positive(),
  currency: z.string(),
  blockExplorer: z.string(),
  estimatedGasCostUsd: z.number().nonnegative().default(0.01),
  seaportAddress: z.string().optional(),
  conduitKey: z.string().optional(),
  wethAddress: z.string().optional(),
  usdgAddress: z.string().optional(),
  usdgDecimals: z.number().int().positive().default(6).optional(),
  dexRouterAddress: z.string().optional()
});

const OpenSeaApiSchema = z.object({
  requestsPerSecond: z.number().positive().max(20).default(3),
  maxConcurrent: z.number().int().positive().max(10).default(2),
  maxRetries: z.number().int().nonnegative().max(10).default(4),
  baseRetryDelayMs: z.number().int().positive().default(1000),
  maxRetryDelayMs: z.number().int().positive().default(30000),
  cacheTtlMs: z.object({
    collection: z.number().int().nonnegative().default(600000),
    stats: z.number().int().nonnegative().default(60000),
    offers: z.number().int().nonnegative().default(20000),
    salesEvents: z.number().int().nonnegative().default(120000),
    mintComplete: z.number().int().nonnegative().default(21600000),
    mintIncomplete: z.number().int().nonnegative().default(120000)
  }).default({})
});

const BotConfigSchema = z.object({
  opensea: OpenSeaApiSchema.default({}),
  general: z.object({
    network: z.enum(['robinhood', 'mainnet', 'base', 'polygon', 'sepolia']).optional(),
    activeNetworks: z.array(z.string()).default(['robinhood']),
    currency: z.string(),
    minBalanceReserveEth: z.number().nonnegative(),
    maxTotalActiveOfferVolumeEth: z.number().positive(),
    loopIntervalMs: z.number().int().positive(),
    offerExpirationMinutes: z.number().int().positive(),
    listingExpirationDays: z.number().int().positive(),
    relistCooldownMinutes: z.number().nonnegative().default(0.25),
    ignoredCollections: z.array(z.string()).optional(),
    postSaleWethConvertPercent: z.number().positive().max(100).default(90.0),
    postSaleGasReservePercent: z.number().nonnegative().max(100).default(10.0)
  }),
  capital: CapitalSchema,
  liquidity: LiquiditySchema.default({ minSales3Hours: 10, minUniqueWallets3Hours: 5, minFloorMultiplier: 1.30 }),
  networks: z.record(NetworkInfoSchema),
  fees: z.object({
    openseaFeeBps: z.number().nonnegative(),
    defaultRoyaltyBps: z.number().nonnegative(),
    maxAcceptableRoyaltyBps: z.number().nonnegative()
  }),
  profitTargets: z.object({
    defaultMinNetProfitUsd: z.number().positive(),
    defaultMinMarginPercent: z.number().positive().default(12.0),
    tier1MaxPriceUsd: z.number().positive().default(4.0),
    tier1MinMarginPercent: z.number().positive().default(30.0),
    tier2MinMarginPercent: z.number().positive().default(12.0),
    undercutFloorByPercent: z.number().nonnegative(),
    bidUnderFloorPercent: z.number().positive(),
    bidIncrementUsd: z.number().positive().default(0.05)
  }),
  riskManagement: z.object({
    maxInventoryPerCollection: z.number().int().positive(),
    maxTotalInventoryItems: z.number().int().positive(),
    floorPriceDropThresholdPercent: z.number().positive(),
    maxConsecutiveErrors: z.number().int().positive(),
    emergencyStopOnLargeDrawdown: z.boolean(),
    maxAllowedFloorDeclinePercent: z.number().positive().default(40.0),
    extremeFloorDeclinePercent: z.number().positive().default(90.0)
  }),
  targetCollections: z.array(TargetCollectionSchema),
  seaport: z.object({
    version: z.string(),
    contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    conduitKey: z.string(),
    zoneAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/)
  })
});

export function loadConfig(configPath?: string): BotConfig {
  const resolvedPath = configPath || path.resolve(__dirname, '../../config/default.json');
  try {
    const rawData = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(rawData);

    // Environment overrides for RPCs
    if (process.env.ROBINHOOD_RPC_URL && parsed.networks?.robinhood) {
      parsed.networks.robinhood.rpcUrl = process.env.ROBINHOOD_RPC_URL;
    }
    if (process.env.INK_RPC_URL && parsed.networks?.ink) {
      parsed.networks.ink.rpcUrl = process.env.INK_RPC_URL;
    }
    if (process.env.ETHEREUM_RPC_URL && parsed.networks?.mainnet) {
      parsed.networks.mainnet.rpcUrl = process.env.ETHEREUM_RPC_URL;
    }

    if (process.env.ACTIVE_NETWORKS) {
      parsed.general.activeNetworks = process.env.ACTIVE_NETWORKS.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Environment overrides for USDG token address & DEX router
    const usdgOverride = process.env.USDG_TOKEN_ADDRESS || process.env.USDG_ADDRESS;
    const dexRouterOverride = process.env.DEX_ROUTER_ADDRESS || process.env.ROUTER_ADDRESS;
    if (parsed.networks) {
      for (const netKey of Object.keys(parsed.networks)) {
        if (usdgOverride) parsed.networks[netKey].usdgAddress = usdgOverride;
        if (dexRouterOverride) parsed.networks[netKey].dexRouterAddress = dexRouterOverride;
      }
    }

    if (!parsed.general.activeNetworks || parsed.general.activeNetworks.length === 0) {
      parsed.general.activeNetworks = ['robinhood'];
    }

    const validated = BotConfigSchema.parse(parsed);
    return validated as BotConfig;
  } catch (err: any) {
    logger.error({ err }, `Failed to load or validate configuration from ${resolvedPath}`);
    throw new Error(`Configuration error: ${err.message}`);
  }
}
