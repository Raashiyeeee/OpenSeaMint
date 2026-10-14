import { BotConfig, InventoryItem } from '../types';
import { OpenSeaApiService } from '../services/OpenSeaApiService';
import { PricingEngine } from '../services/PricingEngine';
import { SeaportService } from '../services/SeaportService';
import { InventoryManager } from '../services/InventoryManager';
import { CircuitBreaker } from '../security/CircuitBreaker';
import { logger } from '../utils/logger';
import { runHighPriority } from '../utils/OpenSeaRateLimiter';

export type ListingAttemptResult = { outcome: 'LISTED' | 'HOLD' | 'UNAVAILABLE' | 'SKIPPED' | 'ERROR'; reason: string };

export class AutoRelisterStrategy {
  private config: BotConfig;
  private apiService: OpenSeaApiService;
  private pricingEngine: PricingEngine;
  private seaportService: SeaportService;
  private inventoryManager: InventoryManager;
  private circuitBreaker: CircuitBreaker;
  /** Called when one of our offers fills on a collection (cancel all other offers there). */
  private collectionFillHandler?: (collectionSlug: string, contractAddress: string) => Promise<void>;
  /** NFTs with a listing attempt in progress (dedupes stream + order-status + wallet-scan detections). */
  private listingInFlight = new Set<string>();
  /** Retry delays for the instant-listing path (not the 15s cycle / 10-min reprice cooldown). */
  public static readonly HOLD_RETRY_MS = 20_000;
  public static readonly UNAVAILABLE_RETRY_MS = 5_000;

  constructor(
    config: BotConfig,
    apiService: OpenSeaApiService,
    pricingEngine: PricingEngine,
    seaportService: SeaportService,
    inventoryManager: InventoryManager,
    circuitBreaker: CircuitBreaker
  ) {
    this.config = config;
    this.apiService = apiService;
    this.pricingEngine = pricingEngine;
    this.seaportService = seaportService;
    this.inventoryManager = inventoryManager;
    this.circuitBreaker = circuitBreaker;
  }

  public setCollectionFillHandler(handler: (collectionSlug: string, contractAddress: string) => Promise<void>): void {
    this.collectionFillHandler = handler;
  }

  /**
   * SINGLE ENTRY POINT for every purchase detection (stream item_sold/item_transferred, our order FULFILLED,
   * wallet scan). Idempotent. Records the NFT at the price of OUR offer that filled, cancels every other offer
   * of ours on that collection, then lists immediately (high priority, fresh data, no cooldown/cache).
   */
  public async onPurchaseDetected(p: {
    collectionSlug: string;
    contractAddress: string;
    tokenId: string;
    network?: string;
    orderHash?: string;
    eventPriceEth?: number;
    source: string;
  }): Promise<ListingAttemptResult> {
    const identifier = `${p.contractAddress.toLowerCase()}:${p.tokenId}`;
    const existing = this.inventoryManager.getInventoryItem(identifier);
    if (existing && existing.status !== 'SOLD' && existing.status !== 'TRANSFERRED') {
      if (existing.status === 'LISTED') return { outcome: 'LISTED', reason: 'already listed' };
      return this.attemptListing(existing, p.source);
    }

    const offer = this.inventoryManager.findOfferForPurchase(p.collectionSlug, p.contractAddress, p.tokenId, p.orderHash);
    let acquiredPriceEth = offer?.priceEth ?? 0;
    let costBasisNote = offer ? `our offer ${offer.orderHash}` : '';
    if (!(acquiredPriceEth > 0) && p.eventPriceEth && p.eventPriceEth > 0) {
      acquiredPriceEth = p.eventPriceEth;
      costBasisNote = 'sale event price';
    }
    if (offer) this.inventoryManager.markOfferFulfilled(offer.orderHash);

    const item: InventoryItem = {
      identifier,
      collectionSlug: p.collectionSlug || offer?.collectionSlug || '',
      contractAddress: p.contractAddress,
      tokenId: p.tokenId,
      network: p.network || offer?.network,
      acquiredPriceEth,
      acquiredPriceUsd: offer?.priceUsd,
      acquiredAtTimestamp: Date.now(),
      status: 'PENDING_LISTING',
      isExternalWalletItem: !offer
    };
    if (offer) this.inventoryManager.consumeFulfilledOffer(p.contractAddress, p.tokenId);
    this.inventoryManager.addInventoryItem(item);
    logger.info(
      { identifier, slug: item.collectionSlug, source: p.source, acquiredPriceEth, costBasis: costBasisNote || 'UNKNOWN' },
      `PURCHASE DETECTED (${p.source}): ${item.collectionSlug} #${p.tokenId}. Listing immediately.`
    );

    // Our offer filled -> cancel EVERY other live offer of ours on this collection now (verified)
    if (this.collectionFillHandler) {
      try {
        await runHighPriority(() => this.collectionFillHandler!(item.collectionSlug, item.contractAddress));
      } catch (err: any) {
        logger.error({ slug: item.collectionSlug, err: err.message }, 'Failed to cancel remaining offers after fill (will retry via cancellation pass)');
      }
    }
    return this.attemptListing(item, p.source);
  }

  /**
   * Instant listing attempt with fresh data at high limiter priority. On HOLD / data unavailable, schedules a quick
   * retry (processPendingListings) instead of waiting for the main cycle. Logs the reason every time.
   */
  public async attemptListing(item: InventoryItem, source: string = 'retry'): Promise<ListingAttemptResult> {
    if (this.listingInFlight.has(item.identifier)) return { outcome: 'SKIPPED', reason: 'listing already in progress' };
    this.listingInFlight.add(item.identifier);
    const started = Date.now();
    try {
      const res = await runHighPriority(() => this.relistItem(item));
      const now = Date.now();
      if (res.outcome === 'LISTED') {
        item.nextListingAttemptAt = undefined;
        logger.info({ identifier: item.identifier, source, latencyMs: now - item.acquiredAtTimestamp, attemptMs: now - started }, 'INSTANT LISTING ✅');
      } else if (res.outcome === 'HOLD' || res.outcome === 'UNAVAILABLE' || res.outcome === 'ERROR') {
        const delay = res.outcome === 'HOLD' ? AutoRelisterStrategy.HOLD_RETRY_MS : AutoRelisterStrategy.UNAVAILABLE_RETRY_MS;
        item.nextListingAttemptAt = now + delay;
        logger.warn(
          { identifier: item.identifier, slug: item.collectionSlug, tokenId: item.tokenId, outcome: res.outcome, reason: res.reason, retryInMs: delay },
          `NOT LISTED (${res.outcome}): ${item.collectionSlug} #${item.tokenId} — ${res.reason}. Retrying in ${Math.round(delay / 1000)}s.`
        );
      }
      return res;
    } catch (err: any) {
      item.nextListingAttemptAt = Date.now() + AutoRelisterStrategy.UNAVAILABLE_RETRY_MS;
      logger.error({ identifier: item.identifier, err: err.message }, `NOT LISTED (ERROR): ${err.message}. Retrying soon.`);
      return { outcome: 'ERROR', reason: err.message };
    } finally {
      this.listingInFlight.delete(item.identifier);
    }
  }

  /**
   * Finds NFTs of a collection in our wallet that we don't track yet (e.g. after our offer's order turned
   * FULFILLED) and runs the purchase path for each. Returns how many were found.
   */
  public async detectNewHoldings(walletAddress: string, collectionSlug: string, network: string, source: string): Promise<number> {
    const owned = await runHighPriority(() => this.apiService.getAccountNfts(walletAddress, collectionSlug, network));
    if (!owned) return 0;
    let found = 0;
    for (const nft of owned) {
      if (!nft.contract || !nft.identifier) continue;
      const existing = this.inventoryManager.getInventoryItem(`${nft.contract.toLowerCase()}:${nft.identifier}`);
      if (existing && existing.status !== 'SOLD' && existing.status !== 'TRANSFERRED') continue;
      found++;
      await this.onPurchaseDetected({ collectionSlug: nft.collection || collectionSlug, contractAddress: nft.contract, tokenId: String(nft.identifier), network, source });
    }
    return found;
  }

  /** Fast path (every ~2s, independent of the main cycle): retries due PENDING_LISTING / HOLDING items. */
  public async processPendingListings(now: number = Date.now()): Promise<void> {
    const due = this.inventoryManager
      .getAllInventory()
      .filter((i) => (i.status === 'PENDING_LISTING' || i.status === 'HOLDING') && (i.nextListingAttemptAt === undefined || i.nextListingAttemptAt <= now));
    for (const item of due) {
      await this.attemptListing(item, 'retry');
    }
  }

  /**
   * Called immediately when a new NFT is received in the trading wallet
   */
  public async handleItemAcquired(
    collectionSlug: string,
    contractAddress: string,
    tokenId: string,
    acquiredPriceEth: number,
    network?: string
  ): Promise<void> {
    await this.onPurchaseDetected({ collectionSlug, contractAddress, tokenId, network, eventPriceEth: acquiredPriceEth, source: 'acquired' });
  }

  /**
   * Scans unlisted inventory and creates competitive listing orders
   */
  public async scanAndRelistUnlistedInventory(walletAddress: string): Promise<void> {
    // 1. Reconcile on-chain wallet inventory directly from OpenSea across all active networks
    const activeNetworks = this.config.general.activeNetworks || ['robinhood'];
    const allOwnedNfts: any[] = [];
    const ethPriceUsd = await this.apiService.getEthPriceUsd();
    // If holdings could not be fully read on ANY network, ownership is unknown: skip reconciliation this cycle
    let holdingsComplete = true;
    const discovered: Array<{ collectionSlug: string; contractAddress: string; tokenId: string; network: string }> = [];

    for (const net of activeNetworks) {
      try {
        const ownedNfts = await this.apiService.getAccountNfts(walletAddress, undefined, net);
        if (ownedNfts === null) {
          holdingsComplete = false;
          logger.warn({ net }, 'Wallet holdings unavailable on this network. Skipping sale/transfer reconciliation this cycle.');
          continue;
        }
        for (const nft of ownedNfts) {
          allOwnedNfts.push(nft);
          const contractAddress = nft.contract;
          const tokenId = nft.identifier;
          const slug = nft.collection || '';
          if (!contractAddress || !tokenId) continue;

          const identifier = `${contractAddress.toLowerCase()}:${tokenId}`;
          const ignored = this.config.general.ignoredCollections || ['robin-owls', 'robin-owls-269031093'];
          if (ignored.some((i) => slug.toLowerCase().includes(i.toLowerCase()) || contractAddress.toLowerCase().includes(i.toLowerCase()))) {
            continue;
          }

          const existing = this.inventoryManager.getInventoryItem(identifier);
          if (!existing) {
            discovered.push({ collectionSlug: slug, contractAddress, tokenId, network: net });
          } else if (existing.status === 'HOLDING' && existing.acquiredPriceEth >= 0.003 && net === 'robinhood') {
            // Sanitize previously corrupted fallback prices
            const matchingOffer = this.inventoryManager.getActiveOffer(slug);
            if (matchingOffer && matchingOffer.priceEth > 0) {
              existing.acquiredPriceEth = matchingOffer.priceEth;
              existing.status = 'PENDING_LISTING';
            }
          }
        }
      } catch (err: any) {
        logger.debug({ net, err: err.message }, 'Wallet NFT scan note');
      }
    }

    // Reconcile wallet holdings: an NFT that left the wallet is treated as SOLD only when a confirmed sale event
    // (seller = our wallet) exists. Plain transfers keep the re-offer block and never trigger a WETH wrap.
    const soldItems: Array<{ identifier: string; network?: string; netProceedsEth: number; soldEth: number }> = [];
    if (holdingsComplete) {
      const missing = this.inventoryManager.getItemsMissingFromWallet(allOwnedNfts);
      const confirmedSales = new Map<string, { salePriceEth: number; txHash?: string }>();
      const stillUnknown: Array<{ contract: string; identifier: string }> = [];
      for (const item of missing) {
        const sale = await this.apiService.getConfirmedNftSale(
          item.contractAddress,
          item.tokenId,
          walletAddress,
          item.network || this.config.general.network || 'robinhood',
          item.acquiredAtTimestamp ? item.acquiredAtTimestamp / 1000 : undefined
        );
        if (sale === undefined) {
          // Could not check: treat as still owned this cycle (neither sold nor transferred)
          stillUnknown.push({ contract: item.contractAddress, identifier: item.tokenId });
        } else if (sale) {
          confirmedSales.set(item.identifier.toLowerCase(), { salePriceEth: sale.salePriceEth, txHash: sale.txHash });
        }
      }
      soldItems.push(...this.inventoryManager.reconcileWalletInventory([...allOwnedNfts, ...stillUnknown], ethPriceUsd, confirmedSales));
    }
    for (const sold of soldItems) {
      const net = sold.network || this.config.general.network || 'robinhood';
      logger.info(
        { identifier: sold.identifier, network: net, netProceedsEth: sold.netProceedsEth },
        'NFT SALE CONFIRMED (RECONCILIATION): Automatically converting 90% of received ETH into WETH (10% held for gas reserve)...'
      );
      try {
        await this.seaportService.handlePostSaleEthConversion(sold.netProceedsEth, net);
      } catch (err: any) {
        logger.error({ identifier: sold.identifier, err: err.message }, 'Failed to convert received ETH to WETH');
      }
    }

    // 1.5 NFTs found in the wallet that we don't track yet -> same purchase path as stream / order-status detection
    for (const d of discovered) {
      await this.onPurchaseDetected({ ...d, source: 'wallet-scan' });
    }

    // 2. Retry listing of unlisted / held items that are due (same fast path as the 2s listing loop)
    await this.processPendingListings();

    // 3. Continuous competitive monitoring of our ACTIVE listings
    await this.monitorListedInventory();
  }

  /** Minimum time between two price updates of the same listing (anti relist churn). */
  private getRepriceCooldownMs(): number {
    return (this.config.general.relistCooldownMinutes ?? 10) * 60 * 1000;
  }

  /** Minimum relative price change that justifies a relist (anti churn). */
  private static readonly MIN_REPRICE_CHANGE_PERCENT = 0.2;

  /**
   * Rule E — Competitive listing monitor. For every LISTED item:
   *  - if a competitor lists below us, relist just under them, but ONLY if that price still yields the 40% net
   *    margin after all fees (incl. the applicable creator fee);
   *  - if matching them is not profitable, HOLD: keep the existing listing (always >= the 40%-margin price, so never
   *    a loss) and keep monitoring; we reprice to the top position as soon as it is profitable again;
   *  - reprices are rate-limited (cooldown + minimum price change). Listings/cancels are off-chain (no gas).
   */
  public async monitorListedInventory(): Promise<void> {
    const listed = this.inventoryManager.getAllInventory().filter((i) => i.status === 'LISTED');
    if (listed.length === 0) return;
    const ourAddress = this.seaportService.getWalletAddress();
    for (const item of listed) {
      try {
        const ourPrice = item.currentListingPriceEth;
        if (!ourPrice || ourPrice <= 0) continue;
        if (item.lastListingUpdateAt && Date.now() - item.lastListingUpdateAt < this.getRepriceCooldownMs()) continue;
        const competitor = await this.apiService.getLowestCompetingListing(item.collectionSlug, ourAddress);
        if (competitor === undefined || competitor === null) continue; // unknown or no competition: we are top
        if (competitor.priceEth >= ourPrice) continue; // already lowest
        const dropPercent = ((ourPrice - competitor.priceEth) / ourPrice) * 100;
        if (dropPercent < AutoRelisterStrategy.MIN_REPRICE_CHANGE_PERCENT) continue;
        await this.relistItem(item, competitor.priceEth);
      } catch (err: any) {
        logger.error({ identifier: item.identifier, error: err.message }, 'Error during competitive listing monitor');
      }
    }
  }

  private async relistItem(item: InventoryItem, knownCompetitorEth?: number): Promise<ListingAttemptResult> {
    const ignored = this.config.general.ignoredCollections || ['robin-owls', 'robin-owls-269031093'];
    if (ignored.some((i) => item.collectionSlug.toLowerCase().includes(i.toLowerCase()) || item.contractAddress.toLowerCase().includes(i.toLowerCase()))) {
      item.status = 'ERROR';
      item.holdReason = 'Skipped: Collection configured in ignoredCollections';
      logger.info({ identifier: item.identifier, slug: item.collectionSlug }, 'Skipping excluded collection from relisting');
      return { outcome: 'SKIPPED', reason: item.holdReason };
    }

    // 1. Listing context: fees + lowest COMPETING listing, fetched fresh (never the offer pipeline's cached /
    //    staged market data, whose mint-out / sales SKIPPED paths have nothing to do with selling what we own)
    const networkKey = item.network || this.config.general.network || 'robinhood';
    const ctx = await this.apiService.getListingContext(item.collectionSlug, this.seaportService.getWalletAddress());
    if (ctx.unavailableReason) {
      return { outcome: 'UNAVAILABLE', reason: `market data unavailable (${ctx.unavailableReason})` };
    }
    if (!(item.acquiredPriceEth > 0)) {
      const reason = 'purchase price (cost basis) unknown: refusing to price a listing that could sell at a loss';
      this.inventoryManager.updateHoldStatus(item.identifier, reason);
      return { outcome: 'HOLD', reason };
    }
    const wasListed = item.status === 'LISTED' && !!item.listingOrderId;
    const competitorEth = knownCompetitorEth ?? (ctx.competitorEth ?? undefined);
    const marketData = { openseaFeeBps: ctx.openseaFeeBps, royaltyFeeBps: ctx.royaltyFeeBps, ethPriceUsd: ctx.ethPriceUsd, fees: ctx.fees };

    // 2. Find target collection configuration if exists
    const targetConfig = this.config.targetCollections.find(
      (c) => c.slug.toLowerCase() === item.collectionSlug.toLowerCase()
    );
    const targetProfitUsd = targetConfig?.targetNetProfitUsd || this.config.profitTargets.defaultMinNetProfitUsd;

    // 3. Price at the top competitive position that still meets the 40% net margin; HOLD only if impossible
    const listingEval = this.pricingEngine.evaluateListingOrHold(
      item.acquiredPriceEth,
      competitorEth ?? 0,
      {
        openseaFeeBps: marketData.openseaFeeBps,
        royaltyFeeBps: marketData.royaltyFeeBps,
        ethPriceUsd: marketData.ethPriceUsd
      },
      targetProfitUsd,
      networkKey,
      competitorEth
    );

    if (listingEval.action === 'HOLD') {
      const usd = (eth?: number) => (eth !== undefined ? `${eth.toFixed(6)} ETH ($${(eth * marketData.ethPriceUsd).toFixed(2)})` : 'n/a');
      const reason =
        `market below profitable price: lowest competing listing ${usd(competitorEth)} vs minimum 40%-margin price ` +
        `${usd(listingEval.minProfitablePriceEth)} for cost ${usd(item.acquiredPriceEth)} ` +
        `(fees: marketplace ${marketData.openseaFeeBps} bps, creator ${marketData.royaltyFeeBps} bps)`;
      if (wasListed) {
        // Keep the existing listing: it is already priced at/above the 40%-margin price (never a loss).
        item.holdReason = `Competitor below profitable price; keeping current listing at ${item.currentListingPriceEth} ETH. ${reason}`;
        item.lastListingUpdateAt = Date.now();
        logger.warn({ identifier: item.identifier, reason }, 'Undercut not profitable: holding current listing (no loss sale)');
        return { outcome: 'SKIPPED', reason: item.holdReason };
      }
      this.inventoryManager.updateHoldStatus(item.identifier, reason);
      return { outcome: 'HOLD', reason };
    }

    const listPriceEth = listingEval.recommendedListPriceEth!;
    if (wasListed && item.currentListingPriceEth && listPriceEth >= item.currentListingPriceEth) {
      return { outcome: 'SKIPPED', reason: 'no price improvement' }; // avoid churn
    }
    const expectedNetProfitUsd = listingEval.expectedNetProfitUsd!;

    logger.info(
      {
        identifier: item.identifier,
        acquiredPriceEth: item.acquiredPriceEth,
        listPriceEth,
        expectedNetProfitUsd,
        minProfitablePriceEth: listingEval.minProfitablePriceEth
      },
      'Market supports profitable sale: Listing NFT on OpenSea'
    );

    const chainSlug = OpenSeaApiService.toOpenSeaChain(networkKey);

    // 3.5. Ensure on-chain ERC721 conduit approval is active
    await this.seaportService.ensureNftConduitApproval(item.contractAddress, chainSlug);

    // 4. Create and sign Seaport listing (off-chain EIP-712 with required fee recipients)
    const { orderComponents, signature } = await this.seaportService.createSignedListing(
      item.contractAddress,
      item.tokenId,
      listPriceEth,
      marketData.openseaFeeBps,
      this.config.general.listingExpirationDays,
      chainSlug,
      marketData.fees
    );

    // 4.5. Mandatory Creator Fee Disable Rule:
    // If the creator fee is optional and can be disabled, the bot must disable it before executing any NFT sale.
    // The bot must verify that the fee is disabled before proceeding with the sale.
    const preSaleFeeVerification = this.seaportService.verifyCreatorFeeDisabledBeforeSale(
      orderComponents.consideration,
      marketData.fees
    );
    if (!preSaleFeeVerification.verified) {
      logger.error(
        { identifier: item.identifier, reason: preSaleFeeVerification.reason },
        'MANDATORY CREATOR FEE DISABLE RULE: Aborting NFT sale execution because optional creator fee is not disabled!'
      );
      throw new Error(`NFT sale execution aborted: ${preSaleFeeVerification.reason}`);
    }

    // 5. Submit listing order to OpenSea
    const postPayload = {
      parameters: orderComponents,
      signature,
      protocol_address: this.config.seaport.contractAddress
    };

    try {
      // Reprice: cancel our previous (higher) listing so only one listing is live
      if (wasListed && item.listingOrderId && !item.listingOrderId.startsWith('sim_')) {
        const cancel = await this.apiService.cancelOffer(item.listingOrderId, networkKey);
        if (!cancel.success) {
          logger.warn({ identifier: item.identifier, error: cancel.error }, 'Previous listing cancel failed; new lower listing still takes priority');
        }
      }
      const res = await this.apiService.postListing(chainSlug, postPayload);
      item.lastListingUpdateAt = Date.now();

      // 6. Update inventory tracking
      const listPriceUsd = listPriceEth * (marketData.ethPriceUsd || 2700);
      this.inventoryManager.updateListingStatus(
        item.identifier,
        listPriceEth,
        res?.order_hash || `sim_list_${Date.now()}`,
        listPriceUsd
      );

      this.circuitBreaker.registerSuccess();
      return { outcome: 'LISTED', reason: `listed at ${listPriceEth} ETH` };
    } catch (err: any) {
      if (err.message?.includes('enforcement restrictions')) {
        item.status = 'ERROR';
        item.holdReason = 'Listing restricted by OpenSea (enforcement restrictions)';
        logger.warn(
          { identifier: item.identifier, slug: item.collectionSlug, error: err.message },
          'OpenSea has active enforcement restrictions on this collection. Item marked as ERROR and excluded from relist queue.'
        );
        return { outcome: 'SKIPPED', reason: item.holdReason };
      }
      // Any other rejection (incl. generic "Validation error") is NOT permanent: retried quickly with the reason logged.
      // Previously it marked the NFT ERROR and it was never listed again.
      return { outcome: 'ERROR', reason: `listing post rejected: ${err.message}` };
    }
  }
}
