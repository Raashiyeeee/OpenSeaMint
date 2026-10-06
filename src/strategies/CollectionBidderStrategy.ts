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

    // 1. Evaluate configured target collections across active networks
    for (const target of this.config.targetCollections) {
      if (!target.enabled) continue;
      if (this.inventoryManager.getActiveTradesCount() >= (this.config.capital?.maxActiveTrades ?? 1)) break;

      const networksToEvaluate = target.network ? [target.network] : activeNetworks;
      for (const net of networksToEvaluate) {
        if (this.inventoryManager.getActiveTradesCount() >= (this.config.capital?.maxActiveTrades ?? 1)) break;
        try {
          await this.processCollectionBid({ ...target, network: net }, net);
        } catch (err: any) {
          logger.error({ slug: target.slug, network: net, error: err.message }, 'Error in collection bidding routine');
          this.circuitBreaker.registerError(`Bid processing ${target.slug} on ${net}`, err);
        }
      }
    }

    // 2. Dynamic Discovery: Scan live collections across both networks automatically
    if (this.inventoryManager.getActiveTradesCount() < (this.config.capital?.maxActiveTrades ?? 1)) {
      try {
        const discovered = await this.apiService.discoverMicroCapCollections(0.0035);
        for (const disc of discovered) {
          if (this.inventoryManager.getActiveTradesCount() >= (this.config.capital?.maxActiveTrades ?? 1)) break;
          for (const net of activeNetworks) {
            if (this.inventoryManager.getActiveTradesCount() >= (this.config.capital?.maxActiveTrades ?? 1)) break;
            try {
              await this.processCollectionBid({
                name: disc.name,
                slug: disc.slug,
                contractAddress: disc.contractAddress,
                network: net,
                maxBidEth: 0.0035,
                targetNetProfitUsd: this.config.capital?.minNetProfitUsd ?? 2.0,
                maxInventory: 1
              }, net);
            } catch (err: any) {
              logger.debug({ slug: disc.slug, network: net, err: err.message }, 'Error processing discovered collection bid');
            }
          }
        }
      } catch (err: any) {
        logger.debug({ err: err.message }, 'Dynamic collection discovery routine failed');
      }
    }
  }

  private async processCollectionBid(target: any, networkKey?: string): Promise<void> {
    const targetNetwork = networkKey || target.network || 'robinhood';

    // 1. SCAN NFT & Check collection-level capacity
    const canBid = this.inventoryManager.canBidOnCollection(target.slug, target.maxInventory);
    if (!canBid) return;

    // 2. CHECK AVAILABLE CAPITAL (Check A)
    // Rule: One active trade at a time when capital is fully allocated ($10 budget)
    const availableCapitalUsd = this.inventoryManager.getAvailableCapitalUsd();
    const activeTrades = this.inventoryManager.getActiveTradesCount();
    const maxTrades = this.config.capital?.maxActiveTrades ?? 1;

    if (activeTrades >= maxTrades) {
      logger.info(
        { activeTrades, maxTrades, totalCapitalUsd: this.inventoryManager.getTotalCapitalUsd() },
        'Capital allocation check: Bot already has an active trade. Holding capital for current position.'
      );
      return;
    }

    if (availableCapitalUsd <= 0.50) {
      logger.warn(
        { availableCapitalUsd, totalCapitalUsd: this.inventoryManager.getTotalCapitalUsd() },
        'Capital allocation check: Insufficient available capital to place offer. Skipping scan.'
      );
      return;
    }

    // 3. FETCH LATEST MARKET DATA
    const marketData = await this.apiService.getCollectionMarketData(target.slug, target.contractAddress);

    // 4. CHECK FLOOR STABILITY WITH CIRCUIT BREAKER
    const isStable = this.circuitBreaker.checkFloorPriceMovement(target.slug, marketData.floorPriceEth);
    if (!isStable) return;

    // 5. CALCULATE EXPECTED RESALE, ROYALTIES, MARKETPLACE FEES, GAS & NET PROFIT
    // Core Rule: Must calculate realistic net resale value after all costs on specific network.
    const calculation = this.pricingEngine.calculateMaxBid(
      marketData,
      target.targetNetProfitUsd,
      availableCapitalUsd,
      targetNetwork
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

    // Final capital lock re-validation
    const capitalLockCheck = this.inventoryManager.canAllocateCapital(calculation.bidPriceUsd, marketData.ethPriceUsd);
    if (!capitalLockCheck.allowed) {
      logger.warn(
        { reason: capitalLockCheck.reason, bidPriceUsd: calculation.bidPriceUsd, network: targetNetwork },
        'TRADE REJECTED ❌: Cannot allocate capital for offer'
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
        sales_1h: calculation.sales1Hour,
        unique_wallets_1h: calculation.uniqueWallets1Hour,
        bidPriceEth: calculation.bidPriceEth,
        bidPriceUsd: `$${calculation.bidPriceUsd}`,
        targetListPriceEth: calculation.targetListPriceEth,
        targetListPriceUsd: `$${calculation.targetListPriceUsd}`,
        creatorRoyaltyUsd: `$${calculation.royaltyFeeUsd}`,
        marketplaceFeeUsd: `$${calculation.openseaFeeUsd}`,
        estimatedGasCostUsd: `$${calculation.estimatedGasCostUsd}`,
        expectedNetProfitUsd: `$${calculation.netProfitUsd}`,
        marginPercent: `${calculation.marginPercent}%`,
        checkL_Liquidity: 'PASSED ✅ (>= 15 sales & >= 4 wallets in 1h)',
        checkA_Capital: 'PASSED ✅ (Within $10.00)',
        checkB_Profitability: 'PASSED ✅ (>= 13% margin & >= $2.00 profit)'
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

    // 8. SIGN SEAPORT COLLECTION OFFER (Off-chain EIP-712, 0 gas!)
    const { orderComponents, signature } = await this.seaportService.createSignedCollectionOffer(
      target.contractAddress,
      calculation.bidPriceEth,
      this.config.general.offerExpirationMinutes,
      targetNetwork
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
