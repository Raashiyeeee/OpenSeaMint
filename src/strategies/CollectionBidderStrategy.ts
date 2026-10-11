import { BotConfig } from '../types';
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
   * Evaluates collections across ALL active networks (Robinhood & Ethereum) automatically.
   */
  public async evaluateAndPlaceBids(): Promise<void> {
    if (!this.circuitBreaker.isOperational()) {
      logger.warn('Circuit breaker is tripped. Skipping bidding cycle.');
      return;
    }

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

    const minFloorUsd = 0.20;
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

    // 4. CHECK FLOOR STABILITY WITH CIRCUIT BREAKER
    const isStable = this.circuitBreaker.checkFloorPriceMovement(target.slug, marketData.floorPriceEth);
    if (!isStable) return;

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

    // 7. CHECK IF EXISTING OFFER ALREADY ACTIVE
    const existingOffer = this.inventoryManager.getActiveOffer(target.slug);
    if (existingOffer && existingOffer.priceEth === calculation.bidPriceEth && existingOffer.expiresTimestamp > Date.now()) {
      logger.debug({ slug: target.slug, network: targetNetwork, price: existingOffer.priceEth }, 'Active offer already in place at target price');
      return;
    }

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
        activeOffersCapitalUsd: `$${this.inventoryManager.getActiveOffersCapitalUsd()}`,
        checkL_Liquidity: 'PASSED ✅ (>= 20 sales & >= 5 wallets in 3h around floor)',
        checkA_Capital: 'PASSED ✅ (within active-offer capital allocation)',
        checkB_Profitability: 'PASSED ✅'
      },
      `ALL CHECKS PASSED ✅ Placing collection offer on ${targetNetwork.toUpperCase()}`
    );

    // 7.5. PRE-FLIGHT CHECK: Ensure wallet has sufficient WETH on target network
    const availableWeth = await this.seaportService.getWethBalance(targetNetwork);
    if (availableWeth < calculation.bidPriceEth) {
      logger.info(
        { targetNetwork, availableWeth, requiredWeth: calculation.bidPriceEth },
        `[${targetNetwork.toUpperCase()}] Insufficient WETH balance (${availableWeth} WETH available vs ${calculation.bidPriceEth} WETH required). Skipping offer on this chain until WETH is deposited.`
      );
      return;
    }

    // 8. SIGN SEAPORT COLLECTION OFFER (Off-chain EIP-712 with required fee recipients)
    const { orderComponents, signature } = await this.seaportService.createSignedCollectionOffer(
      target.contractAddress,
      calculation.bidPriceEth,
      this.config.general.offerExpirationMinutes,
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
            const { orderComponents: itemComponents, signature: itemSig } = await this.seaportService.createSignedItemOffer(
              target.contractAddress,
              tok.tokenId,
              calculation.bidPriceEth,
              this.config.general.offerExpirationMinutes,
              targetNetwork,
              marketData.fees
            );
            const singlePayload = {
              parameters: itemComponents,
              signature: itemSig,
              protocol_address: this.config.seaport.contractAddress
            };
            const singleRes = await this.apiService.postSingleOffer(targetNetwork, singlePayload);
            logger.info({ tokenId: tok.tokenId, orderHash: singleRes?.order_hash }, `Placed single token offer on recent mint #${tok.tokenId}`);
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
      expiresTimestamp: Date.now() + this.config.general.offerExpirationMinutes * 60 * 1000,
      status: 'ACTIVE'
    });

    this.circuitBreaker.registerSuccess();
  }
}
