import path from 'path';
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
  // Our own listings must never be counted as the market floor
  apiService.setOwnWalletAddress(tradingWallet.address);
  const streamService = new OpenSeaStreamService(config, tradingWallet.address);
  const seaportService = new SeaportService(config, tradingWallet);
  const pricingEngine = new PricingEngine(config);
  // Re-Offer Rule: owned/unsold NFT state and capital pause state persist across restarts
  const inventoryStatePath = process.env.INVENTORY_STATE_PATH || path.resolve(process.cwd(), 'data/inventory-state.json');
  const inventoryManager = new InventoryManager(config, inventoryStatePath);

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
  // When one of our offers fills: cancel remaining offers on that collection, then cancel any
  // other active offers that remaining capital / WETH can no longer fund (verified).
  relisterStrategy.setCollectionFillHandler(async (slug, contract) => {
    await bidderStrategy.cancelAllOffersForCollection(slug, contract, 'Offer filled on this collection');
    await bidderStrategy.cancelUnfundedOffersAfterCapitalChange('Insufficient capital after purchase');
  });

  const parseNftId = (eventData: any) => {
    const parts = String(eventData.item?.nft_id || '').split('/');
    const chainPart = parts[0] || '';
    return {
      slug: eventData.collection?.slug || '',
      contract: parts[1] || '',
      tokenId: parts[2] || '',
      network: chainPart === 'ethereum' ? 'mainnet' : chainPart || undefined
    };
  };

  // PURCHASE PATH (stream): transfer into our wallet -> instant listing
  streamService.on('nft_received', async (eventData: any) => {
    try {
      const { slug, contract, tokenId, network } = parseNftId(eventData);
      if (!contract || !tokenId) return;
      await relisterStrategy.onPurchaseDetected({ collectionSlug: slug, contractAddress: contract, tokenId, network, source: 'stream:item_transferred' });
    } catch (err: any) {
      logger.error({ err }, 'Error processing nft_received event');
    }
  });

  // item_sold involving our wallet: purchase (we don't hold it unsold) or sale (we do)
  streamService.on('nft_trade', async (eventData: any) => {
    try {
      const { slug, contract, tokenId, network } = parseNftId(eventData);
      if (!contract || !tokenId) return;
      const held = inventoryManager.getInventoryItem(`${contract.toLowerCase()}:${tokenId}`);
      const isUnsoldHolding = held && ['PENDING_LISTING', 'LISTED', 'HOLDING', 'ERROR'].includes(held.status);
      if (isUnsoldHolding) {
        streamService.emit('nft_sold', eventData);
        return;
      }
      const decimals = Number(eventData.payment_token?.decimals ?? 18);
      const tokenEthPrice = parseFloat(eventData.payment_token?.eth_price || '1') || 1;
      const qty = Number(eventData.quantity || 1) || 1;
      const eventPriceEth = eventData.sale_price ? (parseFloat(eventData.sale_price) / Math.pow(10, decimals)) * tokenEthPrice / qty : undefined;
      await relisterStrategy.onPurchaseDetected({
        collectionSlug: slug, contractAddress: contract, tokenId, network,
        orderHash: eventData.order_hash, eventPriceEth, source: 'stream:item_sold'
      });
    } catch (err: any) {
      logger.error({ err }, 'Error processing nft_trade event');
    }
  });

  streamService.on('nft_sold', async (eventData: any) => {
    try {
      const tokenId = eventData.item?.nft_id?.split('/')?.[2] || '';
      const contract = eventData.item?.nft_id?.split('/')?.[1] || '';
      const identifier = `${contract.toLowerCase()}:${tokenId}`;
      // Stream item_sold: sale_price is the total in the payment token's base units; convert to ETH via
      // payment_token.decimals and payment_token.eth_price (1 for ETH).
      const decimals = Number(eventData.payment_token?.decimals ?? 18);
      const tokenEthPrice = parseFloat(eventData.payment_token?.eth_price || '1') || 1;
      const salePriceEth = eventData.sale_price
        ? (parseFloat(eventData.sale_price) / Math.pow(10, decimals)) * tokenEthPrice
        : 0;
      const txHash: string | undefined = eventData.transaction?.hash;
      const ethPriceUsd = await apiService.getEthPriceUsd();
      const gasUsd = config.networks['robinhood']?.estimatedGasCostUsd || 0.01;

      const result = inventoryManager.markItemSold(
        identifier,
        salePriceEth > 0 ? salePriceEth : undefined,
        ethPriceUsd,
        100,
        gasUsd,
        txHash
      );
      logger.info(
        {
          identifier,
          realizedProfitUsd: result.realizedProfitUsd,
          newBalanceUsd: result.newTotalCapitalUsd,
          netProceedsEth: result.netProceedsEth
        },
        `NFT ${identifier} sold successfully! Capital released for next trade.`
      );

      // POST-SALE AUTOMATIC SWAP RULE:
      // If the NFT was purchased through a USDG offer, 100% of the USDG proceeds must be automatically swapped to WETH.
      // If the NFT was purchased with ETH/WETH, convert 90% of ETH into WETH (10% held for gas reserve).
      const targetNetwork = result.soldItem?.network || config.general.network || 'robinhood';
      if (result.soldItem?.currency === 'USDG' || result.saleConfirmation?.currency === 'USDG') {
        const usdgProceeds = result.soldItem?.saleProceedsUsdg || (result.netProceedsEth * ethPriceUsd);
        logger.info(
          { identifier, targetNetwork, usdgProceeds },
          'NFT SALE CONFIRMED (USDG TRADE): Automatically swapping 100% of received USDG proceeds into WETH...'
        );
        const swapRes = await seaportService.swapUsdgToWeth(usdgProceeds, targetNetwork);
        if (!swapRes.success || !swapRes.verified) {
          logger.error(
            { identifier, targetNetwork, swapRes },
            'USDG TO WETH SWAP NOT VERIFIED ❌: Manual review required.'
          );
        }
      } else {
        logger.info(
          { identifier, targetNetwork, netProceedsEth: result.netProceedsEth },
          'NFT SALE CONFIRMED: Automatically converting 90% of received ETH into WETH (10% held for gas reserve)...'
        );
        const conversion = await seaportService.handlePostSaleEthConversion(result.netProceedsEth, targetNetwork);
        if (!conversion.success || !conversion.verified) {
          logger.error(
            { identifier, targetNetwork, conversion },
            'POST-SALE CONVERSION NOT VERIFIED ❌: WETH wrap did not succeed or could not be verified on-chain. Manual review required.'
          );
        }
      }
    } catch (err: any) {
      logger.error({ err }, 'Error processing nft_sold event');
    }
  });

  // Connect WebSocket stream
  streamService.connect();

  // FAST LOOP (every 3s, independent of the long main cycle and its caches):
  //  - Cancel When Outbid + 20-Minute Expiry (must not wait for the slow bidding cycle)
  //  - Continuous top-priority listing monitor (reprice when a competitor undercuts, if still profitable)
  //  - subscribe the stream to every collection we have offers on or hold NFTs from
  //  - poll our live offers' order status; FULFILLED -> find the token in the wallet -> list immediately
  //  - retry due PENDING_LISTING / HOLDING NFTs (HOLD retried every 20s, data-unavailable every 5s)
  let fastRunning = false;
  const fastLoop = async () => {
    if (fastRunning) return;
    fastRunning = true;
    try {
      for (const o of inventoryManager.getAllActiveOffers()) streamService.subscribeCollection(o.collectionSlug);
      for (const i of inventoryManager.getAllInventory()) streamService.subscribeCollection(i.collectionSlug);
      // Outbid → Cancel and 20-min expiry run continuously (re-entry criteria checked in the main bidding cycle)
      await bidderStrategy.processAutomaticOfferCancellations(bidderStrategy.getOfferMaxAgeMinutes());
      await bidderStrategy.processOutbidOfferCancellations();
      // Top selling priority: continuously undercut competitors when the new price still meets margin
      await relisterStrategy.monitorListedInventory();
      await bidderStrategy.checkOffersForFills(async (offer) => {
        await relisterStrategy.detectNewHoldings(tradingWallet.address, offer.collectionSlug, offer.network || 'robinhood', 'order:FULFILLED');
      });
      // FULFILLED offers whose NFT hasn't been matched yet (e.g. detected during cancellation verification)
      for (const o of inventoryManager.getAllActiveOffers().filter((x) => x.status === 'FULFILLED')) {
        await relisterStrategy.detectNewHoldings(tradingWallet.address, o.collectionSlug, o.network || 'robinhood', 'order:FULFILLED');
      }
      await relisterStrategy.processPendingListings();
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error in fast purchase/listing loop');
    } finally {
      fastRunning = false;
    }
  };
  const fastInterval = setInterval(fastLoop, 3000);

  // 8. Start Bidding Loop
  logger.info(`Entering main strategy loop (Interval: ${config.general.loopIntervalMs / 1000}s)`);

  // Startup Sync Gate: fail-closed safety. Bidding cycle cannot place offers until wallet inventory is verified
  let initialWalletSyncComplete = false;
  let loopRunning = false;
  const runLoop = async () => {
    if (loopRunning) {
      logger.debug('Previous strategy cycle still running; skipping this tick');
      return;
    }
    loopRunning = true;
    try {
      // 0. Deposit → WETH: if ETH was deposited (or is sitting unwrapped), convert 90% to WETH (10% gas reserve)
      for (const netKey of activeNetworks) {
        try {
          await seaportService.syncNativeEthAndWrapDeposits(netKey);
        } catch (wrapErr: any) {
          logger.warn({ network: netKey, err: wrapErr.message }, 'Deposit ETH→WETH sync failed this cycle');
        }
      }
      // 1. Reconcile on-chain wallet inventory (clear sold NFTs, list new ones)
      const syncSuccess = await relisterStrategy.scanAndRelistUnlistedInventory(tradingWallet.address);
      if (syncSuccess) {
        initialWalletSyncComplete = true;
      } else if (!initialWalletSyncComplete) {
        logger.warn('STARTUP SYNC GATE 🛑: Initial wallet inventory reconciliation failed or was incomplete. Bidding cycle paused until wallet holdings are verified.');
        return;
      }
      // 2. Evaluate market and place simultaneous offers across qualifying NFTs
      await bidderStrategy.evaluateAndPlaceBids();
    } catch (err: any) {
      logger.error({ err }, 'Unhandled error in strategy loop iteration');
    } finally {
      loopRunning = false;
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
    clearInterval(fastInterval);
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
