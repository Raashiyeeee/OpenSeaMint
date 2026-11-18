import { EventEmitter } from 'events';
import { BotConfig } from '../types';
import { OpenSeaApiService } from './OpenSeaApiService';
import { logger } from '../utils/logger';

export interface SpottedCollectionEvent {
  slug: string;
  contractAddress: string;
  network: string;
  sourceWallet: string;
  makerPriceEth?: number;
  eventTimestamp?: number;
}

export class WalletMonitorService extends EventEmitter {
  private config: BotConfig;
  private apiService: OpenSeaApiService;
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;
  private seenCollections: Map<string, number> = new Map(); // key -> lastSeenTimestamp

  constructor(config: BotConfig, apiService: OpenSeaApiService) {
    super();
    this.config = config;
    this.apiService = apiService;
  }

  public start(): void {
    const monitorConfig = this.config.walletMonitor;
    if (!monitorConfig?.enabled) {
      logger.info('Wallet Monitor Service is disabled in configuration.');
      return;
    }

    const wallets = monitorConfig.targetWallets || [];
    if (wallets.length === 0) {
      logger.info('Wallet Monitor Service enabled, but no target wallets configured.');
      return;
    }

    const intervalMs = monitorConfig.pollIntervalMs || 45000;
    logger.info(
      { wallets, intervalMs },
      `Starting Wallet Monitor Service: Watching ${wallets.length} target wallet(s) for live collection offers every ${intervalMs / 1000}s.`
    );

    // Initial check immediately
    this.pollAllWallets().catch((err: any) => {
      logger.debug({ err: err.message }, 'Initial wallet monitor check encountered an error');
    });

    this.pollInterval = setInterval(() => {
      this.pollAllWallets().catch((err: any) => {
        logger.debug({ err: err.message }, 'Scheduled wallet monitor poll encountered an error');
      });
    }, intervalMs);
  }

  public stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      logger.info('Wallet Monitor Service stopped.');
    }
  }

  public async pollAllWallets(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const wallets = this.config.walletMonitor?.targetWallets || [];
      const cooldownMs = this.config.walletMonitor?.seenCollectionCooldownMs || 300000;
      const activeNetworks = this.config.general.activeNetworks || ['robinhood'];

      for (const wallet of wallets) {
        try {
          const res = await this.apiService.client.get(
            `/events/accounts/${wallet}?event_type=collection_offer&limit=50`
          );

          const events = res.data?.asset_events || [];
          if (!Array.isArray(events) || events.length === 0) continue;

          for (const event of events) {
            const criteria = event.criteria;
            const slug = criteria?.collection?.slug;
            const contract = criteria?.contract?.address || '';

            if (!slug) continue;

            // Map API chain to bot network identifier
            const rawChain = (event.chain || 'robinhood').toLowerCase();
            const network = rawChain === 'ethereum' ? 'mainnet' : rawChain;

            // Only monitor networks that our bot is actively trading on
            if (!activeNetworks.includes(network)) continue;

            const key = `${network}:${slug.toLowerCase()}`;
            const lastSeen = this.seenCollections.get(key) || 0;
            const now = Date.now();

            if (now - lastSeen < cooldownMs) {
              continue; // In cooldown, already evaluated recently
            }

            this.seenCollections.set(key, now);

            // Parse offer price in WETH for informational logging
            let makerPriceEth: number | undefined;
            if (event.payment?.quantity && event.payment?.decimals) {
              makerPriceEth = parseFloat(event.payment.quantity) / Math.pow(10, event.payment.decimals);
            }

            logger.info(
              {
                sourceWallet: wallet,
                slug,
                contract,
                network,
                makerPriceEth
              },
              `🎯 [Wallet Monitor] Target wallet placed collection offer on '${slug}' [${network.toUpperCase()}]. Evaluating for mirror bid...`
            );

            const spottedEvent: SpottedCollectionEvent = {
              slug,
              contractAddress: contract,
              network,
              sourceWallet: wallet,
              makerPriceEth,
              eventTimestamp: event.event_timestamp
            };

            this.emit('collection_spotted', spottedEvent);
          }
        } catch (err: any) {
          logger.debug({ wallet, error: err.message }, 'Failed to fetch events for target wallet');
        }
      }
    } finally {
      this.isPolling = false;
    }
  }
}

