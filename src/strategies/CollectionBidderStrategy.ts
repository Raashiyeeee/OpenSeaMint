import { BotConfig, ActiveOffer, CollectionMarketData, FeeRecipient } from '../types';
import { OpenSeaApiService } from '../services/OpenSeaApiService';
import { PricingEngine } from '../services/PricingEngine';
import { SeaportService } from '../services/SeaportService';
import { InventoryManager } from '../services/InventoryManager';
import { CircuitBreaker } from '../security/CircuitBreaker';
import { logger } from '../utils/logger';
import { roundToPrecision } from '../utils/math';

export class CollectionBidderStrategy {
  private config: BotConfig;
  private apiService: OpenSeaApiService;
  private pricingEngine: PricingEngine;
  private seaportService: SeaportService;
  private inventoryManager: InventoryManager;
  private circuitBreaker: CircuitBreaker;

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

  private friendlyWallets: Set<string> = new Set();

  /** Team Coordination: register other bot wallets so they never outbid or compete with each other */
  public setFriendlyWallets(addresses: string[]): void {
    this.friendlyWallets = new Set(addresses.map((a) => a.toLowerCase()));
  }

  /**
   * Offer lifetime: offers must never stay active longer than 20 minutes. The configured
   * offerExpirationMinutes may shorten this, but can never extend it past 20 minutes.
   */
  public getOfferMaxAgeMinutes(): number {
    const configured = this.config.general.offerExpirationMinutes || 20;
    return Math.min(configured, 20);
  }

  /**
   * 100% Mint-Out Rule — re-verified immediately before EVERY offer submission (initial offers,
   * automatic re-offers and single-token offers) using FRESHLY fetched marketplace data.
   * If mint-out is incomplete or cannot be verified (including API failure), the offer is rejected.
   */
  public async reverifyMintOutBeforeOffer(
    collectionSlug: string,
    contractAddress: string,
    networkKey?: string
  ): Promise<{ passed: boolean; reason: string }> {
    try {
      const freshData = await this.apiService.getCollectionMarketData(collectionSlug, contractAddress, networkKey);
      const check = this.pricingEngine.verifyMintCompletion(freshData);
      if (!check.passed) {
        logger.error(
          { slug: collectionSlug, reason: check.reason },
          `FINAL OFFER-EXECUTION BLOCKED 🛑: Fresh mint-out re-verification failed. ${check.reason}`
        );
      }
      return check;
    } catch (err: any) {
      const reason = `Mint-out status could not be re-verified before offer (${err.message}). Core rule: If status cannot be verified, DO NOT OFFER ❌`;
      logger.error({ slug: collectionSlug, err: err.message }, `FINAL OFFER-EXECUTION BLOCKED 🛑: ${reason}`);
      return { passed: false, reason };
    }
  }

  /**
   * FINAL PRE-OFFER VALIDATION (Rule D) — runs immediately before EVERY offer (initial, re-offer, single-token)
   * on FRESHLY fetched market data, at the exact bid about to be signed:
   *  1. 100% mint-out verified
   *  2. Recent native-ETH floor sales requirement
   *  3. Market dump protection (< 40% floor decline)
   *  4. Creator fee status: optional fees disabled (0 bps in costs & order), mandatory fee within ceiling and counted
   *  5. Profitability: floor >= Offer * 1.30 AND floor >= minimum acceptable floor (12% margin after marketplace
   *     fee and gas; creator fees excluded from that margin) AND actual net profit (creator included) >= minimum
   */
  /**
   * One of our offers filled on this collection: cancel EVERY other live offer of ours on it immediately and verify
   * each cancellation (a collection offer can fill again on any token).
   */
  public async cancelAllOffersForCollection(collectionSlug: string, contractAddress: string, reason: string = 'Offer filled on collection'): Promise<{ cancelled: number; failed: number }> {
    const live = this.inventoryManager.getLiveOffersForCollection(collectionSlug, contractAddress);
    let cancelled = 0;
    let failed = 0;
    for (const offer of live) {
      const res = await this.cancelAndVerifyOffer(offer, reason);
      if (res.success) cancelled++;
      else failed++;
    }
    if (live.length > 0) {
      logger.warn({ slug: collectionSlug, cancelled, failed }, `Offer filled on ${collectionSlug}: cancelled ${cancelled}/${live.length} remaining offers (verified)`);
    }
    return { cancelled, failed };
  }

  /**
   * Automatic Offer Cancellation When Capital Is Insufficient:
   * After one offer is accepted, check whether remaining WETH / capital allocation can still fund
   * other active offers. Cancel (and verify) any offers that can no longer be funded.
   * Cancelled offers are never recreated without a full criteria recheck in a later bidding cycle.
   */
  public async cancelUnfundedOffersAfterCapitalChange(reason: string = 'Insufficient capital after purchase'): Promise<{ cancelled: number; failed: number }> {
    const ethPriceUsd = await this.apiService.getEthPriceUsd();
    const live = this.inventoryManager.getAllActiveOffers().filter((o) => o.status === 'ACTIVE');
    if (live.length === 0) return { cancelled: 0, failed: 0 };

    // Group by network so WETH balance is checked per chain
    const byNetwork = new Map<string, typeof live>();
    for (const offer of live) {
      const net = offer.network || 'robinhood';
      const list = byNetwork.get(net) || [];
      list.push(offer);
      byNetwork.set(net, list);
    }

    let cancelled = 0;
    let failed = 0;
    const offerAllocLimitUsd = this.inventoryManager.getOfferAllocationLimitUsd();
    const purchasedUsd = this.inventoryManager.getPurchasedNftCapitalUsd(ethPriceUsd);
    const remainingOfferBudgetUsd = Math.max(0, offerAllocLimitUsd - purchasedUsd);

    for (const [network, offers] of byNetwork) {
      let wethBal = 0;
      try {
        wethBal = await this.seaportService.getWethBalance(network);
      } catch {
        wethBal = 0;
      }

      // Sort most expensive first — cancel those first until remaining offers are fundable
      const sorted = [...offers].sort((a, b) => b.priceEth - a.priceEth);
      let remainingEth = sorted.reduce((s, o) => s + o.priceEth, 0);
      let remainingUsd = sorted.reduce((s, o) => s + (o.priceUsd || o.priceEth * ethPriceUsd), 0);

      for (const offer of sorted) {
        const offerUsd = offer.priceUsd || offer.priceEth * ethPriceUsd;
        const wethOk = remainingEth <= wethBal + 1e-9;
        const capitalOk = remainingUsd <= remainingOfferBudgetUsd + 0.000001;
        if (wethOk && capitalOk) break;

        logger.warn(
          {
            orderHash: offer.orderHash,
            slug: offer.collectionSlug,
            priceEth: offer.priceEth,
            wethBal,
            remainingEth,
            remainingUsd,
            remainingOfferBudgetUsd,
            reason
          },
          'Insufficient capital for active offer after purchase — cancelling unfunded offer'
        );
        const res = await this.cancelAndVerifyOffer(offer, reason);
        if (res.success) cancelled++;
        else failed++;
        remainingEth -= offer.priceEth;
        remainingUsd -= offerUsd;
      }
    }

    if (cancelled + failed > 0) {
      logger.warn({ cancelled, failed }, `Capital insufficient after purchase: cancelled ${cancelled} unfunded offer(s), ${failed} failed verification`);
    }
    return { cancelled, failed };
  }

  /**
   * Fast purchase detection independent of the stream: checks each live offer's OpenSea order status.
   * FULFILLED -> invokes onFilled (which finds the bought token in the wallet and lists it immediately).
   */
  public async checkOffersForFills(onFilled: (offer: ActiveOffer) => Promise<void>): Promise<number> {
    let fills = 0;
    for (const offer of this.inventoryManager.getAllActiveOffers()) {
      if (offer.status !== 'ACTIVE' && offer.status !== 'CANCELLATION_PENDING') continue;
      if (!offer.orderHash || offer.orderHash.startsWith('sim_')) continue;
      const st = await this.apiService.verifyOfferInactive(offer.orderHash, offer.network || 'robinhood');
      if ((st.status || '').toUpperCase() === 'FULFILLED') {
        this.inventoryManager.markOfferFulfilled(offer.orderHash);
        fills++;
        await onFilled(offer);
      }
    }
    return fills;
  }

  /**
   * Returns true (and logs) when the collection must not be evaluated further this cycle:
   *  - data unavailable after retries -> "SKIPPED (data unavailable, will retry)" (NOT a 0/10 rejection; never offers)
   *  - rejected by a cheap check (mint-out / creator fee) before sales were fetched
   */
  public skipOrEarlyReject(marketData: CollectionMarketData, slug: string, network: string): boolean {
    if (marketData.dataUnavailable) {
      logger.warn(
        { slug, network, reason: marketData.dataUnavailableReason },
        `SKIPPED (data unavailable, will retry) [${network.toUpperCase()}]: ${slug}. No offer placed this cycle.`
      );
      return true;
    }
    if (marketData.earlyRejectReason) {
      logger.info({ slug, network, reason: marketData.earlyRejectReason }, `OFFER REJECTED ❌ [${network.toUpperCase()}]: ${marketData.earlyRejectReason}`);
      return true;
    }
    return false;
  }

  public async finalPreOfferValidation(params: {
    collectionSlug: string;
    contractAddress: string;
    networkKey: string;
    bidPriceEth: number;
    targetConfig?: any;
  }): Promise<{ passed: boolean; reason: string; freshData?: CollectionMarketData }> {
    const { collectionSlug, contractAddress, networkKey, bidPriceEth, targetConfig } = params;
    // Collection Re-Offer Rule (covers collection, single-token and item offers and every re-offer)
    const collectionCheck = this.inventoryManager.canOfferOnCollection(collectionSlug, contractAddress);
    if (!collectionCheck.allowed) {
      logger.error({ slug: collectionSlug, reason: collectionCheck.reason }, `FINAL OFFER-EXECUTION BLOCKED 🛑: ${collectionCheck.reason}`);
      return { passed: false, reason: collectionCheck.reason! };
    }

    // Direct Live Wallet Verification Guard: verify on-chain wallet does not hold any unsold NFT in this collection
    try {
      const ourWallet = this.seaportService.getWalletAddress();
      if (ourWallet) {
        const ownedInCollection = await this.apiService.getAccountNfts(ourWallet, collectionSlug, networkKey);
        if (ownedInCollection && ownedInCollection.length > 0) {
          const ignored = this.config.general.ignoredCollections || ['robin-owls', 'robin-owls-269031093'];
          const matchingNfts = ownedInCollection.filter((nft: any) => {
            const slug = (nft.collection || collectionSlug).toLowerCase();
            const cAddr = (nft.contract || contractAddress).toLowerCase();
            if (ignored.some((i) => slug.includes(i.toLowerCase()) || cAddr.includes(i.toLowerCase()))) {
              return false;
            }
            return true;
          });
          if (matchingNfts.length > 0) {
            for (const nft of matchingNfts) {
              const id = `${(nft.contract || contractAddress).toLowerCase()}:${nft.identifier}`;
              if (!this.inventoryManager.getInventoryItem(id)) {
                this.inventoryManager.addInventoryItem({
                  identifier: id,
                  collectionSlug,
                  contractAddress: nft.contract || contractAddress,
                  tokenId: String(nft.identifier),
                  network: networkKey,
                  acquiredPriceEth: 0,
                  acquiredAtTimestamp: Date.now(),
                  status: 'PENDING_LISTING',
                  isExternalWalletItem: false
                });
              }
            }
            const blockReason = `Direct wallet verification: Wallet currently holds ${matchingNfts.length} unsold NFT(s) from ${collectionSlug}. Re-offer blocked until confirmed sold.`;
            logger.error({ slug: collectionSlug, count: matchingNfts.length }, `FINAL OFFER-EXECUTION BLOCKED 🛑: ${blockReason}`);
            return { passed: false, reason: blockReason };
          }
        }
      }
    } catch (walletErr: any) {
      logger.debug({ slug: collectionSlug, err: walletErr.message }, 'Pre-offer direct wallet verification note');
    }
    let fresh: CollectionMarketData;
    try {
      // fresh: floor / offers re-read now (no cache) so a falling floor or our own new listing is never used stale
      fresh = await this.apiService.getCollectionMarketData(collectionSlug, contractAddress, networkKey, { fresh: true });
    } catch (err: any) {
      return { passed: false, reason: `Final validation could not fetch fresh market data (${err.message}).` };
    }
    if (fresh.dataUnavailable) {
      return { passed: false, reason: fresh.dataUnavailableReason || 'SKIPPED (data unavailable, will retry)', freshData: fresh };
    }
    const block = (reason: string) => {
      logger.error({ slug: collectionSlug, network: networkKey, bidPriceEth, reason }, `FINAL OFFER-EXECUTION BLOCKED 🛑: ${reason}`);
      return { passed: false, reason, freshData: fresh };
    };

    const mint = this.pricingEngine.verifyMintCompletion(fresh);
    if (!mint.passed) return block(mint.reason);

    const minSales = this.config.liquidity?.minSales3Hours ?? 10;
    if (fresh.sameBuyerActivityDetected) {
      return block(fresh.liquidityReason || 'Same-Buyer Activity Filter: Only the same buyer has been buying NFTs during the last 30 minutes.');
    }
    if ((fresh.sales3Hours ?? 0) < minSales || fresh.liquidityPassed === false) {
      return block(fresh.liquidityReason || `Recent floor sales requirement failed (${fresh.sales3Hours ?? 0}/${minSales} native ETH floor sales in 3h).`);
    }

    const refFloor = fresh.referenceFloorEth && fresh.referenceFloorEth > 0 ? fresh.referenceFloorEth : fresh.floorPriceEth;
    if (refFloor > 0 && ((refFloor - fresh.floorPriceEth) / refFloor) * 100 >= (this.config.riskManagement?.maxAllowedFloorDeclinePercent ?? 40)) {
      return block('Market dump protection: floor declined by 40% or more.');
    }

    // Creator fee status: optional fees must be flagged disabled; the applicable fee (royaltyFeeBps) is mandatory only
    const optionalStillEnabled = (fresh.fees || []).some((f) => f.required === false && f.disabled !== true);
    if (optionalStillEnabled) return block('Optional creator fee is not disabled.');
    const creatorFeeBps = fresh.royaltyFeeBps || 0;
    if (creatorFeeBps > this.config.fees.maxAcceptableRoyaltyBps) {
      return block(`Mandatory creator fee (${creatorFeeBps} bps) exceeds acceptable maximum (${this.config.fees.maxAcceptableRoyaltyBps} bps).`);
    }

    if (!(bidPriceEth > 0)) return block('Invalid bid price.');

    // Rule 1 (Top-Priority Offers): never post a bid that is already below the live competing top.
    // Fresh competing book — independent of cached marketData.topOfferEth.
    const ourAddress = this.seaportService.getWalletAddress();
    const ethPriceUsd = fresh.ethPriceUsd || 2700;
    const competing = await this.apiService.getTopCompetingCollectionOffer(collectionSlug, {
      excludeAddresses: [ourAddress, ...Array.from(this.friendlyWallets)],
      ethPriceUsd,
      fresh: true
    });
    if (competing === undefined) {
      return block('Top-Priority Offer Rule: competing offers could not be verified; refusing to place below #1.');
    }
    const bidPriceUsd = roundToPrecision(bidPriceEth * ethPriceUsd, 2);
    const wouldBeOutbid = competing && (
      bidPriceEth <= competing.priceEth + 1e-12 ||
      (competing.priceUsd !== undefined && bidPriceUsd > 0 && bidPriceUsd <= competing.priceUsd + 0.001)
    );
    if (wouldBeOutbid) {
      const topDesc = competing.priceUsd ? `$${competing.priceUsd.toFixed(2)} (${competing.priceEth} ETH)` : `${competing.priceEth} ETH`;
      return block(
        `Top-Priority Offer Rule: bid (${bidPriceEth} ETH / $${bidPriceUsd.toFixed(2)}) would not beat external competitor (top ${topDesc}). Adjust before placing.`
      );
    }

    // Queue-Stacking Guard: If a friendly teammate holds #1, our offer must sit strictly below it
    const absoluteTop = await this.apiService.getAbsoluteTopCollectionOffer(collectionSlug, ethPriceUsd);
    if (absoluteTop?.offerer && this.friendlyWallets.has(absoluteTop.offerer.toLowerCase())) {
      if (bidPriceEth >= absoluteTop.priceEth - 1e-12) {
        return block(
          `Queue-Stacking Rule: bid (${bidPriceEth} ETH) must sit below friendly teammate's #1 offer (${absoluteTop.priceEth} ETH).`
        );
      }
    }
    const gasUsd = this.config.networks?.[networkKey]?.estimatedGasCostUsd ?? (networkKey === 'mainnet' ? 3.5 : 0.01);
    const gasEth = gasUsd / ethPriceUsd;
    const creatorFeePercent = creatorFeeBps / 100;
    const marginPercent = this.pricingEngine.getMinMarginPercent(targetConfig, bidPriceUsd, creatorFeePercent);
    const minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.30;
    if (fresh.floorPriceEth < bidPriceEth * minFloorMultiplier - 1e-12) {
      return block(`Floor (${fresh.floorPriceEth} ETH) < Offer (${bidPriceEth} ETH) * ${minFloorMultiplier}.`);
    }
    const minFloorEth = this.pricingEngine.computeMinAcceptableFloorEth({
      offerEth: bidPriceEth,
      openseaFeeBps: fresh.openseaFeeBps,
      creatorFeeBps,
      gasEth,
      marginPercent,
      ethPriceUsd
    });
    if (fresh.floorPriceEth < minFloorEth - 1e-12) {
      return block(
        `Floor (${fresh.floorPriceEth} ETH) is below minimum acceptable floor (${roundToPrecision(minFloorEth, 8)} ETH) for a ${marginPercent}% margin after marketplace fee (${fresh.openseaFeeBps} bps) and gas (creator fees excluded from this margin floor).`
      );
    }
    const undercut = (this.config.profitTargets?.undercutFloorByPercent ?? 0) / 100;
    const expectedSaleEth = fresh.floorPriceEth * (1 - undercut);
    // Margin check excludes creator fees; actual net profit still includes mandatory creator fees
    const profitExclCreatorEth = expectedSaleEth * (1 - fresh.openseaFeeBps / 10000) - bidPriceEth - gasEth;
    const marginExclCreator = bidPriceEth > 0 ? (profitExclCreatorEth / bidPriceEth) * 100 : 0;
    if (marginExclCreator < marginPercent - 1e-9) {
      return block(
        `Expected margin (${marginExclCreator.toFixed(1)}%, creator fees excluded) is below minimum (${marginPercent}%).`
      );
    }
    const netProfitEth = expectedSaleEth * (1 - (fresh.openseaFeeBps + creatorFeeBps) / 10000) - bidPriceEth - gasEth;
    const minNetProfitUsd = targetConfig?.targetNetProfitUsd ?? this.config.capital?.minNetProfitUsd ?? 0.20;
    if (netProfitEth * ethPriceUsd < minNetProfitUsd - 0.005) {
      return block(`Expected net profit ($${(netProfitEth * ethPriceUsd).toFixed(2)}) below minimum ($${minNetProfitUsd.toFixed(2)}) after creator fees and all costs.`);
    }
    const tier1MaxUsd = this.config.profitTargets?.tier1MaxPriceUsd ?? 4.0;
    const netProfitMarginAfterCreator = bidPriceEth > 0 ? (netProfitEth / bidPriceEth) * 100 : 0;
    if (bidPriceUsd > tier1MaxUsd && netProfitMarginAfterCreator < 12.0 - 1e-6) {
      return block(
        `Expected profit after creator fee (${netProfitMarginAfterCreator.toFixed(1)}%) is below required minimum (12.0%).`
      );
    }
    // Keep freshData.topOfferEth aligned with the live competing book used for the #1 check
    if (competing) fresh.topOfferEth = competing.priceEth;
    return { passed: true, reason: 'Final validation passed', freshData: fresh };
  }

  /**
   * Creator Fee Rule (offer side): verify the SIGNED offer order carries no optional creator fee before posting.
   */
  public verifySignedOfferCreatorFees(orderComponents: any, fees?: FeeRecipient[]): { verified: boolean; reason?: string } {
    try {
      const consideration = orderComponents?.consideration || [];
      this.seaportService.verifyOrderFees(consideration, fees);
      const res = this.seaportService.verifyCreatorFeeDisabledBeforeSale(consideration, fees);
      return { verified: res.verified, reason: res.reason };
    } catch (err: any) {
      return { verified: false, reason: err.message };
    }
  }

  /**
   * Automatic Offer Cancellation & Verification Helper:
   * 1. Marks offer as CANCELLATION_PENDING (capital stays locked!)
   * 2. Requests marketplace cancellation from OpenSea API
   * 3. Verifies offer is inactive before releasing capital
   * 4. Confirms cancellation and releases capital only upon verified inactivity.
   */
  public async cancelAndVerifyOffer(
    offer: ActiveOffer,
    reason: string = 'Automatic Cancellation'
  ): Promise<{ success: boolean; error?: string }> {
    const orderHash = offer.orderHash;
    const network = offer.network || 'robinhood';

    // 1. Mark status CANCELLATION_PENDING (capital stays locked!)
    const alreadyRequested = offer.status === 'CANCELLATION_PENDING' && offer.fillableUntil !== undefined;
    this.inventoryManager.initiateOfferCancellation(orderHash);

    try {
      // 2. Request marketplace (offchain) cancellation — once
      if (!alreadyRequested) {
        const cancelRes = await this.apiService.cancelOffer(orderHash, network);
        if (!cancelRes.success) {
          logger.warn(
            { orderHash, network, error: cancelRes.error, reason },
            'Marketplace cancel request failed or queued. Will perform verification check.'
          );
        }
        if (cancelRes.fillableUntil) {
          this.inventoryManager.setOfferFillableUntil(orderHash, cancelRes.fillableUntil);
        }
      }

      // 3. Verify offer is inactive before releasing capital
      let verification = await this.apiService.verifyOfferInactive(orderHash, network);

      // 3a. Offer was accepted while we were cancelling: it is a FILL, not a cancellation
      if (verification.status === 'FULFILLED') {
        this.inventoryManager.markOfferFulfilled(orderHash);
        logger.info({ orderHash, collection: offer.collectionSlug }, 'Offer was accepted before cancellation completed (FULFILLED). Tracking purchase.');
        return { success: false, error: 'Offer was fulfilled (accepted) before cancellation' };
      }

      // 3b. API could not confirm: fall back to on-chain Seaport getOrderStatus (isCancelled)
      if (!verification.isInactive && verification.status !== 'ACTIVE' && verification.status !== 'INACTIVE') {
        const cancelledOnChain = await this.seaportService.isOrderCancelledOnChain(orderHash, network);
        if (cancelledOnChain) {
          verification = { isInactive: true, status: 'CANCELLED_ONCHAIN' };
        }
      }

      // 3c. Offchain cancel: a previously issued fulfillment signature may still fill the order until it expires
      const fillableUntil = this.inventoryManager.getActiveOffer(orderHash)?.fillableUntil ?? offer.fillableUntil;
      if (verification.isInactive && verification.status === 'CANCELLED' && fillableUntil && Date.now() < fillableUntil) {
        logger.info(
          { orderHash, fillableUntil: new Date(fillableUntil).toISOString() },
          'Offer cancelled offchain but an issued fulfillment signature is still valid. Capital stays locked until it expires.'
        );
        return { success: false, error: 'Awaiting expiry of last issued fulfillment signature' };
      }

      if (verification.isInactive) {
        // Verification confirmed: release capital
        this.inventoryManager.confirmOfferCancellation(orderHash);
        this.apiService.invalidateCollectionCache(offer.collectionSlug);
        logger.info(
          { orderHash, collection: offer.collectionSlug, network, reason },
          'Automatic Offer Cancellation: Cancellation verified and confirmed ✅ Capital released.'
        );
        return { success: true };
      } else {
        // Verification failed: DO NOT assume capital has been released!
        this.inventoryManager.failOfferCancellation(
          orderHash,
          verification.error || 'Offer still active after cancellation request'
        );
        logger.warn(
          { orderHash, collection: offer.collectionSlug, reason },
          'Cancellation verification failed ❌ Capital remains locked.'
        );
        return {
          success: false,
          error: verification.error || 'Offer still active after cancellation request'
        };
      }
    } catch (err: any) {
      logger.error({ orderHash, err: err.message, reason }, 'Unexpected error during offer cancellation process');
      this.inventoryManager.failOfferCancellation(orderHash, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Automatic Offer Cancellation — 20-Minute Rule:
   * 1. Offer Expiry: Every NFT offer placed by the bot must be automatically cancelled if it has not been accepted within 20 minutes of creation.
   * 2. Automatic Cancellation: The bot must track each offer's creation time and initiate cancellation when the 20-minute limit expires.
   * 3. Cancellation Verification: The bot must verify that the offer is no longer active before treating it as cancelled.
   */
  public async processAutomaticOfferCancellations(maxAgeMinutes: number = 20): Promise<{
    cancelled: number;
    failed: number;
    pending: number;
  }> {
    const cutoffMs = maxAgeMinutes * 60 * 1000;
    const expiredOffers = this.inventoryManager.getOffersExceeding20Minutes(cutoffMs);

    if (expiredOffers.length === 0) {
      return { cancelled: 0, failed: 0, pending: 0 };
    }

    logger.info(
      { count: expiredOffers.length, maxAgeMinutes },
      `Automatic Offer Cancellation (20-Minute Rule): Initiating cancellation & verification for ${expiredOffers.length} unaccepted offer(s)...`
    );

    let cancelled = 0;
    let failed = 0;
    let pending = 0;

    for (const offer of expiredOffers) {
      const res = await this.cancelAndVerifyOffer(offer, '20-Minute Expiry Rule');
      if (res.success) {
        cancelled++;
      } else {
        const currentOffer = this.inventoryManager.getActiveOffer(offer.orderHash);
        if (currentOffer?.flaggedForAttention || currentOffer?.status === 'CANCELLATION_FAILED') {
          failed++;
        } else {
          pending++;
        }
      }
    }

    return { cancelled, failed, pending };
  }

  /**
   * Evaluates if our offer is outbid by a competitor, checking both USD and ETH amounts.
   */
  public static isOutbidBy(competing: { priceEth: number; priceUsd?: number }, offer: ActiveOffer): boolean {
    if (competing.priceUsd !== undefined && offer.priceUsd !== undefined && offer.priceUsd > 0 && competing.priceUsd > 0) {
      if (competing.priceUsd > offer.priceUsd + 0.001) {
        return true;
      }
    }
    if (competing.priceEth > offer.priceEth + 1e-12) {
      return true;
    }
    return false;
  }

  /**
   * Highest competing offer info (ETH and USD) for an active offer we hold.
   * Uses a FRESH lightweight offers lookup — never gated by mint / floor / liquidity eligibility.
   *
   * Returns `undefined` when the competing book cannot be read (caller must NOT treat that as "we are #1").
   */
  public async getCompetingTopOffer(offer: ActiveOffer): Promise<{ priceEth: number; priceUsd?: number; orderHash?: string } | undefined> {
    const ourAddress = this.seaportService.getWalletAddress();
    const ethPriceUsd = await this.apiService.getEthPriceUsd();
    const competing = await this.apiService.getTopCompetingCollectionOffer(offer.collectionSlug, {
      excludeOrderHashes: [offer.orderHash],
      excludeAddresses: [ourAddress, ...Array.from(this.friendlyWallets)],
      ethPriceUsd,
      fresh: true
    });
    if (competing === undefined) return undefined;
    let best = competing ? { ...competing } : { priceEth: 0, priceUsd: 0 };
    // Single-NFT offers also compete with the best offer on that specific token
    if (offer.tokenId) {
      const bestNft = await this.apiService.getBestNftOffer(offer.collectionSlug, offer.tokenId);
      if (bestNft && bestNft.orderHash !== offer.orderHash && bestNft.priceEth > best.priceEth) {
        best = {
          priceEth: bestNft.priceEth,
          priceUsd: ethPriceUsd > 0 ? bestNft.priceEth * ethPriceUsd : undefined,
          orderHash: bestNft.orderHash
        };
      }
    }
    return best;
  }

  /**
   * Highest competing offer price (ETH) for an active offer we hold.
   */
  public async getCompetingTopOfferEth(offer: ActiveOffer): Promise<number | undefined> {
    const competing = await this.getCompetingTopOffer(offer);
    return competing ? competing.priceEth : undefined;
  }

  /**
   * Rule 2 — One Active Offer Per NFT/collection: if we somehow have multiple live offers on the same
   * collection, cancel every duplicate except the highest-priced one (then outbid logic can raise/cancel it).
   */
  public async cancelDuplicateOffersForCollection(collectionSlug: string, contractAddress?: string): Promise<number> {
    const live = this.inventoryManager.getLiveOffersForCollection(collectionSlug, contractAddress)
      .filter((o) => o.status === 'ACTIVE' || o.status === 'CANCELLATION_FAILED');
    if (live.length <= 1) return 0;
    const sorted = [...live].sort((a, b) => b.priceEth - a.priceEth);
    let cancelled = 0;
    for (const dup of sorted.slice(1)) {
      logger.warn(
        { slug: collectionSlug, orderHash: dup.orderHash, priceEth: dup.priceEth, keepHash: sorted[0].orderHash },
        'One Active Offer Rule: cancelling duplicate simultaneous offer on the same collection'
      );
      const res = await this.cancelAndVerifyOffer(dup, 'One Active Offer Per NFT: duplicate simultaneous offer');
      if (res.success) cancelled++;
    }
    return cancelled;
  }

  /**
   * Instant Offer Cancellation — Outbid Rule:
   * 1. Cancel When Outbid: If another buyer places a higher offer on an NFT,
   *    the bot must automatically cancel its existing offer immediately without waiting 20 minutes.
   * 2. Continuous Verification: Live offers with CANCELLATION_PENDING or CANCELLATION_FAILED are re-verified
   *    immediately on every cycle so they are resolved without waiting for the 20-minute expiry.
   * 3. No Stale Offers: The bot must not leave outdated offers active after being outbid.
   */
  public async processOutbidOfferCancellations(): Promise<{
    cancelled: number;
    failed: number;
    pending: number;
  }> {
    const liveOffers = this.inventoryManager.getAllActiveOffers().filter(
      (o) => o.status === 'ACTIVE' || o.status === 'CANCELLATION_PENDING' || o.status === 'CANCELLATION_FAILED'
    );
    if (liveOffers.length === 0) {
      return { cancelled: 0, failed: 0, pending: 0 };
    }

    let cancelled = 0;
    let failed = 0;
    let pending = 0;

    for (const offer of liveOffers) {
      try {
        // If cancellation was already initiated or pending, re-verify and retry immediately so it does NOT wait 20 minutes
        if (offer.status === 'CANCELLATION_PENDING' || offer.status === 'CANCELLATION_FAILED') {
          const res = await this.cancelAndVerifyOffer(offer, 'Pending Outbid Cancellation Retry');
          if (res.success) {
            this.apiService.invalidateCollectionCache(offer.collectionSlug);
            cancelled++;
          } else {
            const currentOffer = this.inventoryManager.getActiveOffer(offer.orderHash);
            if (currentOffer?.flaggedForAttention || currentOffer?.status === 'CANCELLATION_FAILED') {
              failed++;
            } else {
              pending++;
            }
          }
          continue;
        }

        // Rule 2: collapse duplicate simultaneous offers on the same collection first
        await this.cancelDuplicateOffersForCollection(offer.collectionSlug, offer.contractAddress);

        const competing = await this.getCompetingTopOffer(offer);
        if (competing === undefined) {
          logger.warn(
            { orderHash: offer.orderHash, collection: offer.collectionSlug },
            'Cancel When Outbid: competing offers unavailable — cannot confirm #1 priority; will retry next cycle (offer left active).'
          );
          pending++;
          continue;
        }

        const isOutbid = CollectionBidderStrategy.isOutbidBy(competing, offer);
        if (isOutbid) {
          const competingDisplay = competing.priceUsd ? `$${competing.priceUsd.toFixed(2)}` : `${competing.priceEth} ETH`;
          const ourDisplay = offer.priceUsd ? `$${offer.priceUsd.toFixed(2)}` : `${offer.priceEth} ETH`;
          logger.info(
            {
              orderHash: offer.orderHash,
              collection: offer.collectionSlug,
              ourPrice: ourDisplay,
              topOffer: competingDisplay
            },
            `Instant Offer Cancellation Rule: Another buyer placed a higher offer (${competingDisplay} > ${ourDisplay}). Automatically cancelling existing offer immediately...`
          );

          const res = await this.cancelAndVerifyOffer(
            offer,
            `Outbid by higher offer (${competingDisplay} > ${ourDisplay})`
          );
          if (res.success) {
            this.apiService.invalidateCollectionCache(offer.collectionSlug);
            cancelled++;
          } else {
            const currentOffer = this.inventoryManager.getActiveOffer(offer.orderHash);
            if (currentOffer?.flaggedForAttention || currentOffer?.status === 'CANCELLATION_FAILED') {
              failed++;
            } else {
              pending++;
            }
          }
        }
      } catch (err: any) {
        logger.debug({ orderHash: offer.orderHash, error: err.message }, 'Error checking competing offers for outbid');
      }
    }

    return { cancelled, failed, pending };
  }

  /**
   * Evaluates collections across ALL active networks (Robinhood & Ethereum) automatically.
   */
  public async evaluateAndPlaceBids(): Promise<void> {
    if (!this.circuitBreaker.isOperational()) {
      logger.warn('Circuit breaker is tripped. Skipping bidding cycle.');
      return;
    }

    // 0. Automatic Offer Cancellation:
    // a. 20-Minute Expiry Rule: Cancel unaccepted offers after 20 minutes
    await this.processAutomaticOfferCancellations(this.getOfferMaxAgeMinutes());
    // b. Cancel When Outbid Rule: Automatically cancel existing offers if outbid by another buyer
    await this.processOutbidOfferCancellations();

    // Capital Reallocation Rule: pause new offer cycles while the 70% allocation is fully committed to
    // purchased NFTs, until at least 40% of them have sold (cancellation sweeps above still run).
    const pauseCheck = this.inventoryManager.evaluateOfferCyclePause();
    if (pauseCheck.paused) {
      logger.warn({ pauseState: this.inventoryManager.getOfferCyclePauseState() }, `OFFER CYCLE PAUSED ⏸: ${pauseCheck.reason}`);
      return;
    }

    const activeNetworks = this.config.general.activeNetworks || ['robinhood', 'mainnet'];
    const totalCapitalUsd = this.inventoryManager.getTotalCapitalUsd();
    const activeOffersCapitalUsd = this.inventoryManager.getActiveOffersCapitalUsd();
    const offerLimitPercent = this.inventoryManager.getOfferAllocationPercent();
    const maxOfferCapitalUsd = (totalCapitalUsd * offerLimitPercent) / 100;

    logger.info(
      {
        totalCapitalUsd: `$${totalCapitalUsd.toFixed(2)}`,
        activeOffersCapitalUsd: `$${activeOffersCapitalUsd.toFixed(2)}`,
        maxOfferCapitalAllocation: `$${maxOfferCapitalUsd.toFixed(2)} (${offerLimitPercent}%)`
      },
      `Starting bidding cycle: Simultaneous offers enabled across all qualifying NFTs (up to ${offerLimitPercent}% capital allocation).`
    );

    // NFT Monitoring & Tracking Price Range: monitor floors from $1 to $9 USD
    const minOfferPriceUsd = this.config.capital?.minOfferPriceUsd ?? 1.00;
    const minFloorUsd = minOfferPriceUsd;
    const maxFloorUsd = this.config.capital?.maxBuyPriceUsd ?? 9.00;

    const processedThisCycle = new Set<string>();

    // 1. Dynamic Market Discovery: Scan live marketplace for active collections on active networks
    for (const net of activeNetworks) {
      try {
        logger.info(`Scanning live marketplace on ${net.toUpperCase()} for active collections ($${minFloorUsd}-$${maxFloorUsd})...`);
        const discovered = await this.apiService.discoverCollectionsByChain(net, minFloorUsd, maxFloorUsd);
        if (discovered.length === 0) {
          logger.info(`Dynamic scan: No active collections in $${minFloorUsd}-$${maxFloorUsd} range on ${net.toUpperCase()} this round.`);
        }
        for (const disc of discovered) {
          const key = `${net}:${disc.slug}`;
          processedThisCycle.add(key);
          try {
            await this.processCollectionBid({
              name: disc.name,
              slug: disc.slug,
              contractAddress: disc.contractAddress,
              network: net,
              targetNetProfitUsd: this.config.capital?.minNetProfitUsd ?? 0.20,
              maxInventory: 5
            }, net);
          } catch (err: any) {
            logger.debug({ slug: disc.slug, network: net, error: err.message }, 'Error processing discovered collection bid');
          }
        }
      } catch (err: any) {
        logger.error({ network: net, error: err.message }, 'Failed during dynamic chain collection discovery');
      }
    }

    // 2. Evaluate any configured target collections (if enabled and not already evaluated)
    for (const target of this.config.targetCollections) {
      if (!target.enabled) continue;

      const networksToEvaluate = target.network ? [target.network] : activeNetworks;
      for (const net of networksToEvaluate) {
        const key = `${net}:${target.slug}`;
        if (processedThisCycle.has(key)) {
          continue;
        }
        try {
          await this.processCollectionBid({ ...target, network: net }, net);
        } catch (err: any) {
          logger.error({ slug: target.slug, network: net, error: err.message }, 'Error in collection bidding routine');
          this.circuitBreaker.registerError(`Bid processing ${target.slug} on ${net}`, err);
        }
      }
    }
  }

  private async processCollectionBid(target: any, networkKey?: string): Promise<void> {
    const targetNetwork = networkKey || target.network || 'robinhood';

    // 1. SCAN NFT & Check collection-level capacity
    if (this.circuitBreaker.isCollectionPermanentlyExcluded(target.slug)) {
      logger.warn(
        { slug: target.slug },
        'OFFER REJECTED ❌: Collection is permanently excluded due to extreme floor collapse (Market Dump Protection).'
      );
      return;
    }

    const canBid = this.inventoryManager.canBidOnCollection(target.slug, target.maxInventory ?? 5);
    if (!canBid) return;

    // Collection Re-Offer Rule: no new offers while we hold any unsold NFT from this collection
    const collectionCheck = this.inventoryManager.canOfferOnCollection(target.slug, target.contractAddress);
    if (!collectionCheck.allowed) {
      logger.info({ slug: target.slug, network: targetNetwork, reason: collectionCheck.reason }, `OFFER BLOCKED: ${collectionCheck.reason}`);
      return;
    }

    // 2. CHECK AVAILABLE CAPITAL
    const availableCapitalUsd = this.inventoryManager.getAvailableCapitalUsd();
    if (availableCapitalUsd <= 0.20) {
      logger.info(
        { availableCapitalUsd, totalCapitalUsd: this.inventoryManager.getTotalCapitalUsd() },
        'Capital allocation check: Available capital exhausted. Skipping further offers.'
      );
      return;
    }

    // 3.0. One-offer + outbid / expiry cancel BEFORE eligibility gates — stale offers must not survive a mint/liquidity SKIP
    await this.cancelDuplicateOffersForCollection(target.slug, target.contractAddress);
    const existingOffer = this.inventoryManager.getActiveOffer(target.slug);

    // Team Coordination & Queue-Stacking Rule:
    // If another friendly wallet already holds the #1 offer on this collection,
    // do not outbid them! Instead, place a #2 queue-stacking offer right behind them.
    let isQueueStacking = false;
    let friendlyTopOfferEth: number | undefined;

    if (!existingOffer) {
      const ourAddress = this.seaportService.getWalletAddress().toLowerCase();
      const absoluteTop = await this.apiService.getAbsoluteTopCollectionOffer(target.slug);
      if (absoluteTop?.offerer) {
        const topOfferer = absoluteTop.offerer.toLowerCase();
        if (topOfferer !== ourAddress && this.friendlyWallets.has(topOfferer) && (absoluteTop.priceEth || 0) > 0) {
          isQueueStacking = true;
          friendlyTopOfferEth = absoluteTop.priceEth;
          logger.info(
            { slug: target.slug, topOfferer, friendlyTopOfferEth },
            `[Queue-Stacking] Teammate holds #1 (${friendlyTopOfferEth} ETH). Positioning #2 backup offer behind teammate to capture secondary fills.`
          );
        }
      }
    }
    if (existingOffer) {
      if (
        existingOffer.status === 'CANCELLATION_PENDING' ||
        existingOffer.status === 'CANCELLATION_FAILED' ||
        (existingOffer.status === 'CANCELLED' && !existingOffer.cancellationVerified)
      ) {
        // Try verifying/completing cancellation immediately
        const cancelRes = await this.cancelAndVerifyOffer(existingOffer, 'Verifying previous cancellation before re-entry');
        if (!cancelRes.success) {
          logger.warn(
            { slug: target.slug, orderHash: existingOffer.orderHash, status: existingOffer.status },
            'Cannot place new offer: Previous offer cancellation is not yet confirmed/verified. Capital remains locked.'
          );
          return;
        }
        this.apiService.invalidateCollectionCache(target.slug);
      } else if (existingOffer.status === 'ACTIVE') {
        const competing = await this.getCompetingTopOffer(existingOffer);
        if (competing === undefined) {
          logger.warn(
            { slug: target.slug, orderHash: existingOffer.orderHash },
            'Cannot confirm #1 offer priority (competing book unavailable). Leaving existing offer; will retry next cycle.'
          );
          return;
        }
        const isOutbid = CollectionBidderStrategy.isOutbidBy(competing, existingOffer);
        const isExpired = Date.now() - existingOffer.createdTimestamp >= this.getOfferMaxAgeMinutes() * 60 * 1000;

        if (isOutbid || isExpired) {
          const competingDisplay = competing.priceUsd ? `$${competing.priceUsd.toFixed(2)}` : `${competing.priceEth} ETH`;
          const ourDisplay = existingOffer.priceUsd ? `$${existingOffer.priceUsd.toFixed(2)}` : `${existingOffer.priceEth} ETH`;
          const cancelReason = isOutbid
            ? `Outbid by higher offer (${competingDisplay} > ${ourDisplay})`
            : '20-Minute Expiry (Unaccepted within 20 minutes)';

          logger.info(
            { slug: target.slug, orderHash: existingOffer.orderHash, ourPrice: ourDisplay, topOffer: competingDisplay, cancelReason },
            `Instant Offer Cancellation Rule: Cancelling outdated offer immediately (${cancelReason})...`
          );

          const cancelRes = await this.cancelAndVerifyOffer(existingOffer, cancelReason);
          if (!cancelRes.success) {
            logger.warn(
              { slug: target.slug, orderHash: existingOffer.orderHash },
              'Cannot re-offer: Offer cancellation could not be verified on marketplace. Capital remains locked.'
            );
            return;
          }
          this.apiService.invalidateCollectionCache(target.slug);

          logger.info(
            { slug: target.slug, cancelReason },
            'Instant Offer Cancellation: Cancellation verified ✅ Proceeding to recheck all trading criteria for re-entry...'
          );
        } else {
          // Offer is active, confirmed #1, and within 20-minute expiry window
          logger.debug(
            { slug: target.slug, network: targetNetwork, price: existingOffer.priceEth, competingTopEth: competing.priceEth },
            'Active offer already in place at #1 priority and within 20-minute expiry window.'
          );
          return;
        }
      }
    }

    // 3. FETCH LATEST MARKET DATA (eligibility for NEW / re-entry offers only) + FRESH competing top for #1 sizing
    const marketData = await this.apiService.getCollectionMarketData(target.slug, target.contractAddress, targetNetwork);
    if (this.skipOrEarlyReject(marketData, target.slug, targetNetwork)) {
      return;
    }
    const liveCompeting = await this.apiService.getTopCompetingCollectionOffer(target.slug, {
      excludeAddress: this.seaportService.getWalletAddress(),
      fresh: true
    });
    if (liveCompeting === undefined) {
      logger.warn({ slug: target.slug }, 'OFFER SKIPPED: competing top offer unavailable — refusing to place without #1 confirmation.');
      return;
    }
    // Always size against the live competing book (never stale/cached topOfferEth alone)
    marketData.topOfferEth = liveCompeting?.priceEth || 0;

    // 3.5. NFT RECENT FLOOR SALES REQUIREMENT CHECK
    // The bot must place offers only on NFT collections with at least 10 or more completed
    // floor-price sales within the last 3 hours, using native ETH.
    const minFloorSales = this.config.liquidity?.minSales3Hours ?? 10;
    const sales3h = marketData.sales3Hours ?? 0;
    if (sales3h < minFloorSales || marketData.liquidityPassed === false) {
      logger.info(
        {
          slug: target.slug,
          network: targetNetwork,
          sales3Hours: sales3h,
          minRequired: minFloorSales,
          reason: marketData.liquidityReason
        },
        `OFFER REJECTED ❌ [${targetNetwork.toUpperCase()}]: Collection fails Recent Floor Sales Requirement (${sales3h}/${minFloorSales} completed native ETH floor sales in last 3 hours). ${marketData.liquidityReason || 'Strict Rejection.'}`
      );
      return;
    }

    // 4. CHECK MARKET DUMP PROTECTION & FLOOR STABILITY WITH CIRCUIT BREAKER
    const dumpCheck = this.circuitBreaker.evaluateMarketDumpProtection(
      target.slug,
      marketData.floorPriceEth,
      marketData.referenceFloorEth
    );
    if (!dumpCheck.allowed) {
      logger.info(
        {
          slug: target.slug,
          network: targetNetwork,
          declinePercent: dumpCheck.declinePercent,
          referenceFloor: dumpCheck.referenceFloor,
          floorPriceEth: marketData.floorPriceEth
        },
        `MARKET DUMP PROTECTION REJECTION ❌: ${dumpCheck.reason}`
      );
      return;
    }

    const isStable = this.circuitBreaker.checkFloorPriceMovement(target.slug, marketData.floorPriceEth, marketData.referenceFloorEth);
    if (!isStable) return;

    // 4.5. CHECK INCOMPLETE PUBLIC MINT PROTECTION
    const mintCheck = this.pricingEngine.verifyMintCompletion(marketData);
    if (!mintCheck.passed) {
      logger.info(
        { slug: target.slug, network: targetNetwork, reason: mintCheck.reason },
        `INCOMPLETE PUBLIC MINT REJECTION ❌: ${mintCheck.reason}`
      );
      return;
    }

    // 5. CALCULATE EXPECTED RESALE, ROYALTIES, MARKETPLACE FEES, GAS & NET PROFIT
    const calculation = this.pricingEngine.calculateMaxBid(
      marketData,
      target.targetNetProfitUsd,
      availableCapitalUsd,
      targetNetwork,
      target
    );

    // 6. PROFITABILITY CHECK (Check B) & CAPITAL CHECK (Check A) + Top-Priority (#1) guard
    if (!calculation.isProfitable) {
      logger.info(
        {
          slug: target.slug,
          network: targetNetwork,
          floorPriceEth: marketData.floorPriceEth,
          calculatedBidEth: calculation.bidPriceEth,
          bidPriceUsd: calculation.bidPriceUsd,
          expectedNetProfitUsd: calculation.netProfitUsd,
          estimatedGasCostUsd: calculation.estimatedGasCostUsd,
          royaltyFeeUsd: calculation.royaltyFeeUsd,
          openseaFeeUsd: calculation.openseaFeeUsd,
          decision: calculation.decision,
          reason: calculation.reason
        },
        `TRADE REJECTED ❌ [${targetNetwork.toUpperCase()}]: ${calculation.reason}`
      );
      return;
    }

    // If Queue-Stacking behind a friendly teammate:
    // Our bid must beat the highest EXTERNAL competitor, while sitting below the friendly teammate!
    if (isQueueStacking && friendlyTopOfferEth) {
      const ourAddress = this.seaportService.getWalletAddress().toLowerCase();
      const competingExternal = await this.apiService.getTopCompetingCollectionOffer(target.slug, {
        excludeAddresses: [ourAddress, ...Array.from(this.friendlyWallets)],
        ethPriceUsd: marketData.ethPriceUsd,
        fresh: true
      });
      const externalTopEth = competingExternal?.priceEth || 0;
      const ethPriceUsd = marketData.ethPriceUsd || 2700;
      const minOfferPriceUsd = this.config.capital?.minOfferPriceUsd ?? 1.0;
      const minOfferEth = roundToPrecision(Math.ceil((minOfferPriceUsd / ethPriceUsd) * 10000) / 10000, 4);
      const tickEth = 0.0001; // Seaport 4-decimal tick size for ETH/WETH

      let targetQueueBidEth = roundToPrecision(
        Math.max(minOfferEth, externalTopEth > 0 ? externalTopEth + tickEth : minOfferEth),
        4
      );

      // Must sit strictly below friendly teammate's offer (at least 1 Seaport tick below)
      if (targetQueueBidEth >= friendlyTopOfferEth) {
        targetQueueBidEth = roundToPrecision(friendlyTopOfferEth - tickEth, 4);
      }

      if (targetQueueBidEth < minOfferEth) {
        logger.info(
          { slug: target.slug, targetQueueBidEth, minOfferEth, minOfferPriceUsd },
          '[Queue-Stacking] Teammate offer is at minimum threshold; cannot place #2 offer without going below minimum offer price. Skipping.'
        );
        return;
      }

      if (externalTopEth > 0 && targetQueueBidEth <= externalTopEth) {
        logger.info(
          { slug: target.slug, externalTopEth, friendlyTopOfferEth },
          '[Queue-Stacking] No room to place #2 offer between teammate and external competitor. Skipping.'
        );
        return;
      }

      calculation.bidPriceEth = targetQueueBidEth;
      calculation.bidPriceUsd = roundToPrecision(targetQueueBidEth * ethPriceUsd, 2);
    }

    // Ensure bid does not exceed configured ceiling
    if (target.maxBidEth && calculation.bidPriceEth > target.maxBidEth) {
      logger.debug(
        { slug: target.slug, network: targetNetwork, calculatedBid: calculation.bidPriceEth, maxCap: target.maxBidEth },
        'Calculated bid exceeds configured maxBidEth ceiling. Capping to maxBidEth.'
      );
      calculation.bidPriceEth = target.maxBidEth;
      calculation.bidPriceUsd = roundToPrecision(calculation.bidPriceEth * (marketData.ethPriceUsd || 2700), 2);
    }

    // Rule 1: after all caps, the posted bid MUST beat the highest external competitor
    const ourAddressLower = this.seaportService.getWalletAddress().toLowerCase();
    const competingTop = await this.apiService.getTopCompetingCollectionOffer(target.slug, {
      excludeAddresses: [ourAddressLower, ...Array.from(this.friendlyWallets)],
      ethPriceUsd: marketData.ethPriceUsd,
      fresh: true
    });
    const competingTopEth = competingTop?.priceEth || 0;

    if (competingTopEth > 0 && calculation.bidPriceEth <= competingTopEth + 1e-12) {
      logger.info(
        {
          slug: target.slug,
          bidPriceEth: calculation.bidPriceEth,
          competingTopEth
        },
        `TRADE REJECTED ❌ [${targetNetwork.toUpperCase()}]: Top-Priority Offer Rule — cannot beat competing top without violating profitability (bid ${calculation.bidPriceEth} ETH <= competing top ${competingTopEth} ETH).`
      );
      return;
    }

    // Final capital allocation check: offers + purchased NFTs within 70% of total capital (30% reserved)
    const capitalLockCheck = this.inventoryManager.canAllocateCapitalForOffer(calculation.bidPriceUsd, marketData.ethPriceUsd);
    if (!capitalLockCheck.allowed) {
      logger.info(
        { reason: capitalLockCheck.reason, bidPriceUsd: calculation.bidPriceUsd, network: targetNetwork, slug: target.slug },
        `OFFER SKIPPED [${targetNetwork.toUpperCase()}]: ${capitalLockCheck.reason}`
      );
      return;
    }

    // 7. Active offer and capital allocation checks passed, proceeding to log and pre-flight
    logger.info(
      {
        collection: target.name,
        network: targetNetwork,
        sales_3h: calculation.sales3Hours,
        unique_wallets_3h: calculation.uniqueWallets3Hours,
        bidPriceEth: calculation.bidPriceEth,
        bidPriceUsd: `$${calculation.bidPriceUsd}`,
        targetListPriceEth: calculation.targetListPriceEth,
        targetListPriceUsd: `$${calculation.targetListPriceUsd}`,
        creatorRoyaltyUsd: `$${calculation.royaltyFeeUsd}`,
        creatorFeeRule: marketData.creatorFeeDisabled
          ? 'OPTIONAL (DISABLED to 0 bps in Seaport & Calculations) ✅'
          : `${marketData.royaltyFeeBps} bps (MANDATORY - factored into profit) 🛡️`,
        marketplaceFeeUsd: `$${calculation.openseaFeeUsd}`,
        estimatedGasCostUsd: `$${calculation.estimatedGasCostUsd}`,
        expectedNetProfitUsd: `$${calculation.netProfitUsd}`,
        marginPercent: `${calculation.marginPercent}%`,
        checkMint_Completion: 'PASSED ✅ (100% Mint-out verified and secondary demand confirmed)',
        checkDump_Protection: `PASSED ✅ (Floor decline ${calculation.floorDeclinePercent ?? 0}% < 40% threshold)`,
        checkL_Liquidity: 'PASSED ✅ (>= 10 genuine native ETH floor sales & >= 5 wallets in 3h, WETH & offers excluded)',
        checkF_FloorRatio: 'PASSED ✅ (Floor >= Offer * 1.30, >= 30% floor difference excluding creator fees)',
        checkMinOffer_Price: 'PASSED ✅ (Offer >= $1.00 minimum offer price per NFT)',
        checkA_Capital: 'PASSED ✅ (within active-offer capital allocation)',
        checkB_Profitability: 'PASSED ✅'
      },
      `ALL CHECKS PASSED ✅ Placing collection offer on ${targetNetwork.toUpperCase()}`
    );

    // 7.5. PRE-FLIGHT CHECK: Ensure wallet has sufficient WETH on target network
    let availableWeth = await this.seaportService.getWethBalance(targetNetwork);
    if (availableWeth < calculation.bidPriceEth) {
      // Auto-rebalance: wrap 90% of available native ETH into WETH (holding 10% gas reserve)
      const rebalanceRes = await this.seaportService.autoWrapAvailableEthIfDeficit(
        calculation.bidPriceEth,
        targetNetwork
      );
      if (rebalanceRes.amountWrappedEth > 0) {
        availableWeth = await this.seaportService.getWethBalance(targetNetwork);
      }
    }
    if (availableWeth < calculation.bidPriceEth) {
      logger.info(
        { targetNetwork, availableWeth, requiredWeth: calculation.bidPriceEth },
        `[${targetNetwork.toUpperCase()}] Insufficient WETH balance (${availableWeth} WETH available vs ${calculation.bidPriceEth} WETH required). Skipping offer on this chain until WETH is deposited.`
      );
      return;
    }

    // 7.8. FINAL OFFER-EXECUTION STAGE ENFORCEMENT
    // 1) 100% Mint-Out Rule
    const finalMintCheck = this.pricingEngine.verifyMintCompletion(marketData);
    if (!finalMintCheck.passed) {
      logger.error(
        { slug: target.slug, network: targetNetwork, reason: finalMintCheck.reason },
        `FINAL OFFER-EXECUTION BLOCKED 🛑: Collection has not fully minted out. ${finalMintCheck.reason}`
      );
      return;
    }

    // 2) Minimum Offer Price Rule ($1.00 minimum per NFT)
    const minOfferPriceUsd = this.config.capital?.minOfferPriceUsd ?? 1.00;
    if (calculation.bidPriceUsd < minOfferPriceUsd) {
      logger.error(
        { slug: target.slug, bidPriceUsd: calculation.bidPriceUsd, minOfferPriceUsd },
        `FINAL OFFER-EXECUTION BLOCKED 🛑: Proposed offer ($${calculation.bidPriceUsd.toFixed(2)}) is below $1.00 minimum offer price.`
      );
      return;
    }

    // 3) Minimum Floor Price Requirement (Floor >= Offer * 1.30, creator fees excluded)
    const minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.30;
    const currentFloorUsd = marketData.floorPriceEth * (marketData.ethPriceUsd || 2700);
    const requiredMinFloorUsd = calculation.bidPriceUsd * minFloorMultiplier;
    if (currentFloorUsd < requiredMinFloorUsd - 0.001) {
      logger.error(
        { slug: target.slug, currentFloorUsd, requiredMinFloorUsd, bidPriceUsd: calculation.bidPriceUsd },
        `FINAL OFFER-EXECUTION BLOCKED 🛑: Current floor ($${currentFloorUsd.toFixed(2)}) is not at least 30% higher than offer ($${calculation.bidPriceUsd.toFixed(2)}). Required: >= $${requiredMinFloorUsd.toFixed(2)}`
      );
      return;
    }

    // 4) NFT Recent Floor Sales Requirement (>= 10 completed floor-price sales in 3h with native ETH)
    const minFloorSalesRequired = this.config.liquidity?.minSales3Hours ?? 10;
    const floorSales3h = marketData.sales3Hours ?? 0;
    if (floorSales3h < minFloorSalesRequired) {
      logger.error(
        {
          slug: target.slug,
          network: targetNetwork,
          sales3Hours: floorSales3h,
          minRequired: minFloorSalesRequired,
          reason: marketData.liquidityReason
        },
        `FINAL OFFER-EXECUTION BLOCKED 🛑: Collection does not meet Recent Floor Sales Requirement (${floorSales3h}/${minFloorSalesRequired} completed floor sales in native ETH in last 3 hours). ${marketData.liquidityReason || 'Strict Rejection.'}`
      );
      return;
    }

    // 5) FINAL PRE-OFFER VALIDATION on fresh data (mint-out, sales, dump, creator fee, 40% margin / min floor)
    const finalCheck = await this.finalPreOfferValidation({
      collectionSlug: target.slug,
      contractAddress: target.contractAddress,
      networkKey: targetNetwork,
      bidPriceEth: calculation.bidPriceEth,
      targetConfig: target
    });
    if (!finalCheck.passed) {
      return;
    }
    const offerFees = finalCheck.freshData?.fees ?? marketData.fees;

    // 8. SIGN SEAPORT COLLECTION OFFER (Off-chain EIP-712 with required fee recipients; optional creator fees excluded)
    const { orderComponents, signature } = await this.seaportService.createSignedCollectionOffer(
      target.contractAddress,
      calculation.bidPriceEth,
      this.getOfferMaxAgeMinutes(),
      targetNetwork,
      offerFees,
      {
        currency: calculation.currency,
        bidPriceUsdg: calculation.bidPriceUsdg
      }
    );
    const offerFeeCheck = this.verifySignedOfferCreatorFees(orderComponents, offerFees);
    if (!offerFeeCheck.verified) {
      logger.error({ slug: target.slug, reason: offerFeeCheck.reason }, 'FINAL OFFER-EXECUTION BLOCKED 🛑: optional creator fee not disabled in signed offer');
      return;
    }

    // 9. POST OFFER TO OPENSEA (OpenSea v2 /offers format)
    const postPayload = {
      criteria: {
        collection: {
          slug: target.slug
        }
      },
      protocol_data: {
        parameters: orderComponents,
        signature
      },
      protocol_address: this.config.seaport.contractAddress
    };

    const res = await this.apiService.postCollectionOffer(postPayload);
    this.apiService.invalidateCollectionCache(target.slug);

    // Pre-approve conduit in the background so when an offer fills, instant listing requires 0 on-chain tx
    this.seaportService.ensureNftConduitApproval(target.contractAddress, targetNetwork).catch((err: any) => {
      logger.debug({ contract: target.contractAddress, err: err.message }, 'Background conduit pre-approval note');
    });
    if (calculation.currency === 'USDG') {
      const netInfo = this.config.networks[targetNetwork];
      const usdgAddr = netInfo?.usdgAddress || '0x595a8910ba11e38ada602430b8b1122644247b0c';
      this.seaportService.ensureTokenConduitApproval(usdgAddr, targetNetwork).catch(() => {});
    }

    // 9.5. Optional: Target recently minted tokens (Larry's offerSingle idea)
    if (target.singleTokenBids) {
      try {
        const recentTokens = await this.apiService.getLatestMintedTokens(target.slug, 3);
        for (const tok of recentTokens) {
          try {
            // Check Same NFT Re-Bidding Restriction & Capital Allocation
            const nftBidCheck = this.inventoryManager.canPlaceOfferOnNft(
              target.contractAddress,
              tok.tokenId,
              calculation.bidPriceUsd,
              marketData.ethPriceUsd
            );
            if (!nftBidCheck.allowed) {
              logger.info(
                { tokenId: tok.tokenId, slug: target.slug, reason: nftBidCheck.reason },
                `NFT OFFER SKIPPED: ${nftBidCheck.reason}`
              );
              continue;
            }

            // 100% Mint-Out Rule: re-verify before EVERY single-token offer
            const tokenFinalCheck = await this.finalPreOfferValidation({
              collectionSlug: target.slug,
              contractAddress: target.contractAddress,
              networkKey: targetNetwork,
              bidPriceEth: calculation.bidPriceEth,
              targetConfig: target
            });
            if (!tokenFinalCheck.passed) {
              logger.info({ tokenId: tok.tokenId, slug: target.slug, reason: tokenFinalCheck.reason }, 'NFT OFFER SKIPPED: final validation failed');
              break;
            }

            const { orderComponents: itemComponents, signature: itemSig } = await this.seaportService.createSignedItemOffer(
              target.contractAddress,
              tok.tokenId,
              calculation.bidPriceEth,
              this.getOfferMaxAgeMinutes(),
              targetNetwork,
              tokenFinalCheck.freshData?.fees ?? marketData.fees
            );
            if (!this.verifySignedOfferCreatorFees(itemComponents, tokenFinalCheck.freshData?.fees ?? marketData.fees).verified) {
              logger.error({ tokenId: tok.tokenId }, 'NFT OFFER BLOCKED: optional creator fee present in signed offer');
              continue;
            }
            const singlePayload = {
              parameters: itemComponents,
              signature: itemSig,
              protocol_address: this.config.seaport.contractAddress
            };
            const singleRes = await this.apiService.postSingleOffer(targetNetwork, singlePayload);
            logger.info({ tokenId: tok.tokenId, orderHash: singleRes?.order_hash }, `Placed single token offer on #${tok.tokenId}`);

            // Track individual NFT offer and lock capital independently
            this.inventoryManager.registerActiveOffer({
              orderHash: singleRes?.order_hash || `sim_single_${tok.tokenId}_${Date.now()}`,
              collectionSlug: target.slug,
              contractAddress: target.contractAddress,
              tokenId: tok.tokenId,
              network: targetNetwork,
              priceEth: calculation.bidPriceEth,
              priceUsd: calculation.bidPriceUsd,
              createdTimestamp: Date.now(),
              expiresTimestamp: Date.now() + this.getOfferMaxAgeMinutes() * 60 * 1000,
              status: 'ACTIVE',
              orderComponents: itemComponents,
              signature: itemSig
            });
          } catch (singleErr: any) {
            logger.debug({ tokenId: tok.tokenId, err: singleErr.message }, 'Single offer info');
          }
        }
      } catch (err: any) {
        logger.debug({ err: err.message }, 'Recent mint single offer fetch skipped');
      }
    }

    // 10. TRACK OFFER & LOCK CAPITAL
    this.inventoryManager.registerActiveOffer({
      orderHash: res?.order_hash || `sim_${Date.now()}`,
      collectionSlug: target.slug,
      contractAddress: target.contractAddress,
      network: targetNetwork,
      currency: calculation.currency,
      priceEth: calculation.bidPriceEth,
      priceUsd: calculation.bidPriceUsd,
      priceUsdg: calculation.bidPriceUsdg,
      createdTimestamp: Date.now(),
      expiresTimestamp: Date.now() + this.getOfferMaxAgeMinutes() * 60 * 1000,
      status: 'ACTIVE',
      orderComponents,
      signature
    });

    this.circuitBreaker.registerSuccess();
  }

  /**
   * Places an offer on an individual NFT item while enforcing the Same NFT Re-Bidding Restriction,
   * 60% capital allocation limit, and independent NFT tracking.
   */
  public async placeItemBid(params: {
    contractAddress: string;
    tokenId: string;
    collectionSlug: string;
    network?: string;
    targetNetProfitUsd?: number;
    maxBidEth?: number;
  }): Promise<{ success: boolean; reason?: string }> {
    const targetNetwork = params.network || 'robinhood';

    // 1. Permanent Exclusion Check (Market Dump Protection)
    if (this.circuitBreaker.isCollectionPermanentlyExcluded(params.collectionSlug)) {
      return {
        success: false,
        reason: 'Collection is permanently excluded due to extreme floor collapse (Market Dump Protection)'
      };
    }

    // 2. Same NFT Re-Bidding Restriction & Capital Allocation Check
    const availableCapitalUsd = this.inventoryManager.getAvailableCapitalUsd();
    if (this.inventoryManager.isNftOwnedOrUnresolved(params.contractAddress, params.tokenId)) {
      const nftCheck = this.inventoryManager.canPlaceOfferOnNft(params.contractAddress, params.tokenId);
      logger.info({ contractAddress: params.contractAddress, tokenId: params.tokenId, reason: nftCheck.reason }, 'Item bid rejected');
      return { success: false, reason: nftCheck.reason };
    }

    // 3.0. Outbid / expiry cancel BEFORE eligibility gates (same rule as collection offers)
    const itemKey = `${params.contractAddress.toLowerCase()}:${params.tokenId}`;
    const existingItemOffer = this.inventoryManager.getActiveOffer(itemKey);
    if (existingItemOffer) {
      if (
        existingItemOffer.status === 'CANCELLATION_PENDING' ||
        existingItemOffer.status === 'CANCELLATION_FAILED' ||
        (existingItemOffer.status === 'CANCELLED' && !existingItemOffer.cancellationVerified)
      ) {
        return {
          success: false,
          reason: 'Cannot place new offer: Previous offer cancellation is not yet confirmed/verified. Capital remains locked.'
        };
      }

      if (existingItemOffer.status === 'ACTIVE') {
        const competingBestEth = await this.getCompetingTopOfferEth(existingItemOffer);
        if (competingBestEth === undefined) {
          return {
            success: false,
            reason: 'Cannot confirm #1 offer priority (competing book unavailable). Leaving existing item offer.'
          };
        }
        const isOutbid = competingBestEth > existingItemOffer.priceEth + 1e-12;
        const isExpired = Date.now() - existingItemOffer.createdTimestamp >= this.getOfferMaxAgeMinutes() * 60 * 1000;

        if (isOutbid || isExpired) {
          const cancelReason = isOutbid
            ? `Outbid by higher offer (${competingBestEth} ETH > ${existingItemOffer.priceEth} ETH)`
            : '20-Minute Expiry (Unaccepted within 20 minutes)';

          logger.info(
            { tokenId: params.tokenId, orderHash: existingItemOffer.orderHash, cancelReason },
            `Cancel When Outbid / Expiry: Cancelling outdated item offer (${cancelReason})...`
          );

          const cancelRes = await this.cancelAndVerifyOffer(existingItemOffer, cancelReason);
          if (!cancelRes.success) {
            return {
              success: false,
              reason: 'Cannot re-offer: Item offer cancellation could not be verified. Capital remains locked.'
            };
          }
          this.apiService.invalidateCollectionCache(params.collectionSlug);
        } else {
          return {
            success: false,
            reason: 'Active offer already in place on this item at #1 priority and within 20-minute expiry window.'
          };
        }
      }
    }

    // 3. Market Data & Pre-Checks (eligibility for NEW / re-entry item offers only)
    const marketData = await this.apiService.getCollectionMarketData(params.collectionSlug, params.contractAddress, targetNetwork);
    if (this.skipOrEarlyReject(marketData, params.collectionSlug, targetNetwork)) {
      return { success: false, reason: marketData.dataUnavailableReason || marketData.earlyRejectReason || 'Rejected' };
    }
    const itemCompeting = await this.apiService.getTopCompetingCollectionOffer(params.collectionSlug, {
      excludeAddress: this.seaportService.getWalletAddress(),
      fresh: true
    });
    if (itemCompeting === undefined) {
      return { success: false, reason: 'Competing top offer unavailable — refusing to place without #1 confirmation.' };
    }
    let itemTopEth = itemCompeting?.priceEth || 0;
    const bestOnNft = await this.apiService.getBestNftOffer(params.collectionSlug, params.tokenId);
    if (bestOnNft && bestOnNft.priceEth > itemTopEth) itemTopEth = bestOnNft.priceEth;
    marketData.topOfferEth = itemTopEth;

    const nftCheck = this.inventoryManager.canPlaceOfferOnNft(params.contractAddress, params.tokenId);
    if (!nftCheck.allowed) {
      logger.info({ contractAddress: params.contractAddress, tokenId: params.tokenId, reason: nftCheck.reason }, 'Item bid rejected');
      return { success: false, reason: nftCheck.reason };
    }

    // 3.0. Recent Floor Sales Requirement Check
    const minItemFloorSales = this.config.liquidity?.minSales3Hours ?? 10;
    const itemSales3h = marketData.sales3Hours ?? 0;
    if (itemSales3h < minItemFloorSales || marketData.liquidityPassed === false) {
      logger.info(
        { slug: params.collectionSlug, sales3Hours: itemSales3h, minItemFloorSales, reason: marketData.liquidityReason },
        'Item bid rejected: Collection fails Recent Floor Sales Requirement'
      );
      return {
        success: false,
        reason: `Collection fails Recent Floor Sales Requirement (${itemSales3h}/${minItemFloorSales} completed floor-price sales in native ETH within last 3 hours).`
      };
    }

    // 3.1. Market Dump Protection Check
    const dumpCheck = this.circuitBreaker.evaluateMarketDumpProtection(
      params.collectionSlug,
      marketData.floorPriceEth,
      marketData.referenceFloorEth
    );
    if (!dumpCheck.allowed) {
      return { success: false, reason: dumpCheck.reason };
    }

    // 3.2. Incomplete Public Mint Protection Check
    const mintCheck = this.pricingEngine.verifyMintCompletion(marketData);
    if (!mintCheck.passed) {
      return { success: false, reason: mintCheck.reason };
    }

    // 4. Pricing Calculation & Profitability
    const calculation = this.pricingEngine.calculateMaxBid(
      marketData,
      params.targetNetProfitUsd ?? this.config.capital?.minNetProfitUsd ?? 0.20,
      availableCapitalUsd,
      targetNetwork
    );

    if (!calculation.isProfitable) {
      return { success: false, reason: `Profitability criteria failed: ${calculation.reason}` };
    }

    if (params.maxBidEth && calculation.bidPriceEth > params.maxBidEth) {
      calculation.bidPriceEth = params.maxBidEth;
      calculation.bidPriceUsd = roundToPrecision(calculation.bidPriceEth * (marketData.ethPriceUsd || 2700), 2);
    }

    if (marketData.topOfferEth > 0 && calculation.bidPriceEth <= marketData.topOfferEth + 1e-12) {
      return {
        success: false,
        reason: `Top-Priority Offer Rule: cannot place at #1 without violating profitability (bid ${calculation.bidPriceEth} ETH <= competing top ${marketData.topOfferEth} ETH).`
      };
    }

    // 3. Comply with the 70% capital allocation limit (30% reserved) and offer-cycle pause
    const capitalCheck = this.inventoryManager.canAllocateCapitalForOffer(calculation.bidPriceUsd, marketData.ethPriceUsd);
    if (!capitalCheck.allowed) {
      return { success: false, reason: capitalCheck.reason };
    }

    // 4. Pre-flight WETH check
    let availableWeth = await this.seaportService.getWethBalance(targetNetwork);
    if (availableWeth < calculation.bidPriceEth) {
      const rebalanceRes = await this.seaportService.autoWrapAvailableEthIfDeficit(
        calculation.bidPriceEth,
        targetNetwork
      );
      if (rebalanceRes.amountWrappedEth > 0) {
        availableWeth = await this.seaportService.getWethBalance(targetNetwork);
      }
    }
    if (availableWeth < calculation.bidPriceEth) {
      return { success: false, reason: `Insufficient WETH balance (${availableWeth} available vs ${calculation.bidPriceEth} required)` };
    }

    // 4.9. FINAL OFFER-EXECUTION STAGE ENFORCEMENT
    // 1) 100% Mint-Out Rule
    const finalItemMintCheck = this.pricingEngine.verifyMintCompletion(marketData);
    if (!finalItemMintCheck.passed) {
      logger.error(
        { contractAddress: params.contractAddress, tokenId: params.tokenId, reason: finalItemMintCheck.reason },
        `FINAL OFFER-EXECUTION BLOCKED 🛑: Collection has not fully minted out. ${finalItemMintCheck.reason}`
      );
      return { success: false, reason: finalItemMintCheck.reason };
    }

    // 2) Minimum Offer Price Rule ($1.00 minimum per NFT)
    const minOfferUsd = this.config.capital?.minOfferPriceUsd ?? 1.00;
    if (calculation.bidPriceUsd < minOfferUsd) {
      logger.error(
        { contractAddress: params.contractAddress, tokenId: params.tokenId, bidPriceUsd: calculation.bidPriceUsd, minOfferUsd },
        `FINAL OFFER-EXECUTION BLOCKED 🛑: Proposed offer ($${calculation.bidPriceUsd.toFixed(2)}) is below $1.00 minimum offer price.`
      );
      return { success: false, reason: `Proposed offer ($${calculation.bidPriceUsd.toFixed(2)}) is below $1.00 minimum offer price.` };
    }

    // 3) Minimum Floor Price Requirement (Floor >= Offer * 1.30, creator fees excluded)
    const itemFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.30;
    const itemFloorUsd = marketData.floorPriceEth * (marketData.ethPriceUsd || 2700);
    const requiredItemFloorUsd = calculation.bidPriceUsd * itemFloorMultiplier;
    if (itemFloorUsd < requiredItemFloorUsd - 0.001) {
      logger.error(
        { contractAddress: params.contractAddress, tokenId: params.tokenId, itemFloorUsd, requiredItemFloorUsd },
        `FINAL OFFER-EXECUTION BLOCKED 🛑: Floor ($${itemFloorUsd.toFixed(2)}) is not at least 30% higher than offer ($${calculation.bidPriceUsd.toFixed(2)}).`
      );
      return { success: false, reason: `Floor ($${itemFloorUsd.toFixed(2)}) is not at least 30% higher than offer ($${calculation.bidPriceUsd.toFixed(2)}).` };
    }

    // 4) NFT Recent Floor Sales Requirement (>= 10 completed floor-price sales in 3h with native ETH)
    const minSingleFloorSales = this.config.liquidity?.minSales3Hours ?? 10;
    const itemFloorSales3h = marketData.sales3Hours ?? 0;
    if (itemFloorSales3h < minSingleFloorSales) {
      logger.error(
        {
          contractAddress: params.contractAddress,
          tokenId: params.tokenId,
          sales3Hours: itemFloorSales3h,
          minRequired: minSingleFloorSales,
          reason: marketData.liquidityReason
        },
        `FINAL OFFER-EXECUTION BLOCKED 🛑: Collection fails Recent Floor Sales Requirement (${itemFloorSales3h}/${minSingleFloorSales} completed floor sales in native ETH within last 3 hours).`
      );
      return {
        success: false,
        reason: `Collection fails Recent Floor Sales Requirement (${itemFloorSales3h}/${minSingleFloorSales} completed floor sales in native ETH within last 3 hours).`
      };
    }

    // 5) Fresh 100% Mint-Out re-verification immediately before signing/posting (covers automatic re-offers)
    const itemFinalCheck = await this.finalPreOfferValidation({
      collectionSlug: params.collectionSlug,
      contractAddress: params.contractAddress,
      networkKey: targetNetwork,
      bidPriceEth: calculation.bidPriceEth
    });
    if (!itemFinalCheck.passed) {
      return { success: false, reason: itemFinalCheck.reason };
    }
    const itemFees = itemFinalCheck.freshData?.fees ?? marketData.fees;

    // 5. Sign & Post Item Offer
    const { orderComponents, signature } = await this.seaportService.createSignedItemOffer(
      params.contractAddress,
      params.tokenId,
      calculation.bidPriceEth,
      this.getOfferMaxAgeMinutes(),
      targetNetwork,
      itemFees
    );

    const itemFeeCheck = this.verifySignedOfferCreatorFees(orderComponents, itemFees);
    if (!itemFeeCheck.verified) {
      return { success: false, reason: `Optional creator fee not disabled in signed offer: ${itemFeeCheck.reason}` };
    }

    const singlePayload = {
      parameters: orderComponents,
      signature,
      protocol_address: this.config.seaport.contractAddress
    };

    const res = await this.apiService.postSingleOffer(targetNetwork, singlePayload);
    this.apiService.invalidateCollectionCache(params.collectionSlug);

    // Pre-approve conduit in the background so when an offer fills, instant listing requires 0 on-chain tx
    this.seaportService.ensureNftConduitApproval(params.contractAddress, targetNetwork).catch((err: any) => {
      logger.debug({ contract: params.contractAddress, err: err.message }, 'Background conduit pre-approval note');
    });
    const orderHash = res?.order_hash || `sim_single_${params.tokenId}_${Date.now()}`;

    // 6. Register Active Offer & Independently Track NFT
    this.inventoryManager.registerActiveOffer({
      orderHash,
      collectionSlug: params.collectionSlug,
      contractAddress: params.contractAddress,
      tokenId: params.tokenId,
      network: targetNetwork,
      priceEth: calculation.bidPriceEth,
      priceUsd: calculation.bidPriceUsd,
      createdTimestamp: Date.now(),
      expiresTimestamp: Date.now() + this.getOfferMaxAgeMinutes() * 60 * 1000,
      status: 'ACTIVE',
      orderComponents,
      signature
    });

    logger.info({ contractAddress: params.contractAddress, tokenId: params.tokenId, orderHash, priceEth: calculation.bidPriceEth }, 'Item offer placed at #1 priority and tracked independently');
    return { success: true };
  }
}

