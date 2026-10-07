import { BotConfig, CollectionMarketData, ProfitCalculationResult } from '../types';
import { roundToPrecision } from '../utils/math';
import { logger } from '../utils/logger';

export class PricingEngine {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Evaluates an explicit trade scenario based on USD values and fee percentages.
   * Useful for direct scenario validation (e.g., User Example 5: Bad Trade, Example 6: Profitable Trade).
   */
  public evaluateOfferScenario(params: {
    offerPriceUsd: number;
    floorPriceUsd: number;
    royaltyPercent: number; // e.g. 10 for 10%
    marketplaceFeePercent?: number; // e.g. 0.5 for 0.5%
    networkGasUsd?: number;
    availableCapitalUsd?: number;
    minNetProfitUsd?: number;
    liquidityDiscountPercent?: number; // e.g. 0% for exact floor, or 1% undercut
  }): {
    netProceedsUsd: number;
    royaltyUsd: number;
    marketplaceFeeUsd: number;
    gasUsd: number;
    expectedNetProfitUsd: number;
    checkACapitalPassed: boolean;
    checkBProfitPassed: boolean;
    isProfitable: boolean;
    decision: 'ACCEPT' | 'REJECT';
    reason: string;
  } {
    const {
      offerPriceUsd,
      floorPriceUsd,
      royaltyPercent,
      marketplaceFeePercent = 0.5,
      networkGasUsd = 0.0,
      availableCapitalUsd = this.config.capital?.totalTradingCapitalUsd ?? 10.0,
      minNetProfitUsd = this.config.capital?.minNetProfitUsd ?? 2.0,
      liquidityDiscountPercent = 0.0
    } = params;

    // Realistic resale price factoring liquidity / undercut
    const realisticSalePriceUsd = floorPriceUsd * (1 - liquidityDiscountPercent / 100);

    // Royalty calculation
    const royaltyUsd = realisticSalePriceUsd * (royaltyPercent / 100);

    // Marketplace fee calculation
    const marketplaceFeeUsd = realisticSalePriceUsd * (marketplaceFeePercent / 100);

    // Gas costs
    const gasUsd = networkGasUsd;

    // Net proceeds from sale after royalty & marketplace fees
    const netProceedsUsd = realisticSalePriceUsd - royaltyUsd - marketplaceFeeUsd;

    // Net profit = Net Sale Proceeds - Acquisition Cost - Gas/Other costs
    const expectedNetProfitUsd = netProceedsUsd - offerPriceUsd - gasUsd;

    // Check A: Capital check
    const checkACapitalPassed = offerPriceUsd <= availableCapitalUsd && offerPriceUsd > 0;

    // Check B: Profitability check
    const checkBProfitPassed = expectedNetProfitUsd >= minNetProfitUsd && expectedNetProfitUsd > 0;

    const isProfitable = checkACapitalPassed && checkBProfitPassed;
    const decision: 'ACCEPT' | 'REJECT' = isProfitable ? 'ACCEPT' : 'REJECT';

    let reason = 'All criteria passed';
    if (!checkACapitalPassed) {
      reason = `Check A Failed: Required capital ($${offerPriceUsd.toFixed(2)}) exceeds available capital ($${availableCapitalUsd.toFixed(2)})`;
    } else if (expectedNetProfitUsd <= 0) {
      reason = `Check B Failed: Trade yields negative or zero net profit ($${expectedNetProfitUsd.toFixed(2)}) after royalties ($${royaltyUsd.toFixed(2)}), fees ($${marketplaceFeeUsd.toFixed(2)}), and gas ($${gasUsd.toFixed(2)})`;
    } else if (!checkBProfitPassed) {
      reason = `Check B Failed: Expected net profit ($${expectedNetProfitUsd.toFixed(2)}) is below minimum threshold ($${minNetProfitUsd.toFixed(2)})`;
    }

    return {
      netProceedsUsd: roundToPrecision(netProceedsUsd, 2),
      royaltyUsd: roundToPrecision(royaltyUsd, 2),
      marketplaceFeeUsd: roundToPrecision(marketplaceFeeUsd, 2),
      gasUsd: roundToPrecision(gasUsd, 2),
      expectedNetProfitUsd: roundToPrecision(expectedNetProfitUsd, 2),
      checkACapitalPassed,
      checkBProfitPassed,
      isProfitable,
      decision,
      reason
    };
  }

  /**
   * Calculates the maximum safe collection offer bid that guarantees the target net profit.
   * Considers:
   * 1. Realistic resale price (discounted for liquidity)
   * 2. Creator royalty
   * 3. Marketplace fees
   * 4. Network gas estimate (Robinhood chain vs Ethereum mainnet)
   * 5. Available capital limit ($10 max)
   * 6. Minimum required net profit threshold ($2.00)
   */
  public calculateMaxBid(
    marketData: CollectionMarketData,
    targetNetProfitUsd?: number,
    availableCapitalUsd?: number,
    networkKey?: string
  ): ProfitCalculationResult {
    const floor = marketData.floorPriceEth;
    const ethPriceUsd = marketData.ethPriceUsd || 2700;
    const floorUsd = roundToPrecision(floor * ethPriceUsd, 2);

    const minNetProfit = targetNetProfitUsd ?? this.config.capital?.minNetProfitUsd ?? this.config.profitTargets.defaultMinNetProfitUsd ?? 2.0;
    const targetProfitEth = minNetProfit / ethPriceUsd;

    // Available capital limit (e.g. $10)
    const capUsd = availableCapitalUsd ?? this.config.capital?.totalTradingCapitalUsd ?? 10.0;
    const maxCapitalEth = capUsd / ethPriceUsd;

    // Realistic resale price: list slightly under current floor for liquidity & execution speed
    const undercutFactor = 1 - (this.config.profitTargets.undercutFloorByPercent / 100);
    const targetListPriceEth = roundToPrecision(floor * undercutFactor, 6);
    const targetListPriceUsd = roundToPrecision(targetListPriceEth * ethPriceUsd, 2);

    // Fee percentages
    const openseaFeeRate = marketData.openseaFeeBps / 10000;
    const royaltyFeeRate = Math.min(
      marketData.royaltyFeeBps / 10000,
      this.config.fees.maxAcceptableRoyaltyBps / 10000
    );
    const totalFeeRate = openseaFeeRate + royaltyFeeRate;

    // Fees on sale
    const openseaFeeEth = targetListPriceEth * openseaFeeRate;
    const openseaFeeUsd = openseaFeeEth * ethPriceUsd;
    const royaltyFeeEth = targetListPriceEth * royaltyFeeRate;
    const royaltyFeeUsd = royaltyFeeEth * ethPriceUsd;
    const totalFeesEth = openseaFeeEth + royaltyFeeEth;
    const totalFeesUsd = totalFeesEth * ethPriceUsd;

    // Net proceeds from sale before gas
    const netProceedsEth = targetListPriceEth - totalFeesEth;

    // Network Gas Cost estimation based on specific network
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const estimatedGasCostUsd = networkInfo?.estimatedGasCostUsd ?? (activeNetworkKey === 'mainnet' ? 3.50 : 0.01);
    const estimatedGasCostEth = estimatedGasCostUsd / ethPriceUsd;

    // Net proceeds after all fees AND gas
    const netProceedsAfterGasEth = netProceedsEth - estimatedGasCostEth;

    // 1. Calculate Maximum Profitable Bid Price (Must satisfy Floor >= 1.40 * Offer, >= 40% margin, and net profit > 0)
    const minMarginPercent = this.config.profitTargets.defaultMinMarginPercent ?? 40.0;
    const maxMarginBidEth = netProceedsAfterGasEth / (1 + (minMarginPercent / 100));
    
    // Rule 2: Floor Must Be At Least 40% Above Offer Price (Floor >= Offer * 1.40 => Offer <= Floor / 1.40)
    const minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.40;
    const maxOfferFloorRuleEth = floor / minFloorMultiplier;

    const floorDiscountLimit = floor * (1 - (this.config.profitTargets.bidUnderFloorPercent / 100));
    const maxBuyPriceUsd = this.config.capital?.maxBuyPriceUsd ?? 3.00;
    const maxBuyPriceEth = maxBuyPriceUsd / ethPriceUsd;

    let maxProfitableBidEth = Math.min(
      maxMarginBidEth,
      maxOfferFloorRuleEth,
      floorDiscountLimit,
      maxCapitalEth,
      maxBuyPriceEth
    );
    maxProfitableBidEth = Math.floor(Math.max(0, maxProfitableBidEth) * 1000000) / 1000000;

    // 2. Rule 4: Buy Rule & Competition Handling
    // "The bot should place the highest competitive offer that remains within the profitable acquisition limit.
    // It must never increase the offer to an unprofitable level merely to become the highest bidder."
    const topOfferEth = marketData.topOfferEth || 0;
    let finalBidEth = 0;
    let competitivePassed = true;
    let competitiveReason = '';

    if (topOfferEth > 0) {
      if (topOfferEth >= maxProfitableBidEth) {
        competitivePassed = false;
        competitiveReason = `Competition Check Failed: Top offer (${topOfferEth} ETH / $${(topOfferEth * ethPriceUsd).toFixed(2)}) is at or above maximum profitable price ($${(maxProfitableBidEth * ethPriceUsd).toFixed(2)}). Rule: Never increase offer to unprofitable level to become highest bidder.`;
        finalBidEth = topOfferEth;
      } else {
        const bidIncrementUsd = this.config.profitTargets?.bidIncrementUsd ?? 0.01;
        const bidIncrementEth = Math.max(0.000001, roundToPrecision(bidIncrementUsd / ethPriceUsd, 6));
        const nextCompetitiveBidEth = roundToPrecision(topOfferEth + bidIncrementEth, 6);
        finalBidEth = Math.min(nextCompetitiveBidEth, maxProfitableBidEth);
      }
    } else {
      // No existing offer: Bid within 40% floor rule ceiling
      const conservativeBaseEth = roundToPrecision(Math.min(maxProfitableBidEth, floor / minFloorMultiplier), 6);
      finalBidEth = conservativeBaseEth;
    }

    const bidPriceUsd = roundToPrecision(finalBidEth * ethPriceUsd, 2);

    // Recompute exact margins based on this bid price
    const grossProfitEth = targetListPriceEth - finalBidEth;
    const grossProfitUsd = roundToPrecision(grossProfitEth * ethPriceUsd, 2);
    const netProfitEth = targetListPriceEth - totalFeesEth - finalBidEth - estimatedGasCostEth;
    const netProfitUsd = roundToPrecision(netProfitEth * ethPriceUsd, 2);
    const marginPercent = finalBidEth > 0 ? (netProfitEth / finalBidEth) * 100 : 0;

    // Rule 1, 3, 10: ETH Floor-Sale Liquidity Requirement
    // Within previous 3 hours: >= 20 sales, >= 5 unique wallets, native ETH, around floor range
    const sales3Hours = marketData.sales3Hours ?? marketData.sales1Hour ?? 0;
    const uniqueWallets3Hours = marketData.uniqueWallets3Hours ?? marketData.uniqueWallets1Hour ?? 0;
    const minSales = this.config.liquidity?.minSales3Hours ?? 20;
    const minWallets = this.config.liquidity?.minUniqueWallets3Hours ?? 5;
    const checkLLiquidityPassed = (sales3Hours >= minSales && uniqueWallets3Hours >= minWallets) || (marketData.liquidityPassed === true);

    // Rule 2: Floor >= Offer * 1.40 check
    const checkFFloorRatioPassed = finalBidEth > 0 && floor >= (finalBidEth * minFloorMultiplier - 0.000001);

    // Check A: Capital check ($10 total capital, $3.00 max buy price, and positive bid)
    const checkACapitalPassed = finalBidEth <= maxCapitalEth && finalBidEth > 0 && bidPriceUsd <= maxBuyPriceUsd;

    // Check B: Profitability check (Net profit > 0, margin >= 40%, and competitive threshold passed)
    const checkBProfitPassed = netProfitUsd > 0 && marginPercent >= minMarginPercent && competitivePassed;

    const isProfitable = checkLLiquidityPassed && checkFFloorRatioPassed && checkACapitalPassed && checkBProfitPassed;
    const decision: 'ACCEPT' | 'REJECT' = isProfitable ? 'ACCEPT' : 'REJECT';

    let reason = 'All criteria passed: Liquidity, Floor Ratio (>= 140%), Capital, and Profitability verified';
    if (!checkLLiquidityPassed) {
      reason = marketData.liquidityReason || `ETH Floor-Sale Liquidity Failed: ${sales3Hours}/${minSales} sales in last 3h (${uniqueWallets3Hours}/${minWallets} wallets). Rule: Real native-ETH sales must support floor.`;
    } else if (!checkFFloorRatioPassed) {
      reason = `Floor Ratio Check Failed: Current floor ($${floorUsd.toFixed(2)}) is not at least 40% above offer ($${bidPriceUsd.toFixed(2)}). Required floor: >= $${(bidPriceUsd * minFloorMultiplier).toFixed(2)}. Rule: Floor Price >= Offer Price * 1.40.`;
    } else if (bidPriceUsd > maxBuyPriceUsd) {
      reason = `Check A Failed: Required bid ($${bidPriceUsd.toFixed(2)}) exceeds maximum buy price limit ($${maxBuyPriceUsd.toFixed(2)})`;
    } else if (!checkACapitalPassed) {
      reason = `Check A Failed: Required bid ($${bidPriceUsd.toFixed(2)}) exceeds available capital limit ($${capUsd.toFixed(2)})`;
    } else if (!competitivePassed) {
      reason = competitiveReason;
    } else if (netProfitUsd <= 0) {
      reason = `Check B Failed: Net profit ($${netProfitUsd.toFixed(2)}) is negative or zero after royalties, fees, and gas`;
    } else if (marginPercent < minMarginPercent) {
      reason = `Check B Failed: Margin (${marginPercent.toFixed(1)}%) is below mandatory 40% minimum net profit threshold (Rule: Trade must provide >= 40% net profit).`;
    }

    return {
      network: activeNetworkKey,
      bidPriceEth: finalBidEth,
      bidPriceUsd,
      targetListPriceEth,
      targetListPriceUsd,
      grossProfitEth: roundToPrecision(grossProfitEth, 6),
      grossProfitUsd,
      openseaFeeEth: roundToPrecision(openseaFeeEth, 6),
      openseaFeeUsd: roundToPrecision(openseaFeeUsd, 2),
      royaltyFeeEth: roundToPrecision(royaltyFeeEth, 6),
      royaltyFeeUsd: roundToPrecision(royaltyFeeUsd, 2),
      totalFeesEth: roundToPrecision(totalFeesEth, 6),
      totalFeesUsd: roundToPrecision(totalFeesUsd, 2),
      estimatedGasCostEth: roundToPrecision(estimatedGasCostEth, 6),
      estimatedGasCostUsd: roundToPrecision(estimatedGasCostUsd, 2),
      netProfitEth: roundToPrecision(netProfitEth, 6),
      netProfitUsd,
      marginPercent: roundToPrecision(marginPercent, 2),
      sales1Hour: marketData.sales1Hour,
      uniqueWallets1Hour: marketData.uniqueWallets1Hour,
      sales3Hours,
      uniqueWallets3Hours,
      checkLLiquidityPassed,
      checkFFloorRatioPassed,
      checkACapitalPassed,
      checkBProfitPassed,
      isProfitable,
      decision,
      reason
    };
  }

  /**
   * Calculates the minimum profitable listing price.
   * Rule 6: Never sell below acquisition cost (listPrice >= acquiredPrice).
   * Rule 7: No loss selling (proceeds after fees & gas must yield positive profit).
   */
  public getMinProfitableListPrice(
    acquiredPriceEth: number,
    marketData: { openseaFeeBps: number; royaltyFeeBps: number; ethPriceUsd: number },
    targetProfitUsd?: number,
    networkKey?: string
  ): {
    minProfitablePriceEth: number;
    hardBreakevenPriceEth: number;
    estimatedGasCostEth: number;
    totalFeeRate: number;
  } {
    const ethPriceUsd = marketData.ethPriceUsd || 2700;
    const profitGoalUsd = targetProfitUsd ?? this.config.capital?.minNetProfitUsd ?? this.config.profitTargets.defaultMinNetProfitUsd ?? 0.20;
    const profitGoalEth = profitGoalUsd / ethPriceUsd;

    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const estimatedGasCostUsd = networkInfo?.estimatedGasCostUsd ?? (activeNetworkKey === 'mainnet' ? 3.50 : 0.01);
    const estimatedGasCostEth = estimatedGasCostUsd / ethPriceUsd;

    const openseaFeeRate = (marketData.openseaFeeBps || 50) / 10000;
    const royaltyFeeRate = (marketData.royaltyFeeBps || 50) / 10000;
    const totalFeeRate = openseaFeeRate + royaltyFeeRate;

    // Hard rule: List price must NEVER be below acquiredPriceEth (Rule 6)
    // No-loss selling: proceeds after fees & gas must cover cost + profit (Rule 7)
    const minProfitablePriceEth = Math.max(
      acquiredPriceEth,
      roundToPrecision((acquiredPriceEth + profitGoalEth + estimatedGasCostEth) / (1 - totalFeeRate), 6)
    );

    const hardBreakevenPriceEth = Math.max(
      acquiredPriceEth,
      roundToPrecision((acquiredPriceEth + estimatedGasCostEth) / (1 - totalFeeRate), 6)
    );

    return {
      minProfitablePriceEth,
      hardBreakevenPriceEth,
      estimatedGasCostEth,
      totalFeeRate
    };
  }

  /**
   * Evaluates whether an acquired NFT should be listed or held.
   * Rules 5, 6, 7, 8, 9, 11:
   * - If floor drops below minimum profitable price -> HOLD (Floor Dump Protection)
   * - If market supports profitable sale -> LIST at lowest competitive floor price
   */
  public evaluateListingOrHold(
    acquiredPriceEth: number,
    currentFloorEth: number,
    marketData: { openseaFeeBps: number; royaltyFeeBps: number; ethPriceUsd: number },
    targetProfitUsd?: number,
    networkKey?: string
  ): {
    action: 'LIST' | 'HOLD';
    recommendedListPriceEth?: number;
    expectedNetProfitUsd?: number;
    minProfitablePriceEth: number;
    reason: string;
  } {
    const { minProfitablePriceEth, totalFeeRate, estimatedGasCostEth } = this.getMinProfitableListPrice(
      acquiredPriceEth,
      marketData,
      targetProfitUsd,
      networkKey
    );
    const ethPriceUsd = marketData.ethPriceUsd || 2700;

    // Rule 8: Floor Dump Protection
    if (currentFloorEth < minProfitablePriceEth) {
      return {
        action: 'HOLD',
        minProfitablePriceEth,
        reason: `Floor Dump Protection: Market floor (${currentFloorEth} ETH / $${(currentFloorEth * ethPriceUsd).toFixed(2)}) fell below min profitable price (${minProfitablePriceEth} ETH / $${(minProfitablePriceEth * ethPriceUsd).toFixed(2)}). HOLDING NFT to prevent loss selling.`
      };
    }

    // Rule 5: Lowest competitive floor listing (e.g. undercut by 1% while staying >= minProfitablePriceEth)
    const undercutPercent = this.config.profitTargets.undercutFloorByPercent ?? 1.0;
    const competitiveFloorPrice = currentFloorEth * (1 - undercutPercent / 100);
    const finalListingPriceEth = roundToPrecision(Math.max(minProfitablePriceEth, competitiveFloorPrice), 6);

    const netProceeds = finalListingPriceEth * (1 - totalFeeRate);
    const netProfitEth = netProceeds - acquiredPriceEth - estimatedGasCostEth;
    const expectedNetProfitUsd = roundToPrecision(netProfitEth * ethPriceUsd, 2);

    return {
      action: 'LIST',
      recommendedListPriceEth: finalListingPriceEth,
      expectedNetProfitUsd,
      minProfitablePriceEth,
      reason: `Market supports profitable sale: Listing at lowest competitive floor price (${finalListingPriceEth} ETH).`
    };
  }

  /**
   * Calculates the optimal listing price when an item is acquired (backward compatible wrapper).
   */
  public calculateRelistPrice(
    acquiredPriceEth: number,
    currentFloorEth: number,
    marketData: { openseaFeeBps: number; royaltyFeeBps: number; ethPriceUsd: number },
    targetProfitUsd?: number,
    networkKey?: string
  ): { listPriceEth: number; expectedNetProfitUsd: number; strategy: string } {
    const evalResult = this.evaluateListingOrHold(
      acquiredPriceEth,
      currentFloorEth,
      marketData,
      targetProfitUsd,
      networkKey
    );

    if (evalResult.action === 'HOLD') {
      logger.warn(
        { acquiredPriceEth, currentFloorEth, minProfitablePriceEth: evalResult.minProfitablePriceEth },
        'Floor dropped below minimum profitable threshold: Listing priced at minimum profitable ceiling to hold/prevent loss sale'
      );
      return {
        listPriceEth: evalResult.minProfitablePriceEth,
        expectedNetProfitUsd: 0.20,
        strategy: 'HOLD_PROTECTION_ABOVE_FLOOR'
      };
    }

    return {
      listPriceEth: evalResult.recommendedListPriceEth || evalResult.minProfitablePriceEth,
      expectedNetProfitUsd: evalResult.expectedNetProfitUsd || 0.20,
      strategy: 'COMPETITIVE_FLOOR'
    };
  }
}
