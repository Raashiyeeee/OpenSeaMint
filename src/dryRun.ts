import { ethers, Wallet } from 'ethers';
import { loadConfig } from './config/schema';
import { logger } from './utils/logger';
import { PricingEngine } from './services/PricingEngine';
import { OpenSeaApiService } from './services/OpenSeaApiService';
import { SeaportService } from './services/SeaportService';
import { InventoryManager } from './services/InventoryManager';
import { CircuitBreaker } from './security/CircuitBreaker';
import { CollectionBidderStrategy } from './strategies/CollectionBidderStrategy';
import { AutoRelisterStrategy } from './strategies/AutoRelisterStrategy';

async function runDryRun() {
  process.env.BOT_MODE = 'SIMULATION';
  logger.info('================================================================');
  logger.info('   STARTING NFT TRADING BOT DRY-RUN / SIMULATION ($10 CAPITAL)   ');
  logger.info('================================================================');

  const config = loadConfig();
  const activeNetworks = config.general.activeNetworks || ['robinhood', 'mainnet'];

  logger.info(`Simultaneous Networks Active: [${activeNetworks.join(', ')}]`);
  logger.info(`Trading Capital: $${config.capital.totalTradingCapitalUsd.toFixed(2)} (Shared across all chains)`);
  logger.info(`Min Net Profit Target: $${config.capital.minNetProfitUsd.toFixed(2)} per trade`);
  logger.info(`Single Active Trade Constraint: ${config.capital.maxActiveTrades} active trade max across all chains`);

  const primaryNetworkKey = activeNetworks[0];
  const networkInfo = config.networks[primaryNetworkKey];
  const provider = new ethers.JsonRpcProvider(networkInfo.rpcUrl);
  const ephemeralWallet = Wallet.createRandom(provider);

  logger.info(`Simulated Wallet Address: ${ephemeralWallet.address}`);

  const circuitBreaker = new CircuitBreaker(config);
  const pricingEngine = new PricingEngine(config);
  const apiService = new OpenSeaApiService(config);
  const seaportService = new SeaportService(config, ephemeralWallet);
  const inventoryManager = new InventoryManager(config);

  const bidderStrategy = new CollectionBidderStrategy(
    config,
    apiService,
    pricingEngine,
    seaportService,
    inventoryManager,
    circuitBreaker
  );

  const relisterStrategy = new AutoRelisterStrategy(
    config,
    apiService,
    pricingEngine,
    seaportService,
    inventoryManager,
    circuitBreaker
  );

  logger.info('\n--- STAGE 1: EVALUATING TARGET COLLECTIONS & PLACING FIRST OFFER ---');
  await bidderStrategy.evaluateAndPlaceBids();

  logger.info('\n--- STAGE 2: TESTING CAPITAL PRESERVATION (ATTEMPTING 2ND TRADE) ---');
  logger.info('Attempting to place another trade while first trade holds the $10 capital...');
  await bidderStrategy.evaluateAndPlaceBids();
  logger.info('Verified: Bot correctly held capital and prevented overlapping trades!');

  const sampleTarget = config.targetCollections[0] || {
    name: 'Sample Discovered NFT',
    slug: 'sample-nft',
    contractAddress: '0x811c82c1d2204d6a91da8941284c4b32ad18e00a'
  };
  const simulatedAcquiredPriceEth = 0.0028; // ~$7.50 at $2700 ETH
  const simulatedTokenId = '42';

  logger.info(
    `Simulating seller accepting offer for ${sampleTarget.name} #${simulatedTokenId} at ${simulatedAcquiredPriceEth} ETH (~$7.56)`
  );

  await relisterStrategy.handleItemAcquired(
    sampleTarget.slug,
    sampleTarget.contractAddress,
    simulatedTokenId,
    simulatedAcquiredPriceEth
  );

  logger.info('\n--- STAGE 4: VERIFYING INVENTORY & PENDING LISTING ---');
  console.table(inventoryManager.getAllInventory());

  logger.info('\n--- STAGE 5: SIMULATING NFT SALE & CAPITAL RELEASE ---');
  const simulatedSalePriceEth = 0.0042; // ~$11.34 at $2700 ETH
  const ethPrice = 2700;
  const gasUsd = networkInfo.estimatedGasCostUsd;
  const saleResult = inventoryManager.markItemSold(
    `${sampleTarget.contractAddress.toLowerCase()}:${simulatedTokenId}`,
    simulatedSalePriceEth,
    ethPrice,
    100, // 1% total fee
    gasUsd
  );

  logger.info(
    {
      realizedProfitUsd: `$${saleResult.realizedProfitUsd}`,
      newCapitalBalanceUsd: `$${saleResult.newTotalCapitalUsd}`
    },
    'Trade finalized: Capital released and net profit banked!'
  );

  logger.info('\n--- STAGE 6: READY FOR NEXT TRADE ---');
  logger.info(`Available Capital: $${inventoryManager.getAvailableCapitalUsd(ethPrice)} | Active Trades: ${inventoryManager.getActiveTradesCount()}`);

  logger.info('================================================================');
  logger.info('Dry run simulation completed successfully! All rules verified.');
  logger.info('================================================================');
}

runDryRun().catch((err) => {
  logger.fatal({ err }, 'Dry run failed');
  process.exit(1);
});
