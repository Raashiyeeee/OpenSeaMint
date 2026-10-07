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

    // 1. Calculate Maximum Profitable Bid Price (Must yield >= 40% net profit margin and net profit > 0)
    const minMarginPercent = this.config.profitTargets.defaultMinMarginPercent ?? 40.0;
    const maxMarginBidEth = netProceedsAfterGasEth / (1 + (minMarginPercent / 100));
    const floorDiscountLimit = floor * (1 - (this.config.profitTargets.bidUnderFloorPercent / 100));
    const maxBuyPriceUsd = this.config.capital?.maxBuyPriceUsd ?? 3.00;
    const maxBuyPriceEth = maxBuyPriceUsd / ethPriceUsd;

    let maxProfitableBidEth = Math.min(
      maxMarginBidEth,
      floorDiscountLimit,
      maxCapitalEth,
      maxBuyPriceEth
    );
    maxProfitableBidEth = Math.floor(Math.max(0, maxProfitableBidEth) * 1000000) / 1000000;

    // 2. Offer Increment & Top Offer Competition Rule
    // "Always bid just above the current highest valid offer using a small increment. Never jump directly to maximum."
    const topOfferEth = marketData.topOfferEth || 0;
    let finalBidEth = 0;
    let competitivePassed = true;
    let competitiveReason = '';

    if (topOfferEth > 0) {
      const bidIncrementUsd = this.config.profitTargets?.bidIncrementUsd ?? 0.01;
      const bidIncrementEth = Math.max(0.000001, roundToPrecision(bidIncrementUsd / ethPriceUsd, 6));
      const nextCompetitiveBidEth = roundToPrecision(topOfferEth + bidIncrementEth, 6);

      if (nextCompetitiveBidEth > maxProfitableBidEth) {
        competitivePassed = false;
        competitiveReason = `Competition Check Failed: Next competitive offer ($${(nextCompetitiveBidEth * ethPriceUsd).toFixed(2)}) exceeds maximum 40% profitable price ($${(maxProfitableBidEth * ethPriceUsd).toFixed(2)}). Rule: Never sacrifice 40% profit target.`;
        finalBidEth = maxProfitableBidEth;
      } else {
        finalBidEth = nextCompetitiveBidEth;
      }
    } else {
      // No existing offer: Start conservative well under floor and within 40-50% profit ceiling
      const conservativeBaseEth = roundToPrecision(Math.min(maxProfitableBidEth, floor * 0.65), 6);
      finalBidEth = conservativeBaseEth;
    }

    const bidPriceUsd = roundToPrecision(finalBidEth * ethPriceUsd, 2);

    // Recompute exact margins based on this bid price
    const grossProfitEth = targetListPriceEth - finalBidEth;
    const grossProfitUsd = roundToPrecision(grossProfitEth * ethPriceUsd, 2);
    const netProfitEth = targetListPriceEth - totalFeesEth - finalBidEth - estimatedGasCostEth;
    const netProfitUsd = roundToPrecision(netProfitEth * ethPriceUsd, 2);
    const marginPercent = finalBidEth > 0 ? (netProfitEth / finalBidEth) * 100 : 0;

    // Check L: Liquidity Requirement (Mandatory: >= 15 sales in 1h AND >= 4 unique wallets, or verified sustained volume)
    const sales1Hour = marketData.sales1Hour ?? 0;
    const uniqueWallets1Hour = marketData.uniqueWallets1Hour ?? 0;
    const minSales = this.config.liquidity?.minSales1Hour ?? 15;
    const minWallets = this.config.liquidity?.minUniqueWallets1Hour ?? 4;
    const checkLLiquidityPassed = (sales1Hour >= minSales && uniqueWallets1Hour >= minWallets) || (marketData.liquidityPassed === true);

    // Check A: Capital check ($10 total capital, $3.00 max buy price, and positive bid)
    const checkACapitalPassed = finalBidEth <= maxCapitalEth && finalBidEth > 0 && bidPriceUsd <= maxBuyPriceUsd;

    // Check B: Profitability check (Net profit > 0, margin >= 40%, and competitive threshold passed)
    const checkBProfitPassed = netProfitUsd > 0 && marginPercent >= minMarginPercent && competitivePassed;

    const isProfitable = checkLLiquidityPassed && checkACapitalPassed && checkBProfitPassed;
    const decision: 'ACCEPT' | 'REJECT' = isProfitable ? 'ACCEPT' : 'REJECT';

    let reason = 'All criteria passed: Liquidity, Capital, and Profitability verified';
    if (!checkLLiquidityPassed) {
      reason = `Liquidity Check Failed: ${sales1Hour}/${minSales} sales in last 1 hour (${uniqueWallets1Hour}/${minWallets} unique wallets). Rule: Volume is mandatory (Zero/Low-volume rejected)`;
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
      sales1Hour,
      uniqueWallets1Hour,
      checkLLiquidityPassed,
      checkACapitalPassed,
      checkBProfitPassed,
      isProfitable,
      decision,
      reason
    };
  }

  /**
   * Calculates the optimal listing price when an item is acquired.
   * Ensures target profit is captured while remaining competitive at the floor.
   */
  public calculateRelistPrice(
    acquiredPriceEth: number,
    currentFloorEth: number,
    marketData: { openseaFeeBps: number; royaltyFeeBps: number; ethPriceUsd: number },
    targetProfitUsd?: number,
    networkKey?: string
  ): { listPriceEth: number; expectedNetProfitUsd: number; strategy: string } {
    const ethPriceUsd = marketData.ethPriceUsd || 2700;
    const profitGoalUsd = targetProfitUsd ?? this.config.capital?.minNetProfitUsd ?? this.config.profitTargets.defaultMinNetProfitUsd ?? 2.0;
    const profitGoalEth = profitGoalUsd / ethPriceUsd;

    // Gas estimate
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const estimatedGasCostUsd = networkInfo?.estimatedGasCostUsd ?? (activeNetworkKey === 'mainnet' ? 3.50 : 0.01);
    const estimatedGasCostEth = estimatedGasCostUsd / ethPriceUsd;

    const openseaFeeRate = marketData.openseaFeeBps / 10000;
    const royaltyFeeRate = marketData.royaltyFeeBps / 10000;
    const totalFeeRate = openseaFeeRate + royaltyFeeRate;

    // Break-even + target profit required list price including gas:
    // RequiredListPrice = (acquiredPriceEth + profitGoalEth + estimatedGasCostEth) / (1 - totalFeeRate)
    const minRequiredListPrice = (acquiredPriceEth + profitGoalEth + estimatedGasCostEth) / (1 - totalFeeRate);

    // Competitive floor listing (e.g. at or 1% below floor)
    const competitiveFloorPrice = currentFloorEth * (1 - (this.config.profitTargets.undercutFloorByPercent / 100));

    let finalListingPriceEth = Math.max(minRequiredListPrice, competitiveFloorPrice);
    finalListingPriceEth = roundToPrecision(finalListingPriceEth, 6);

    // Calculate expected net profit
    const netProceeds = finalListingPriceEth * (1 - totalFeeRate);
    const netProfitEth = netProceeds - acquiredPriceEth - estimatedGasCostEth;
    const expectedNetProfitUsd = roundToPrecision(netProfitEth * ethPriceUsd, 2);

    let strategy = 'COMPETITIVE_FLOOR';
    if (minRequiredListPrice > competitiveFloorPrice) {
      strategy = 'PROFIT_PRESERVING_ABOVE_FLOOR';
      logger.warn(
        { acquiredPriceEth, currentFloorEth, minRequiredListPrice, competitiveFloorPrice },
        'Floor dropped below ideal spread: listing priced to preserve target profit above current floor'
      );
    }

    return {
      listPriceEth: finalListingPriceEth,
      expectedNetProfitUsd,
      strategy
    };
  }
}
