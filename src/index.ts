import http from 'http';
import { ethers } from 'ethers';
import { loadConfig } from './config/schema';
import { logger } from './utils/logger';
import { KeyManager } from './security/KeyManager';
import { CircuitBreaker } from './security/CircuitBreaker';
import { OpenSeaApiService } from './services/OpenSeaApiService';
import { OpenSeaStreamService } from './services/OpenSeaStreamService';
import { SeaportService } from './services/SeaportService';
import { PricingEngine } from './services/PricingEngine';
import { InventoryManager } from './services/InventoryManager';
import { CollectionBidderStrategy } from './strategies/CollectionBidderStrategy';
import { AutoRelisterStrategy } from './strategies/AutoRelisterStrategy';

async function main() {
  logger.info('============================================================');
  logger.info('Starting OpenSea Automated NFT Trading Bot');
  logger.info(`Mode: ${process.env.BOT_MODE || 'SIMULATION'}`);
  logger.info('============================================================');

  // 1. Load configuration
  const config = loadConfig();
  const activeNetworks = config.general.activeNetworks || ['robinhood', 'mainnet'];

  logger.info(`Multi-Chain Mode Active: Monitoring [${activeNetworks.join(', ')}] simultaneously without manual switching`);
  logger.info(`Trading Capital: $${config.capital.totalTradingCapitalUsd.toFixed(2)} (Shared across all chains)`);
  logger.info(`Profit Target: Minimum $${config.capital.minNetProfitUsd.toFixed(2)} Net Profit per trade`);
  logger.info(`Max Active Trades: ${config.capital.maxActiveTrades} (Rule: One active trade at a time)`);

  // 2. Setup RPC providers for all active networks
  const providers: Record<string, ethers.JsonRpcProvider> = {};
  for (const netKey of activeNetworks) {
    const netInfo = config.networks[netKey];
    if (netInfo) {
      providers[netKey] = new ethers.JsonRpcProvider(netInfo.rpcUrl);
    }
  }

  // 3. Initialize KeyManager & Security
  const primaryProvider = providers['robinhood'] || providers['mainnet'] || new ethers.JsonRpcProvider(config.networks.robinhood.rpcUrl);
  const keyManager = new KeyManager(primaryProvider);
  const tradingWallet = keyManager.getSigner();
  const circuitBreaker = new CircuitBreaker(config);

  logger.info(`Trading Wallet Address: ${tradingWallet.address}`);
  logger.info(`🔗 Live OpenSea Profile:      https://opensea.io/007-AA`);
  logger.info(`🔗 Live OpenSea Activity URL: https://opensea.io/007-AA/activity`);
  logger.info(`🔗 Live OpenSea Offers Made:  https://opensea.io/007-AA?tab=offers_made`);
  logger.info(`🔗 Direct Address Activity:   https://opensea.io/${tradingWallet.address}/activity`);

  // 4. Verify balances on all active networks
  for (const netKey of activeNetworks) {
    const p = providers[netKey];
    const info = config.networks[netKey];
    if (p && info) {
      try {
        const bal = await p.getBalance(tradingWallet.address);
        logger.info(`[${info.name}] Chain ID ${info.chainId} Balance: ${ethers.formatEther(bal)} ${info.currency}`);
      } catch (err: any) {
        logger.warn(`[${info.name}] Could not query balance on RPC: ${err.message}`);
      }
    }
  }

  // 4.5. Start lightweight health-check server (Required for free cloud platforms like Render / Koyeb)
  const port = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      bot: 'OpenSea NFT Trading Bot',
      wallet: tradingWallet.address,
      mode: process.env.BOT_MODE || 'LIVE',
      activeNetworks,
      circuitBreaker: circuitBreaker.getStatus(),
      timestamp: new Date().toISOString()
    }));
  });
  server.listen(port, () => {
    logger.info(`Health check dashboard listening on port ${port}`);
  });

  // 5. Initialize core services
  const apiService = new OpenSeaApiService(config);
  const streamService = new OpenSeaStreamService(config, tradingWallet.address);
  const seaportService = new SeaportService(config, tradingWallet);
  const pricingEngine = new PricingEngine(config);
  const inventoryManager = new InventoryManager(config);

  // 6. Initialize strategies
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

  // 7. Setup Real-time Stream Event Handlers
  streamService.on('nft_received', async (eventData: any) => {
    try {
      const slug = eventData.collection?.slug || '';
      const contract = eventData.item?.nft_id?.split('/')?.[1] || '';
      const tokenId = eventData.item?.nft_id?.split('/')?.[2] || '';
      const priceEth = parseFloat(eventData.payment_token?.eth_price || '0.0035');

      logger.info({ slug, tokenId }, 'Incoming transfer received! Triggering automatic relist.');
      await relisterStrategy.handleItemAcquired(slug, contract, tokenId, priceEth);
    } catch (err: any) {
      logger.error({ err }, 'Error processing nft_received event');
    }
  });

  streamService.on('nft_sold', async (eventData: any) => {
    try {
      const tokenId = eventData.item?.nft_id?.split('/')?.[2] || '';
      const contract = eventData.item?.nft_id?.split('/')?.[1] || '';
      const identifier = `${contract.toLowerCase()}:${tokenId}`;
      const salePriceEth = parseFloat(eventData.payment_token?.eth_price || '0');
      const ethPriceUsd = await apiService.getEthPriceUsd();
      const gasUsd = config.networks['robinhood']?.estimatedGasCostUsd || 0.01;

      const result = inventoryManager.markItemSold(
        identifier,
        salePriceEth > 0 ? salePriceEth : undefined,
        ethPriceUsd,
        100,
        gasUsd
      );
      logger.info(
        {
          identifier,
          realizedProfitUsd: result.realizedProfitUsd,
          newBalanceUsd: result.newTotalCapitalUsd
        },
        `NFT ${identifier} sold successfully! Capital released for next trade.`
      );
    } catch (err: any) {
      logger.error({ err }, 'Error processing nft_sold event');
    }
  });

  // Connect WebSocket stream
  streamService.connect();

  // 8. Start Bidding Loop
  logger.info(`Entering main strategy loop (Interval: ${config.general.loopIntervalMs / 1000}s)`);

  const runLoop = async () => {
    try {
      // 1. Reconcile on-chain wallet inventory (clear sold NFTs, list new ones)
      await relisterStrategy.scanAndRelistUnlistedInventory(tradingWallet.address);
      // 2. Evaluate market and place simultaneous offers across qualifying NFTs
      await bidderStrategy.evaluateAndPlaceBids();
    } catch (err: any) {
      logger.error({ err }, 'Unhandled error in strategy loop iteration');
    }
  };

  // Run immediate first evaluation
  await runLoop();

  // Schedule recurrent execution
  const interval = setInterval(runLoop, config.general.loopIntervalMs);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down trading bot gracefully...');
    clearInterval(interval);
    streamService.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup crash');
  process.exit(1);
});
