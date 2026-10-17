import { ethers } from 'ethers';
import { BotConfig } from '../types';
import { logger } from '../utils/logger';
import { KeyManager } from '../security/KeyManager';
import { CircuitBreaker } from '../security/CircuitBreaker';
import { OpenSeaApiService } from '../services/OpenSeaApiService';
import { OpenSeaStreamService } from '../services/OpenSeaStreamService';
import { SeaportService } from '../services/SeaportService';
import { PricingEngine } from '../services/PricingEngine';
import { InventoryManager } from '../services/InventoryManager';
import { CollectionBidderStrategy } from '../strategies/CollectionBidderStrategy';
import { AutoRelisterStrategy } from '../strategies/AutoRelisterStrategy';

export interface WalletWorkerOptions {
  id: string;
  label: string;
  privateKey?: string;
  apiKey?: string;
  statePath: string;
  config: BotConfig;
  providers: Record<string, ethers.JsonRpcProvider>;
}

export class WalletTradingWorker {
  public readonly id: string;
  public readonly label: string;
  private config: BotConfig;
  private providers: Record<string, ethers.JsonRpcProvider>;
  private keyManager: KeyManager;
  private tradingWallet: ethers.Wallet | ethers.HDNodeWallet;
  private circuitBreaker: CircuitBreaker;
  private apiService: OpenSeaApiService;
  private streamService: OpenSeaStreamService;
  private seaportService: SeaportService;
  private pricingEngine: PricingEngine;
  private inventoryManager: InventoryManager;
  private bidderStrategy: CollectionBidderStrategy;
  private relisterStrategy: AutoRelisterStrategy;

  private fastInterval: NodeJS.Timeout | null = null;
  private mainInterval: NodeJS.Timeout | null = null;
  private fastRunning = false;
  private loopRunning = false;
  private initialWalletSyncComplete = false;

  constructor(options: WalletWorkerOptions) {
    this.id = options.id;
    this.label = options.label;
    this.config = options.config;
    this.providers = options.providers;

    const primaryProvider =
      this.providers['robinhood'] ||
      this.providers['mainnet'] ||
      new ethers.JsonRpcProvider(this.config.networks.robinhood.rpcUrl);

    this.keyManager = new KeyManager(primaryProvider, options.privateKey, this.label);
    this.tradingWallet = this.keyManager.getSigner();
    this.circuitBreaker = new CircuitBreaker(this.config);

    this.apiService = new OpenSeaApiService(this.config, options.apiKey);
    this.apiService.setOwnWalletAddress(this.tradingWallet.address);

    this.streamService = new OpenSeaStreamService(this.config, this.tradingWallet.address, options.apiKey);
    this.seaportService = new SeaportService(this.config, this.tradingWallet);
    this.pricingEngine = new PricingEngine(this.config);
    this.inventoryManager = new InventoryManager(this.config, options.statePath);

    this.bidderStrategy = new CollectionBidderStrategy(
      this.config,
      this.apiService,
      this.pricingEngine,
      this.seaportService,
      this.inventoryManager,
      this.circuitBreaker
    );

    this.relisterStrategy = new AutoRelisterStrategy(
      this.config,
      this.apiService,
      this.pricingEngine,
      this.seaportService,
      this.inventoryManager,
      this.circuitBreaker
    );

    this.setupStreamHandlers();
  }

  public getAddress(): string {
    return this.tradingWallet.address;
  }

  public getStatus() {
    return {
      id: this.id,
      label: this.label,
      address: this.tradingWallet.address,
      circuitBreaker: this.circuitBreaker.getStatus(),
      activeOffersCount: this.inventoryManager.getAllActiveOffers().length,
      inventoryCount: this.inventoryManager.getAllInventory().length,
      realizedProfitUsd: this.inventoryManager.getCumulativeProfitUsd()
    };
  }

  private setupStreamHandlers(): void {
    this.relisterStrategy.setCollectionFillHandler(async (slug, contract) => {
      await this.bidderStrategy.cancelAllOffersForCollection(slug, contract, `[${this.label}] Offer filled on this collection`);
      await this.bidderStrategy.cancelUnfundedOffersAfterCapitalChange(`[${this.label}] Insufficient capital after purchase`);
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

    this.streamService.on('nft_received', async (eventData: any) => {
      try {
        const { slug, contract, tokenId, network } = parseNftId(eventData);
        if (!contract || !tokenId) return;
        await this.relisterStrategy.onPurchaseDetected({
          collectionSlug: slug,
          contractAddress: contract,
          tokenId,
          network,
          source: 'stream:item_transferred'
        });
      } catch (err: any) {
        logger.error({ worker: this.label, err }, 'Error processing nft_received event');
      }
    });

    this.streamService.on('nft_trade', async (eventData: any) => {
      try {
        const { slug, contract, tokenId, network } = parseNftId(eventData);
        if (!contract || !tokenId) return;
        const held = this.inventoryManager.getInventoryItem(`${contract.toLowerCase()}:${tokenId}`);
        const isUnsoldHolding = held && ['PENDING_LISTING', 'LISTED', 'HOLDING', 'ERROR'].includes(held.status);
        if (isUnsoldHolding) {
          this.streamService.emit('nft_sold', eventData);
          return;
        }
        const decimals = Number(eventData.payment_token?.decimals ?? 18);
        const tokenEthPrice = parseFloat(eventData.payment_token?.eth_price || '1') || 1;
        const qty = Number(eventData.quantity || 1) || 1;
        const eventPriceEth = eventData.sale_price
          ? (parseFloat(eventData.sale_price) / Math.pow(10, decimals)) * tokenEthPrice / qty
          : undefined;

        await this.relisterStrategy.onPurchaseDetected({
          collectionSlug: slug,
          contractAddress: contract,
          tokenId,
          network,
          orderHash: eventData.order_hash,
          eventPriceEth,
          source: 'stream:item_sold'
        });
      } catch (err: any) {
        logger.error({ worker: this.label, err }, 'Error processing nft_trade event');
      }
    });

    this.streamService.on('nft_sold', async (eventData: any) => {
      try {
        const tokenId = eventData.item?.nft_id?.split('/')?.[2] || '';
        const contract = eventData.item?.nft_id?.split('/')?.[1] || '';
        const identifier = `${contract.toLowerCase()}:${tokenId}`;
        const decimals = Number(eventData.payment_token?.decimals ?? 18);
        const tokenEthPrice = parseFloat(eventData.payment_token?.eth_price || '1') || 1;
        const salePriceEth = eventData.sale_price
          ? (parseFloat(eventData.sale_price) / Math.pow(10, decimals)) * tokenEthPrice
          : 0;
        const txHash: string | undefined = eventData.transaction?.hash;
        const ethPriceUsd = await this.apiService.getEthPriceUsd();
        const gasUsd = this.config.networks['robinhood']?.estimatedGasCostUsd || 0.01;

        const result = this.inventoryManager.markItemSold(
          identifier,
          salePriceEth > 0 ? salePriceEth : undefined,
          ethPriceUsd,
          100,
          gasUsd,
          txHash
        );
        logger.info(
          {
            worker: this.label,
            identifier,
            realizedProfitUsd: result.realizedProfitUsd,
            newBalanceUsd: result.newTotalCapitalUsd,
            netProceedsEth: result.netProceedsEth
          },
          `[${this.label}] NFT ${identifier} sold successfully! Capital released for next trade.`
        );

        const targetNetwork = result.soldItem?.network || this.config.general.network || 'robinhood';
        if (result.soldItem?.currency === 'USDG' || result.saleConfirmation?.currency === 'USDG') {
          const usdgProceeds = result.soldItem?.saleProceedsUsdg || (result.netProceedsEth * ethPriceUsd);
          logger.info(
            { worker: this.label, identifier, targetNetwork, usdgProceeds },
            `[${this.label}] NFT SALE CONFIRMED (USDG TRADE): Automatically swapping 100% of received USDG proceeds into WETH...`
          );
          const swapRes = await this.seaportService.swapUsdgToWeth(usdgProceeds, targetNetwork);
          if (!swapRes.success || !swapRes.verified) {
            logger.error(
              { worker: this.label, identifier, targetNetwork, swapRes },
              `[${this.label}] USDG TO WETH SWAP NOT VERIFIED ❌: Manual review required.`
            );
          }
        } else {
          logger.info(
            { worker: this.label, identifier, targetNetwork, netProceedsEth: result.netProceedsEth },
            `[${this.label}] NFT SALE CONFIRMED: Automatically converting 90% of received ETH into WETH (10% held for gas reserve)...`
          );
          const conversion = await this.seaportService.handlePostSaleEthConversion(
            result.netProceedsEth,
            targetNetwork,
            txHash || identifier
          );
          if (!conversion.success || !conversion.verified) {
            logger.error(
              { worker: this.label, identifier, targetNetwork, conversion },
              `[${this.label}] POST-SALE CONVERSION NOT VERIFIED ❌: WETH wrap did not succeed or could not be verified on-chain. Manual review required.`
            );
          }
        }
      } catch (err: any) {
        logger.error({ worker: this.label, err }, 'Error processing nft_sold event');
      }
    });

    this.streamService.on('offer_received', async () => {
      try {
        await this.bidderStrategy.processOutbidOfferCancellations();
      } catch (err: any) {
        logger.error({ worker: this.label, err: err.message }, 'Error in reactive outbid cancellation handler');
      }
    });
  }

  public async start(): Promise<void> {
    const activeNetworks = this.config.general.activeNetworks || ['robinhood'];

    logger.info(`[${this.label}] Trading Wallet Address: ${this.tradingWallet.address}`);
    logger.info(`[${this.label}] 🔗 Live OpenSea Activity: https://opensea.io/${this.tradingWallet.address}/activity`);
    logger.info(`[${this.label}] 🔗 Live OpenSea Offers:   https://opensea.io/${this.tradingWallet.address}?tab=offers_made`);

    // Verify balances
    for (const netKey of activeNetworks) {
      const p = this.providers[netKey];
      const info = this.config.networks[netKey];
      if (p && info) {
        try {
          const bal = await p.getBalance(this.tradingWallet.address);
          logger.info(`[${this.label}][${info.name}] Balance: ${ethers.formatEther(bal)} ${info.currency}`);
        } catch (err: any) {
          logger.warn(`[${this.label}][${info.name}] Could not query balance: ${err.message}`);
        }
      }
    }

    // Connect WebSocket stream
    this.streamService.connect();

    // Start Fast Loop
    const fastLoop = async () => {
      if (this.fastRunning) return;
      this.fastRunning = true;
      try {
        for (const o of this.inventoryManager.getAllActiveOffers()) this.streamService.subscribeCollection(o.collectionSlug);
        for (const i of this.inventoryManager.getAllInventory()) this.streamService.subscribeCollection(i.collectionSlug);

        await this.bidderStrategy.processAutomaticOfferCancellations(this.bidderStrategy.getOfferMaxAgeMinutes());
        await this.bidderStrategy.processOutbidOfferCancellations();
        await this.relisterStrategy.monitorListedInventory();
        await this.bidderStrategy.checkOffersForFills(async (offer) => {
          await this.relisterStrategy.detectNewHoldings(this.tradingWallet.address, offer.collectionSlug, offer.network || 'robinhood', 'order:FULFILLED');
        });

        for (const o of this.inventoryManager.getAllActiveOffers().filter((x) => x.status === 'FULFILLED')) {
          await this.relisterStrategy.detectNewHoldings(this.tradingWallet.address, o.collectionSlug, o.network || 'robinhood', 'order:FULFILLED');
        }
        await this.relisterStrategy.processPendingListings();
      } catch (err: any) {
        logger.error({ worker: this.label, err: err.message }, 'Error in fast purchase/listing loop');
      } finally {
        this.fastRunning = false;
      }
    };
    this.fastInterval = setInterval(fastLoop, 3000);

    // Start Main Bidding Loop
    const runLoop = async () => {
      if (this.loopRunning) {
        logger.debug(`[${this.label}] Previous strategy cycle still running; skipping this tick`);
        return;
      }
      this.loopRunning = true;
      try {
        for (const netKey of activeNetworks) {
          try {
            await this.seaportService.syncNativeEthAndWrapDeposits(netKey);
          } catch (wrapErr: any) {
            logger.warn({ worker: this.label, network: netKey, err: wrapErr.message }, 'Deposit ETH→WETH sync failed this cycle');
          }
        }

        const syncSuccess = await this.relisterStrategy.scanAndRelistUnlistedInventory(this.tradingWallet.address);
        if (syncSuccess) {
          this.initialWalletSyncComplete = true;
        } else if (!this.initialWalletSyncComplete) {
          logger.warn(`[${this.label}] STARTUP SYNC GATE 🛑: Initial wallet inventory reconciliation failed or was incomplete. Pausing bids.`);
          return;
        }

        await this.bidderStrategy.evaluateAndPlaceBids();
      } catch (err: any) {
        logger.error({ worker: this.label, err }, 'Unhandled error in strategy loop iteration');
      } finally {
        this.loopRunning = false;
      }
    };

    // Immediate first evaluation
    await runLoop();

    // Schedule recurrent loop
    this.mainInterval = setInterval(runLoop, this.config.general.loopIntervalMs);
  }

  public stop(): void {
    logger.info(`[${this.label}] Stopping worker...`);
    if (this.fastInterval) clearInterval(this.fastInterval);
    if (this.mainInterval) clearInterval(this.mainInterval);
    this.streamService.disconnect();
  }
}
