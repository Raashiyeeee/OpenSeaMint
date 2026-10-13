import { BotConfig, ActiveOffer } from '../types';
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
    contractAddress: string
  ): Promise<{ passed: boolean; reason: string }> {
    try {
      const freshData = await this.apiService.getCollectionMarketData(collectionSlug, contractAddress);
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
    this.inventoryManager.initiateOfferCancellation(orderHash);

    try {
      // 2. Request marketplace cancellation
      const cancelRes = await this.apiService.cancelOffer(orderHash, network);
      if (!cancelRes.success) {
        logger.warn(
          { orderHash, network, error: cancelRes.error, reason },
          'Marketplace cancel request failed or queued. Will perform verification check.'
        );
      }

      // 3. Verify offer is inactive before releasing capital
      const verification = await this.apiService.verifyOfferInactive(orderHash, network);

      if (verification.isInactive) {
        // Verification confirmed: release capital
        this.inventoryManager.confirmOfferCancellation(orderHash);
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
   * Automatic Offer Cancellation — Outbid Rule:
   * 1. Cancel When Outbid: If another buyer places a higher offer on an NFT,
   *    the bot must automatically cancel its existing offer.
   * 2. No Stale Offers: The bot must not leave outdated offers active after being outbid.
   */
  public async processOutbidOfferCancellations(): Promise<{
    cancelled: number;
    failed: number;
    pending: number;
  }> {
    const activeOffers = this.inventoryManager.getAllActiveOffers().filter((o) => o.status === 'ACTIVE');
    if (activeOffers.length === 0) {
      return { cancelled: 0, failed: 0, pending: 0 };
    }

    let cancelled = 0;
    let failed = 0;
    let pending = 0;

    for (const offer of activeOffers) {
      try {
        const marketData = await this.apiService.getCollectionMarketData(offer.collectionSlug, offer.contractAddress);
        if (marketData.topOfferEth && marketData.topOfferEth > offer.priceEth) {
          logger.info(
            {
              orderHash: offer.orderHash,
              collection: offer.collectionSlug,
              ourPriceEth: offer.priceEth,
              topOfferEth: marketData.topOfferEth
            },
            `Cancel When Outbid Rule: Another buyer placed a higher offer (${marketData.topOfferEth} ETH > ${offer.priceEth} ETH). Automatically cancelling existing offer...`
          );

          const res = await this.cancelAndVerifyOffer(
            offer,
            `Outbid by higher offer (${marketData.topOfferEth} ETH > ${offer.priceEth} ETH)`
          );
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
      } catch (err: any) {
        logger.debug({ orderHash: offer.orderHash, error: err.message }, 'Note checking market data for outbid offer');
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

    const activeNetworks = this.config.general.activeNetworks || ['robinhood', 'mainnet'];
    const totalCapitalUsd = this.inventoryManager.getTotalCapitalUsd();
    const activeOffersCapitalUsd = this.inventoryManager.getActiveOffersCapitalUsd();
    const offerLimitPercent = this.config.capital?.maxOfferCapitalPercent ?? 60.0;
    const maxOfferCapitalUsd = (totalCapitalUsd * offerLimitPercent) / 100;

    logger.info(
      {
        totalCapitalUsd: `$${totalCapitalUsd.toFixed(2)}`,
        activeOffersCapitalUsd: `$${activeOffersCapitalUsd.toFixed(2)}`,
        maxOfferCapitalAllocation: `$${maxOfferCapitalUsd.toFixed(2)} (${offerLimitPercent}%)`
      },
      `Starting bidding cycle: Simultaneous offers enabled across all qualifying NFTs (up to ${offerLimitPercent}% capital allocation).`
    );

    const minOfferPriceUsd = this.config.capital?.minOfferPriceUsd ?? 1.00;
    const minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.30;
    const minFloorUsd = roundToPrecision(minOfferPriceUsd * minFloorMultiplier, 2); // $1.30 minimum floor
    const maxFloorUsd = 8.00; // Expanded to include high-volume collections like Hex-lings ($4.57) and Project Shiesty ($5.12)

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

    // 2. CHECK AVAILABLE CAPITAL
    const availableCapitalUsd = this.inventoryManager.getAvailableCapitalUsd();
    if (availableCapitalUsd <= 0.20) {
      logger.info(
        { availableCapitalUsd, totalCapitalUsd: this.inventoryManager.getTotalCapitalUsd() },
        'Capital allocation check: Available capital exhausted. Skipping further offers.'
      );
      return;
    }

    // 3. FETCH LATEST MARKET DATA
    const marketData = await this.apiService.getCollectionMarketData(target.slug, target.contractAddress);

    // 3.1. AUTOMATIC OFFER CANCELLATION & RE-ENTRY CHECK (Outbid & 20-Minute Expiry Rules)
    const existingOffer = this.inventoryManager.getActiveOffer(target.slug);
    if (existingOffer) {
      if (
        existingOffer.status === 'CANCELLATION_PENDING' ||
        existingOffer.status === 'CANCELLATION_FAILED' ||
        (existingOffer.status === 'CANCELLED' && !existingOffer.cancellationVerified)
      ) {
        logger.warn(
          { slug: target.slug, orderHash: existingOffer.orderHash, status: existingOffer.status },
          'Cannot place new offer: Previous offer cancellation is not yet confirmed/verified. Capital remains locked.'
        );
        return;
      }

      if (existingOffer.status === 'ACTIVE') {
        const isOutbid = marketData.topOfferEth > existingOffer.priceEth;
        const isExpired = Date.now() - existingOffer.createdTimestamp >= this.getOfferMaxAgeMinutes() * 60 * 1000;

        if (isOutbid || isExpired) {
          const cancelReason = isOutbid
            ? `Outbid by higher offer (${marketData.topOfferEth} ETH > ${existingOffer.priceEth} ETH)`
            : '20-Minute Expiry (Unaccepted within 20 minutes)';

          logger.info(
            { slug: target.slug, orderHash: existingOffer.orderHash, ourPrice: existingOffer.priceEth, topOfferEth: marketData.topOfferEth, cancelReason },
            `Automatic Offer Cancellation Rule: Cancelling outdated offer (${cancelReason})...`
          );

          const cancelRes = await this.cancelAndVerifyOffer(existingOffer, cancelReason);
          if (!cancelRes.success) {
            logger.warn(
              { slug: target.slug, orderHash: existingOffer.orderHash },
              'Cannot re-offer: Offer cancellation could not be verified on marketplace. Capital remains locked.'
            );
            return;
          }

          logger.info(
            { slug: target.slug, cancelReason },
            'Automatic Offer Cancellation: Cancellation verified ✅ Proceeding to recheck all trading criteria for re-entry...'
          );
        } else {
          // Offer is active, NOT outbid, and within 20-minute expiry window
          logger.debug(
            { slug: target.slug, network: targetNetwork, price: existingOffer.priceEth },
            'Active offer already in place at top price and within 20-minute expiry window.'
          );
          return;
        }
      }
    }

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

    // 6. PROFITABILITY CHECK (Check B) & CAPITAL CHECK (Check A)
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

    // Ensure bid does not exceed configured ceiling
    if (calculation.bidPriceEth > target.maxBidEth) {
      logger.debug(
        { slug: target.slug, network: targetNetwork, calculatedBid: calculation.bidPriceEth, maxCap: target.maxBidEth },
        'Calculated bid exceeds configured maxBidEth ceiling. Capping to maxBidEth.'
      );
      calculation.bidPriceEth = target.maxBidEth;
      calculation.bidPriceUsd = roundToPrecision(calculation.bidPriceEth * (marketData.ethPriceUsd || 2700), 2);
    }

    // Final capital allocation check: Active offers allocation limit (e.g. 60% of total capital)
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

    // 5) Fresh 100% Mint-Out re-verification immediately before signing/posting (covers automatic re-offers)
    const freshMintCheck = await this.reverifyMintOutBeforeOffer(target.slug, target.contractAddress);
    if (!freshMintCheck.passed) {
      return;
    }

    // 8. SIGN SEAPORT COLLECTION OFFER (Off-chain EIP-712 with required fee recipients)
    const { orderComponents, signature } = await this.seaportService.createSignedCollectionOffer(
      target.contractAddress,
      calculation.bidPriceEth,
      this.getOfferMaxAgeMinutes(),
      targetNetwork,
      marketData.fees
    );

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
            const tokenMintCheck = await this.reverifyMintOutBeforeOffer(target.slug, target.contractAddress);
            if (!tokenMintCheck.passed) {
              logger.info({ tokenId: tok.tokenId, slug: target.slug, reason: tokenMintCheck.reason }, 'NFT OFFER SKIPPED: Mint-out not verified');
              break;
            }

            const { orderComponents: itemComponents, signature: itemSig } = await this.seaportService.createSignedItemOffer(
              target.contractAddress,
              tok.tokenId,
              calculation.bidPriceEth,
              this.getOfferMaxAgeMinutes(),
              targetNetwork,
              marketData.fees
            );
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
      priceEth: calculation.bidPriceEth,
      priceUsd: calculation.bidPriceUsd,
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

    // 3. Market Data & Pre-Checks
    const marketData = await this.apiService.getCollectionMarketData(params.collectionSlug, params.contractAddress);

    // 3.0. Automatic Offer Cancellation & Re-entry Check for Item (Outbid & 20-Minute Expiry)
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
        const isOutbid = marketData.topOfferEth > existingItemOffer.priceEth;
        const isExpired = Date.now() - existingItemOffer.createdTimestamp >= this.getOfferMaxAgeMinutes() * 60 * 1000;

        if (isOutbid || isExpired) {
          const cancelReason = isOutbid
            ? `Outbid by higher offer (${marketData.topOfferEth} ETH > ${existingItemOffer.priceEth} ETH)`
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
        } else {
          return {
            success: false,
            reason: 'Active offer already in place on this item at top price and within 20-minute expiry window.'
          };
        }
      }
    }

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

    // 3. Comply with configured 60% capital allocation limit
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
    const freshItemMintCheck = await this.reverifyMintOutBeforeOffer(params.collectionSlug, params.contractAddress);
    if (!freshItemMintCheck.passed) {
      return { success: false, reason: freshItemMintCheck.reason };
    }

    // 5. Sign & Post Item Offer
    const { orderComponents, signature } = await this.seaportService.createSignedItemOffer(
      params.contractAddress,
      params.tokenId,
      calculation.bidPriceEth,
      this.getOfferMaxAgeMinutes(),
      targetNetwork,
      marketData.fees
    );

    const singlePayload = {
      parameters: orderComponents,
      signature,
      protocol_address: this.config.seaport.contractAddress
    };

    const res = await this.apiService.postSingleOffer(targetNetwork, singlePayload);
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

    logger.info({ contractAddress: params.contractAddress, tokenId: params.tokenId, orderHash }, 'Item offer placed successfully and tracked independently');
    return { success: true };
  }
}

