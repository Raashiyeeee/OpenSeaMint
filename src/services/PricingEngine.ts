import { BotConfig, CollectionMarketData, ProfitCalculationResult } from '../types';
import { roundToPrecision } from '../utils/math';
import { logger } from '../utils/logger';

export class PricingEngine {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /** Hard minimum profit margin (excludes creator fees) required for every offer and listing. */
  public static readonly MIN_NET_MARGIN_PERCENT = 12.0;
  public static readonly TIER1_MAX_PRICE_USD = 4.0;
  public static readonly TIER1_MIN_MARGIN_PERCENT = 30.0;
  public static readonly TIER2_MIN_MARGIN_PERCENT = 12.0;

  /**
   * Effective minimum margin:
   * - NFTs priced up to $4: Minimum 30% expected profit margin before placing an offer.
   * - NFTs priced above $4 and up to $9: The expected profit after creator fee must be at least 12%.
   *   If creator fee is 10%, the expected margin before deducting that fee must be at least 22% (12% + creatorFeePercent).
   * Per-target minMarginPercent can raise the requirement but never weaken the applicable minimum.
   */
  public getMinMarginPercent(
    targetConfigOrOfferUsd?: { minMarginPercent?: number } | number,
    offerPriceUsd?: number,
    creatorFeePercent: number = 0
  ): number {
    let targetConfig: { minMarginPercent?: number } | undefined;
    let priceUsd: number | undefined;

    if (typeof targetConfigOrOfferUsd === 'number') {
      priceUsd = targetConfigOrOfferUsd;
    } else {
      targetConfig = targetConfigOrOfferUsd;
      priceUsd = offerPriceUsd;
    }

    const tier1Max = this.config.profitTargets?.tier1MaxPriceUsd ?? PricingEngine.TIER1_MAX_PRICE_USD;
    const tier1Min = this.config.profitTargets?.tier1MinMarginPercent ?? PricingEngine.TIER1_MIN_MARGIN_PERCENT;
    const baseTier2Min = this.config.profitTargets?.tier2MinMarginPercent ?? this.config.profitTargets?.defaultMinMarginPercent ?? PricingEngine.MIN_NET_MARGIN_PERCENT;

    // Tier 1: $1.00 to $4.00 requires at least 30% margin
    if (priceUsd !== undefined && priceUsd >= 1.0 && priceUsd <= tier1Max) {
      const configured = targetConfig?.minMarginPercent ?? tier1Min;
      return Math.max(configured, tier1Min);
    }

    // Tier 2: > $4.00 to $9.00 requires at least 12% profit after creator fee
    // (e.g. 10% creator fee requires at least 12% + 10% = 22% margin before that fee)
    const effectiveTier2Min = baseTier2Min + (creatorFeePercent || 0);
    const configured = targetConfig?.minMarginPercent ?? effectiveTier2Min;
    return Math.max(configured, effectiveTier2Min);
  }

  /**
   * Minimum Acceptable Floor Price for the applicable margin rule (creator fees excluded from this calculation):
   *   floor * (1 - undercut) * (1 - marketplaceFee) - offer - gas - other = margin * offer
   *   => minFloor = (offer * (1 + margin) + gas + other) / ((1 - undercut) * (1 - marketplaceFee))
   * Mandatory creator fees are evaluated separately via actual net-profit checks.
   * Returns Infinity when marketplace fees make any margin impossible.
   */
  public computeMinAcceptableFloorEth(params: {
    offerEth: number;
    openseaFeeBps: number;
    creatorFeeBps: number; // retained for call-site compat; excluded from this margin floor formula
    gasEth: number;
    otherCostsEth?: number;
    undercutPercent?: number;
    marginPercent?: number;
    ethPriceUsd?: number;
  }): number {
    const offerUsd = params.ethPriceUsd ? params.offerEth * params.ethPriceUsd : undefined;
    // Exclude creator fees from the base margin percentage here per Rule B:
    const margin = (params.marginPercent ?? this.getMinMarginPercent(undefined, offerUsd, 0)) / 100;
    const undercut = (params.undercutPercent ?? this.config.profitTargets?.undercutFloorByPercent ?? 0) / 100;
    // NFT Offer Profitability Rule: exclude creator fees from this specific margin-floor calculation
    const feeRate = params.openseaFeeBps / 10000;
    const denom = (1 - undercut) * (1 - feeRate);
    if (denom <= 0) return Infinity;
    return (params.offerEth * (1 + margin) + params.gasEth + (params.otherCostsEth ?? 0)) / denom;
  }

  /**
   * Evaluates an explicit trade scenario based on USD values and fee percentages.
   * Useful for direct scenario validation (e.g., User Example 5: Bad Trade, Example 6: Profitable Trade).
   */
  public evaluateOfferScenario(params: {
    offerPriceUsd: number;
    floorPriceUsd: number;
    referenceFloorUsd?: number;
    mintCompleted?: boolean;
    royaltyPercent: number; // e.g. 10 for 10%
    marketplaceFeePercent?: number; // e.g. 0.5 for 0.5%
    networkGasUsd?: number;
    otherCostsUsd?: number;
    availableCapitalUsd?: number;
    minNetProfitUsd?: number;
    minOfferPriceUsd?: number;
    liquidityDiscountPercent?: number; // e.g. 0% for exact floor, or 1% undercut
    minFloorMultiplier?: number;
    enforceFloorRatio?: boolean;
    minMarginPercent?: number;
    sales3Hours?: number;
    minSales3Hours?: number;
  }): {
    expectedSaleRevenueUsd: number;
    purchasePriceUsd: number;
    totalCostsUsd: number;
    netProceedsUsd: number;
    royaltyUsd: number;
    creatorFeeUsd: number;
    marketplaceFeeUsd: number;
    gasUsd: number;
    otherCostsUsd: number;
    expectedNetProfitUsd: number;
    marginPercent: number;
    checkACapitalPassed: boolean;
    checkMinOfferPassed: boolean;
    checkBProfitPassed: boolean;
    checkFFloorRatioPassed: boolean;
    checkMintCompletedPassed: boolean;
    checkMarketDumpPassed: boolean;
    checkLiquidityPassed: boolean;
    floorDeclinePercent: number;
    isProfitable: boolean;
    decision: 'ACCEPT' | 'REJECT';
    reason: string;
  } {
    const {
      offerPriceUsd,
      floorPriceUsd,
      referenceFloorUsd,
      mintCompleted = true,
      royaltyPercent,
      marketplaceFeePercent = 0.5,
      networkGasUsd = 0.0,
      otherCostsUsd = 0.0,
      availableCapitalUsd = this.config.capital?.totalTradingCapitalUsd ?? 10.0,
      minNetProfitUsd = this.config.capital?.minNetProfitUsd ?? 0.20,
      minOfferPriceUsd = this.config.capital?.minOfferPriceUsd ?? 1.00,
      liquidityDiscountPercent = 0.0,
      minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.30,
      enforceFloorRatio = true,
      minMarginPercent = params.minMarginPercent !== undefined ? params.minMarginPercent : this.getMinMarginPercent(undefined, offerPriceUsd),
      sales3Hours,
      minSales3Hours = this.config.liquidity?.minSales3Hours ?? 10
    } = params;

    // Realistic resale price factoring liquidity / undercut
    const realisticSalePriceUsd = floorPriceUsd * (1 - liquidityDiscountPercent / 100);
    const expectedSaleRevenueUsd = roundToPrecision(realisticSalePriceUsd, 2);
    const purchasePriceUsd = roundToPrecision(offerPriceUsd, 2);

    // Creator royalty calculation
    const royaltyUsd = roundToPrecision(realisticSalePriceUsd * (royaltyPercent / 100), 2);
    const creatorFeeUsd = royaltyUsd;

    // Marketplace fee calculation
    const marketplaceFeeUsd = roundToPrecision(realisticSalePriceUsd * (marketplaceFeePercent / 100), 2);

    // Gas costs & other costs
    const gasUsd = roundToPrecision(networkGasUsd, 2);
    const extraCostsUsd = roundToPrecision(otherCostsUsd, 2);

    // Actual net profit (includes creator fees when mandatory) — used for trade viability
    const totalCostsUsd = roundToPrecision(
      purchasePriceUsd + creatorFeeUsd + marketplaceFeeUsd + gasUsd + extraCostsUsd,
      2
    );
    const expectedNetProfitUsd = roundToPrecision(expectedSaleRevenueUsd - totalCostsUsd, 2);

    // Net proceeds from sale after royalty & marketplace fees (for backward compatibility)
    const netProceedsUsd = roundToPrecision(realisticSalePriceUsd - royaltyUsd - marketplaceFeeUsd, 2);

    // 12% margin rule: exclude creator fees from this specific profit-margin calculation
    const profitExcludingCreatorUsd = roundToPrecision(
      expectedSaleRevenueUsd - purchasePriceUsd - marketplaceFeeUsd - gasUsd - extraCostsUsd,
      2
    );
    const marginPercent = offerPriceUsd > 0 ? roundToPrecision((profitExcludingCreatorUsd / offerPriceUsd) * 100, 2) : 0;

    // Check A: Capital check
    const checkACapitalPassed = offerPriceUsd <= availableCapitalUsd && offerPriceUsd > 0;

    // Check A2: Minimum Offer Price Rule ($1.00 minimum offer per NFT)
    const checkMinOfferPassed = offerPriceUsd >= minOfferPriceUsd;

    // Check B: 12%+ margin (creator excluded) AND actual net profit after creator fees meets minimum
    const marginCheckPassed = marginPercent >= minMarginPercent;
    const checkBProfitPassed = expectedNetProfitUsd >= minNetProfitUsd && expectedNetProfitUsd > 0 && marginCheckPassed;

    // Check F: Minimum Floor Difference (Formula 1: Floor Price >= Offer Price * 1.30, excluding creator fees from this comparison)
    const checkFFloorRatioPassed = offerPriceUsd > 0 && floorPriceUsd >= (offerPriceUsd * minFloorMultiplier - 0.000001);

    // Condition 1: Incomplete Public Mint Protection
    const checkMintCompletedPassed = mintCompleted !== false;

    // Condition 2: Market Dump Protection
    const refFloorUsd = referenceFloorUsd && referenceFloorUsd > 0 ? referenceFloorUsd : floorPriceUsd;
    const floorDeclinePercent = refFloorUsd > 0 ? roundToPrecision(((refFloorUsd - floorPriceUsd) / refFloorUsd) * 100, 2) : 0;
    const checkMarketDumpPassed = floorDeclinePercent < 40.0;

    // Core rule: High sales volume alone is not enough
    const checkLiquidityPassed = sales3Hours !== undefined ? sales3Hours >= minSales3Hours : true;

    const isProfitable =
      checkACapitalPassed &&
      checkMinOfferPassed &&
      checkBProfitPassed &&
      (enforceFloorRatio ? checkFFloorRatioPassed : true) &&
      checkMintCompletedPassed &&
      checkMarketDumpPassed &&
      checkLiquidityPassed;

    const decision: 'ACCEPT' | 'REJECT' = isProfitable ? 'ACCEPT' : 'REJECT';

    let reason = 'All criteria passed';
    if (!checkMinOfferPassed) {
      reason = `Minimum Offer Price Failed: Proposed offer ($${offerPriceUsd.toFixed(2)}) is below the required minimum offer price of $${minOfferPriceUsd.toFixed(2)}. Offers below $1.00 are strictly prohibited ❌`;
    } else if (!checkMintCompletedPassed) {
      reason = 'Incomplete Public Mint: Public mint has not completed successfully or collection lacks sufficient mint demand. Strict Rejection ❌';
    } else if (!checkMarketDumpPassed) {
      reason = `Market Dump Protection: Floor declined by ${floorDeclinePercent.toFixed(1)}% >= 40% threshold (Reference: $${refFloorUsd.toFixed(2)}, Current: $${floorPriceUsd.toFixed(2)}). Strict Rejection ❌`;
    } else if (!checkLiquidityPassed) {
      reason = `Recent Floor Sales Requirement Failed ❌: Only ${sales3Hours}/${minSales3Hours} completed native ETH floor sales in last 3 hours. High volume required.`;
    } else if (!checkACapitalPassed) {
      reason = `Check A Failed: Required capital ($${offerPriceUsd.toFixed(2)}) exceeds available capital ($${availableCapitalUsd.toFixed(2)})`;
    } else if (expectedNetProfitUsd <= 0) {
      reason = `Check B Failed: Trade yields negative or zero net profit ($${expectedNetProfitUsd.toFixed(2)}) after royalties ($${royaltyUsd.toFixed(2)}), fees ($${marketplaceFeeUsd.toFixed(2)}), and gas ($${gasUsd.toFixed(2)})`;
    } else if (!checkBProfitPassed) {
      reason = `Check B Failed: Expected net profit ($${expectedNetProfitUsd.toFixed(2)}, margin ${marginPercent.toFixed(1)}%) is below minimum threshold ($${minNetProfitUsd.toFixed(2)} / ${minMarginPercent}% margin)`;
    } else if (enforceFloorRatio && !checkFFloorRatioPassed) {
      reason = `Floor Ratio Check Failed: Current floor ($${floorPriceUsd.toFixed(2)}) is not at least ${((minFloorMultiplier - 1) * 100).toFixed(0)}% above offer ($${offerPriceUsd.toFixed(2)}). Formula Floor Price >= Offer Price * ${minFloorMultiplier.toFixed(2)} required (creator fees excluded).`;
    }

    return {
      expectedSaleRevenueUsd,
      purchasePriceUsd,
      totalCostsUsd,
      netProceedsUsd,
      royaltyUsd,
      creatorFeeUsd,
      marketplaceFeeUsd,
      gasUsd,
      otherCostsUsd: extraCostsUsd,
      expectedNetProfitUsd,
      marginPercent,
      checkACapitalPassed,
      checkMinOfferPassed,
      checkBProfitPassed,
      checkFFloorRatioPassed,
      checkMintCompletedPassed,
      checkMarketDumpPassed,
      checkLiquidityPassed,
      floorDeclinePercent,
      isProfitable,
      decision,
      reason
    };
  }

  /**
   * NFT Offer Profitability Rule — Creator Fee Included in Profit Calculation:
   *
   * The bot must calculate the expected net profit, including creator fees and all applicable trading costs,
   * before placing any NFT offer.
   *
   * Mandatory condition: The current floor price must be at least 30% higher than the proposed offer price,
   * excluding creator fees from this specific 30% comparison. However, the bot must separately include creator fees
   * in the net-profit calculation and reject any offer that does not meet the minimum required profit margin.
   *
   * Formula 1 — Floor price requirement:
   *   Floor Price >= Offer Price * 1.30
   *
   * Formula 2 — Net profitability:
   *   Net Profit = Expected Sale Revenue - Total Acquisition and Selling Costs
   *   Total costs must include the purchase price, creator fees, marketplace fees, gas fees, and other applicable costs.
   *
   * Example: If the highest existing offer is $1.00, the bot considers placing an offer of $1.25, and the floor price is $1.50,
   * the bot must not automatically accept this trade. If a 10% creator fee and other costs eliminate the expected profit,
   * the offer must be rejected.
   *
   * Core rule: High sales volume alone is not enough. The bot may place an offer only when the floor-price requirement
   * is satisfied and the trade is expected to generate the required net profit after all applicable fees.
   */
  public evaluateProposedOffer(params: {
    proposedOfferUsd: number;
    currentFloorUsd: number;
    highestExistingOfferUsd?: number;
    creatorFeePercent: number; // e.g. 10 for 10%
    marketplaceFeePercent?: number; // e.g. 0.5 for 0.5%
    estimatedGasUsd?: number;
    otherCostsUsd?: number;
    minNetProfitUsd?: number;
    minMarginPercent?: number;
    sales3Hours?: number;
    minSales3Hours?: number;
    liquidityDiscountPercent?: number;
  }): {
    decision: 'ACCEPT' | 'REJECT';
    isAcceptable: boolean;
    floorRequirementPassed: boolean;
    netProfitabilityPassed: boolean;
    salesVolumePassed: boolean;
    expectedSaleRevenueUsd: number;
    totalAcquisitionAndSellingCostsUsd: number;
    expectedNetProfitUsd: number;
    marginPercent: number;
    requiredFloorUsd: number;
    costsBreakdown: {
      purchasePriceUsd: number;
      creatorFeeUsd: number;
      marketplaceFeeUsd: number;
      gasFeeUsd: number;
      otherCostsUsd: number;
    };
    reason: string;
  } {
    const {
      proposedOfferUsd,
      currentFloorUsd,
      creatorFeePercent,
      marketplaceFeePercent = 0.5,
      estimatedGasUsd = 0.01,
      otherCostsUsd = 0.0,
      minNetProfitUsd = this.config.capital?.minNetProfitUsd ?? 0.20,
      minMarginPercent = params.minMarginPercent !== undefined ? params.minMarginPercent : this.getMinMarginPercent(undefined, proposedOfferUsd),
      sales3Hours,
      minSales3Hours = this.config.liquidity?.minSales3Hours ?? 10,
      liquidityDiscountPercent = 0.0
    } = params;

    // Formula 1 — Floor price requirement:
    // Floor Price >= Offer Price * 1.30 (excluding creator fees from this specific 30% comparison)
    const minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.30;
    const requiredFloorUsd = roundToPrecision(proposedOfferUsd * minFloorMultiplier, 2);
    const floorRequirementPassed = proposedOfferUsd > 0 && currentFloorUsd >= (proposedOfferUsd * minFloorMultiplier - 0.000001);

    // Formula 2 — Net profitability:
    // Net Profit = Expected Sale Revenue - Total Acquisition and Selling Costs
    const realisticSalePriceUsd = currentFloorUsd * (1 - liquidityDiscountPercent / 100);
    const expectedSaleRevenueUsd = roundToPrecision(realisticSalePriceUsd, 2);
    const purchasePriceUsd = roundToPrecision(proposedOfferUsd, 2);
    const creatorFeeUsd = roundToPrecision(realisticSalePriceUsd * (creatorFeePercent / 100), 2);
    const marketplaceFeeUsd = roundToPrecision(realisticSalePriceUsd * (marketplaceFeePercent / 100), 2);
    const gasFeeUsd = roundToPrecision(estimatedGasUsd, 2);
    const extraCostsUsd = roundToPrecision(otherCostsUsd, 2);

    const totalAcquisitionAndSellingCostsUsd = roundToPrecision(
      purchasePriceUsd + creatorFeeUsd + marketplaceFeeUsd + gasFeeUsd + extraCostsUsd,
      2
    );

    const expectedNetProfitUsd = roundToPrecision(expectedSaleRevenueUsd - totalAcquisitionAndSellingCostsUsd, 2);
    // 12% margin rule: exclude creator fees from this specific profit-margin calculation
    const profitExcludingCreatorUsd = roundToPrecision(
      expectedSaleRevenueUsd - purchasePriceUsd - marketplaceFeeUsd - gasFeeUsd - extraCostsUsd,
      2
    );
    const marginPercent = proposedOfferUsd > 0 ? roundToPrecision((profitExcludingCreatorUsd / proposedOfferUsd) * 100, 2) : 0;

    const netProfitabilityPassed =
      expectedNetProfitUsd >= minNetProfitUsd &&
      expectedNetProfitUsd > 0 &&
      marginPercent >= minMarginPercent;

    // Core rule: High sales volume alone is not enough
    const salesVolumePassed = sales3Hours !== undefined ? sales3Hours >= minSales3Hours : true;

    const isAcceptable = floorRequirementPassed && netProfitabilityPassed && salesVolumePassed;
    const decision: 'ACCEPT' | 'REJECT' = isAcceptable ? 'ACCEPT' : 'REJECT';

    let reason = 'Offer meets 30% floor requirement and generates required net profit after all applicable fees.';
    if (!floorRequirementPassed) {
      reason = `Formula 1 Rejected ❌: Floor price ($${currentFloorUsd.toFixed(2)}) is not at least 30% higher than proposed offer ($${proposedOfferUsd.toFixed(2)}). Required Floor >= $${requiredFloorUsd.toFixed(2)} (Floor Price >= Offer Price * 1.30, creator fees excluded from ratio).`;
    } else if (expectedNetProfitUsd <= 0) {
      reason = `Formula 2 Rejected ❌: Trade yields negative or zero net profit ($${expectedNetProfitUsd.toFixed(2)}) after creator fee ($${creatorFeeUsd.toFixed(2)}), marketplace fee ($${marketplaceFeeUsd.toFixed(2)}), and gas ($${gasFeeUsd.toFixed(2)}).`;
    } else if (!netProfitabilityPassed) {
      reason = `Formula 2 Rejected ❌: Expected net profit ($${expectedNetProfitUsd.toFixed(2)}, margin: ${marginPercent.toFixed(1)}%) does not meet minimum profit threshold ($${minNetProfitUsd.toFixed(2)} / ${minMarginPercent}% margin) after creator fee ($${creatorFeeUsd.toFixed(2)}) and all trading costs.`;
    } else if (!salesVolumePassed) {
      reason = `Sales Volume Rejected ❌: Collection has only ${sales3Hours}/${minSales3Hours} floor sales in last 3 hours. High sales volume required.`;
    }

    return {
      decision,
      isAcceptable,
      floorRequirementPassed,
      netProfitabilityPassed,
      salesVolumePassed,
      expectedSaleRevenueUsd,
      totalAcquisitionAndSellingCostsUsd,
      expectedNetProfitUsd,
      marginPercent,
      requiredFloorUsd,
      costsBreakdown: {
        purchasePriceUsd,
        creatorFeeUsd,
        marketplaceFeeUsd,
        gasFeeUsd,
        otherCostsUsd: extraCostsUsd
      },
      reason
    };
  }

  /**
   * Verifies NFT Offer Eligibility Rules:
   * Rule 1. Native ETH Sales: At least 10 completed floor-price sales within the last 3 hours, paid in native ETH. WETH sales must not count.
   * Rule 2. Actual Floor Sales: Genuine completed sales must occur at or around the current floor price. Offer acceptances and WETH sales must not count toward this requirement.
   * Rule 3. Minimum Floor Difference: The current floor price must be at least 30% higher than the bot's offer price.
   *         Formula: "Floor Price >= Offer Price * 1.30"
   * Rule 4. Creator Fee Exclusion: Calculate the 30% floor-to-offer price difference without including creator fees in this specific calculation.
   * Rule 5. Mandatory Rejection: If any condition fails, the bot must not place an offer.
   * Core Rule: Only place offers when there are at least 10 genuine native ETH floor-price sales in the last 3 hours
   * and the current floor is at least 30% above the offer price, excluding creator fees from this comparison.
   */
  public evaluateOfferEligibility(params: {
    floorPriceEth: number;
    offerPriceEth: number;
    sales3HoursNativeEth: number;
    uniqueWallets3Hours?: number;
    minSales3Hours?: number;
    minFloorMultiplier?: number;
  }): {
    eligible: boolean;
    nativeEthFloorSalesPassed: boolean;
    floorDifferencePassed: boolean;
    reason: string;
  } {
    const {
      floorPriceEth,
      offerPriceEth,
      sales3HoursNativeEth,
      minSales3Hours = this.config.liquidity?.minSales3Hours ?? 10,
      minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.30
    } = params;

    const nativeEthFloorSalesPassed = sales3HoursNativeEth >= minSales3Hours;
    // Floor difference calculation compares raw Floor Price to Offer Price directly without creator fees
    const floorDifferencePassed = offerPriceEth > 0 && floorPriceEth >= (offerPriceEth * minFloorMultiplier - 0.000001);

    const eligible = nativeEthFloorSalesPassed && floorDifferencePassed;
    let reason = `All NFT offer eligibility rules passed (10+ native ETH floor sales in 3h & Floor >= Offer * ${minFloorMultiplier.toFixed(2)} without creator fees)`;

    if (!nativeEthFloorSalesPassed) {
      reason = `Mandatory Rejection ❌: Only ${sales3HoursNativeEth}/${minSales3Hours} completed native ETH floor sales in last 3 hours (WETH and offer acceptances excluded).`;
    } else if (!floorDifferencePassed) {
      reason = `Mandatory Rejection ❌: Floor price (${floorPriceEth} ETH) is not at least ${((minFloorMultiplier - 1) * 100).toFixed(0)}% higher than offer price (${offerPriceEth} ETH). Formula Floor Price >= Offer Price * ${minFloorMultiplier.toFixed(2)} required (creator fees excluded).`;
    }

    return {
      eligible,
      nativeEthFloorSalesPassed,
      floorDifferencePassed,
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
    networkKey?: string,
    targetConfig?: any
  ): ProfitCalculationResult {
    const floor = marketData.floorPriceEth;
    const ethPriceUsd = marketData.ethPriceUsd || 2700;
    const floorUsd = roundToPrecision(floor * ethPriceUsd, 2);

    const minNetProfit = targetNetProfitUsd ?? this.config.capital?.minNetProfitUsd ?? this.config.profitTargets.defaultMinNetProfitUsd ?? 0.15;
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
    // Profitability Rule: the FULL applicable (mandatory) creator fee is included in costs.
    // It is never capped down to maxAcceptableRoyaltyBps (that would understate costs); instead,
    // collections whose mandatory creator fee exceeds the acceptable ceiling are rejected below.
    const royaltyFeeRate = Math.max(0, marketData.royaltyFeeBps || 0) / 10000;
    const royaltyWithinCeiling = (marketData.royaltyFeeBps || 0) <= this.config.fees.maxAcceptableRoyaltyBps;
    const totalFeeRate = openseaFeeRate + royaltyFeeRate;

    // Fees on sale
    const openseaFeeEth = targetListPriceEth * openseaFeeRate;
    const openseaFeeUsd = openseaFeeEth * ethPriceUsd;
    const royaltyFeeEth = targetListPriceEth * royaltyFeeRate;
    const royaltyFeeUsd = royaltyFeeEth * ethPriceUsd;
    const totalFeesEth = openseaFeeEth + royaltyFeeEth;
    const totalFeesUsd = totalFeesEth * ethPriceUsd;

    // Net proceeds from sale before gas (includes mandatory creator fee for actual profitability)
    const netProceedsEth = targetListPriceEth - totalFeesEth;
    // Proceeds excluding creator fee — used only for the 12% margin bid ceiling
    const netProceedsExclCreatorEth = targetListPriceEth - openseaFeeEth;

    // Network Gas Cost estimation based on specific network
    const activeNetworkKey = networkKey || this.config.general.network || 'robinhood';
    const networkInfo = this.config.networks?.[activeNetworkKey];
    const estimatedGasCostUsd = networkInfo?.estimatedGasCostUsd ?? (activeNetworkKey === 'mainnet' ? 3.50 : 0.01);
    const estimatedGasCostEth = estimatedGasCostUsd / ethPriceUsd;

    // Net proceeds after all fees AND gas (actual profitability, creator included)
    const netProceedsAfterGasEth = netProceedsEth - estimatedGasCostEth;
    const netProceedsExclCreatorAfterGasEth = netProceedsExclCreatorEth - estimatedGasCostEth;

    // 1. Calculate Maximum Profitable Bid Price
    // Tiered Margin Rule:
    //  - Up to $5.00: expected profit margin >= 30% (creator fees excluded)
    //  - > $5.00 to $9.00: expected profit after creator fee >= 12% (e.g. 10% fee => 22% pre-fee margin)
    const tier1MaxUsd = this.config.profitTargets?.tier1MaxPriceUsd ?? PricingEngine.TIER1_MAX_PRICE_USD;
    const creatorFeePercent = (marketData.royaltyFeeBps || 0) / 100;
    const tier1Margin = this.getMinMarginPercent(targetConfig, tier1MaxUsd, creatorFeePercent);
    const tier2Margin = this.getMinMarginPercent(targetConfig, tier1MaxUsd + 1, creatorFeePercent);

    const maxMarginBidTier1Eth = netProceedsExclCreatorAfterGasEth / (1 + (tier1Margin / 100));
    // Tier 2: net profit AFTER creator fee must be >= 12% of the bid, AND pre-fee margin >= tier2Margin
    const maxMarginBidTier2Eth = Math.min(
      netProceedsAfterGasEth / 1.12,
      netProceedsExclCreatorAfterGasEth / (1 + (tier2Margin / 100))
    );

    const tier1MaxEth = tier1MaxUsd / ethPriceUsd;
    let maxMarginBidEth: number;
    if (maxMarginBidTier2Eth > tier1MaxEth) {
      maxMarginBidEth = maxMarginBidTier2Eth;
    } else {
      maxMarginBidEth = maxMarginBidTier1Eth;
    }
    // Minimum required net profit (USD) ceiling: bid + all costs (incl. creator) + minNetProfit <= expected revenue
    const maxNetProfitBidEth = netProceedsAfterGasEth - targetProfitEth;
    
    // Floor ratio ceiling (Floor Price >= Offer Price * 1.30, excluding creator fees from this comparison)
    const minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.30;
    const maxOfferFloorRuleEth = floor / minFloorMultiplier;

    // Larry's strategy: floor price multiple (e.g. 0.85 = 15% discount)
    const floorMultiple = targetConfig?.floorPriceMultiple ?? (1 - (this.config.profitTargets.bidUnderFloorPercent / 100));
    const floorDiscountLimit = floor * floorMultiple;
    const maxBuyPriceUsd = this.config.capital?.maxBuyPriceUsd ?? 9.00;
    const maxBuyPriceEth = maxBuyPriceUsd / ethPriceUsd;

    let maxProfitableBidEth = Math.min(
      maxMarginBidEth,
      maxNetProfitBidEth,
      maxOfferFloorRuleEth,
      floorDiscountLimit,
      maxCapitalEth,
      maxBuyPriceEth
    );
    maxProfitableBidEth = Math.floor(Math.max(0, maxProfitableBidEth) * 1000000) / 1000000;

    // 2. Buy Rule & Competition Handling
    const topOfferEth = marketData.topOfferEth || 0;
    let finalBidEth = 0;
    let competitivePassed = true;
    let competitiveReason = '';

    if (topOfferEth > 0) {
      if (topOfferEth >= maxProfitableBidEth) {
        if (targetConfig?.floorPriceMultiple) {
          finalBidEth = maxProfitableBidEth;
          competitivePassed = true;
        } else {
          competitivePassed = false;
          competitiveReason = `Competition Check Failed: Top offer (${topOfferEth} ETH / $${(topOfferEth * ethPriceUsd).toFixed(2)}) is at or above maximum profitable price ($${(maxProfitableBidEth * ethPriceUsd).toFixed(2)}).`;
          finalBidEth = topOfferEth;
        }
      } else {
        const bidIncrementUsd = this.config.profitTargets?.bidIncrementUsd ?? 0.01;
        const bidIncrementEth = Math.max(0.000001, roundToPrecision(bidIncrementUsd / ethPriceUsd, 6));
        const nextCompetitiveBidEth = roundToPrecision(topOfferEth + bidIncrementEth, 6);
        finalBidEth = Math.min(nextCompetitiveBidEth, maxProfitableBidEth);
      }
    } else {
      finalBidEth = maxProfitableBidEth;
    }

    // OpenSea Seaport Tick Size Rule:
    // OpenSea enforces bid amounts to be in multiples of 0.0001 ETH with at most 4 decimal places.
    let roundedBidEth = roundToPrecision(finalBidEth, 4);
    if (roundedBidEth > maxProfitableBidEth) {
      roundedBidEth = Math.floor(finalBidEth * 10000) / 10000;
    }
    finalBidEth = roundedBidEth;

    // Top-Priority (#1) after tick rounding: a $0.05 USD bump can round back down to the same 4-decimal
    // price as the competing top (e.g. 0.0011 + ε → 0.0011). Bump by one Seaport tick when needed.
    if (competitivePassed && topOfferEth > 0 && finalBidEth <= topOfferEth + 1e-12) {
      const tickUp = roundToPrecision(Math.floor(topOfferEth * 10000 + 1.0000001) / 10000, 4);
      if (tickUp <= maxProfitableBidEth + 1e-12 && tickUp > topOfferEth + 1e-12) {
        finalBidEth = tickUp;
      } else {
        competitivePassed = false;
        competitiveReason =
          competitiveReason ||
          `Competition Check Failed: Cannot beat top offer (${topOfferEth} ETH) by one Seaport tick (0.0001) within max profitable bid (${maxProfitableBidEth} ETH).`;
        finalBidEth = topOfferEth;
      }
    }

    const bidPriceUsd = roundToPrecision(finalBidEth * ethPriceUsd, 2);

    // Formula 2: Total Acquisition and Selling Costs & Expected Net Profit
    // Net Profit = Expected Sale Revenue - Total Acquisition and Selling Costs
    // Total costs include purchase price, creator fees, marketplace fees, gas fees
    const expectedSaleRevenueEth = targetListPriceEth;
    const expectedSaleRevenueUsd = targetListPriceUsd;
    const purchasePriceEth = finalBidEth;
    const purchasePriceUsd = bidPriceUsd;
    const creatorFeeEth = royaltyFeeEth;
    const creatorFeeUsd = roundToPrecision(creatorFeeEth * ethPriceUsd, 2);
    const openseaFeeUsdAmount = roundToPrecision(openseaFeeEth * ethPriceUsd, 2);
    const estimatedGasCostUsdAmount = roundToPrecision(estimatedGasCostEth * ethPriceUsd, 2);

    const totalCostsEth = purchasePriceEth + creatorFeeEth + openseaFeeEth + estimatedGasCostEth;
    const totalCostsUsd = roundToPrecision(totalCostsEth * ethPriceUsd, 2);

    const grossProfitEth = targetListPriceEth - finalBidEth;
    const grossProfitUsd = roundToPrecision(grossProfitEth * ethPriceUsd, 2);
    const netProfitEth = expectedSaleRevenueEth - totalCostsEth;
    const netProfitUsd = roundToPrecision(netProfitEth * ethPriceUsd, 2);
    // 12% margin rule: exclude creator fees from this specific profit-margin calculation
    const profitExcludingCreatorEth = expectedSaleRevenueEth - purchasePriceEth - openseaFeeEth - estimatedGasCostEth;
    const marginPercent = finalBidEth > 0 ? (profitExcludingCreatorEth / finalBidEth) * 100 : 0;

    // Final Buy Filter (NFT Offer Eligibility Rules & Protections):
    // Rule 1: 10+ completed sales within 3 hours in native ETH (WETH strictly excluded)
    // Rule 2: Genuine completed sales around current floor-price range (offer acceptances excluded)
    // Rule 3: Floor Price >= Offer Price * 1.30 (current floor at least 30% higher than offer)
    // Rule 4: Creator fee excluded from the 30% floor-to-offer price comparison
    // Condition 1: Incomplete Public Mint — Strict Rejection
    // Condition 2: Market Dump Protection — Floor decline < 40%
    // Recent Floor Sales Rule: only the 3-hour native ETH floor-sale count is valid (never fall back to 1h/24h data)
    const sales3Hours = marketData.sales3Hours ?? 0;
    const uniqueWallets3Hours = marketData.uniqueWallets3Hours ?? 0;
    const minSales = this.config.liquidity?.minSales3Hours ?? 10;
    const minWallets = this.config.liquidity?.minUniqueWallets3Hours ?? 5;

    // NFT Recent Floor Sales Requirement:
    // Requires at least 10 completed floor-price sales within last 3 hours using native ETH AND Same-Buyer Activity Filter
    const checkLLiquidityPassed = marketData.liquidityPassed !== false &&
      !marketData.sameBuyerActivityDetected &&
      sales3Hours >= minSales && uniqueWallets3Hours >= minWallets;

    // Formula 1 & Rule 4: Floor difference calculation compares raw Floor Price to Offer Price directly without creator fees (Floor >= Offer * 1.30)
    const checkFFloorRatioPassed = finalBidEth > 0 && floor >= (finalBidEth * minFloorMultiplier - 0.000001);
    const checkACapitalPassed = finalBidEth <= maxCapitalEth && finalBidEth > 0 && bidPriceUsd <= maxBuyPriceUsd;

    // Rule B: Minimum Acceptable Floor Price (tiered margin; creator fees excluded from this specific calc)
    const applicableMinMargin = this.getMinMarginPercent(targetConfig, bidPriceUsd, creatorFeePercent);
    const minAcceptableFloorEth = this.computeMinAcceptableFloorEth({
      offerEth: finalBidEth,
      openseaFeeBps: marketData.openseaFeeBps,
      creatorFeeBps: marketData.royaltyFeeBps || 0,
      gasEth: estimatedGasCostEth,
      undercutPercent: this.config.profitTargets.undercutFloorByPercent,
      marginPercent: applicableMinMargin,
      ethPriceUsd
    });
    const checkMinFloorPassed = finalBidEth > 0 && floor >= minAcceptableFloorEth - 1e-12;

    // Minimum Offer Price Rule ($1.00 minimum offer per NFT)
    const minOfferPriceUsd = this.config.capital?.minOfferPriceUsd ?? 1.00;
    const minOfferPriceEth = minOfferPriceUsd / ethPriceUsd;
    const checkMinOfferPassed = bidPriceUsd >= minOfferPriceUsd && finalBidEth >= (minOfferPriceEth - 0.000001);

    // Check B: Net profit (after purchase price, creator fees, marketplace fees and gas) must meet:
    // 1) Configured minimum net profit USD
    // 2) Applicable profit margin before creator fee (>= 30% for <=$5, >= 12% + creatorFee% for >$5)
    // 3) For >$5 NFTs: expected profit after creator fee must be >= 12%
    const netProfitPercentAfterCreator = finalBidEth > 0 ? (netProfitEth / finalBidEth) * 100 : 0;
    const checkTier2NetPassed = bidPriceUsd <= tier1MaxUsd || netProfitPercentAfterCreator >= 12.0 - 1e-6;

    const checkBProfitPassed =
      netProfitUsd > 0 &&
      netProfitEth >= targetProfitEth - 1e-12 &&
      marginPercent >= applicableMinMargin &&
      checkTier2NetPassed &&
      royaltyWithinCeiling &&
      checkMinFloorPassed &&
      competitivePassed;

    // Condition 1: Incomplete Public Mint Protection
    const mintCheck = this.verifyMintCompletion(marketData);
    const checkMintCompletedPassed = mintCheck.passed;

    // Condition 2: Market Dump Protection
    const refFloorEth = marketData.referenceFloorEth && marketData.referenceFloorEth > 0 ? marketData.referenceFloorEth : floor;
    const floorDeclinePercent = refFloorEth > 0 ? roundToPrecision(((refFloorEth - floor) / refFloorEth) * 100, 2) : 0;
    const checkMarketDumpPassed = floorDeclinePercent < 40.0;

    // Rule 5: Mandatory Rejection if any condition fails
    const isProfitable = checkLLiquidityPassed && checkFFloorRatioPassed && checkACapitalPassed && checkMinOfferPassed && checkBProfitPassed && checkMintCompletedPassed && checkMarketDumpPassed;
    const decision: 'ACCEPT' | 'REJECT' = isProfitable ? 'ACCEPT' : 'REJECT';

    let reason = 'All criteria passed: Liquidity, Floor Ratio, Capital, and Profitability verified';
    if (!checkMinOfferPassed) {
      reason = `Minimum Offer Price Failed: Required bid ($${bidPriceUsd.toFixed(2)}) is below the minimum offer price of $${minOfferPriceUsd.toFixed(2)}. Offers below $1.00 are strictly prohibited ❌`;
    } else if (!checkMintCompletedPassed) {
      reason = mintCheck.reason;
    } else if (!checkMarketDumpPassed) {
      reason = `Market Dump Protection: Floor declined by ${floorDeclinePercent.toFixed(1)}% (Reference: ${refFloorEth} ETH, Current: ${floor} ETH), reaching or exceeding 40% decline limit. Strict Rejection ❌`;
    } else if (marketData.sameBuyerActivityDetected) {
      reason = marketData.liquidityReason || 'Same-Buyer Activity Filter: Only the same buyer has been buying NFTs during the last 30 minutes. Strict Rejection ❌';
    } else if (!checkLLiquidityPassed) {
      reason = marketData.liquidityReason || `Recent Floor Sales Requirement Failed ❌: Only ${sales3Hours}/${minSales} completed native ETH floor sales in the last 3 hours (minimum ${minSales} required, WETH sales and accepted offers excluded).`;
    } else if (!checkFFloorRatioPassed) {
      reason = `Floor Ratio Check Failed: Current floor ($${floorUsd.toFixed(2)}) is not at least ${((minFloorMultiplier - 1) * 100).toFixed(0)}% above offer ($${bidPriceUsd.toFixed(2)}). Formula Floor Price >= Offer Price * ${minFloorMultiplier.toFixed(2)} required (creator fees excluded).`;
    } else if (bidPriceUsd > maxBuyPriceUsd) {
      reason = `Check A Failed: Required bid ($${bidPriceUsd.toFixed(2)}) exceeds maximum buy price limit ($${maxBuyPriceUsd.toFixed(2)})`;
    } else if (!checkACapitalPassed) {
      reason = `Check A Failed: Required bid ($${bidPriceUsd.toFixed(2)}) exceeds available capital limit ($${capUsd.toFixed(2)})`;
    } else if (!competitivePassed) {
      reason = competitiveReason;
    } else if (netProfitUsd <= 0) {
      reason = `Check B Failed: Net profit ($${netProfitUsd.toFixed(2)}) is negative or zero after royalties, fees, and gas`;
    } else if (!checkMinFloorPassed) {
      reason = `Check B Failed: Floor (${floor} ETH) is below the minimum acceptable floor (${roundToPrecision(minAcceptableFloorEth, 8)} ETH) required for a ${applicableMinMargin}% margin after marketplace fee and gas (creator fees excluded from this margin floor).`;
    } else if (!royaltyWithinCeiling) {
      reason = `Check B Failed: Mandatory creator fee (${marketData.royaltyFeeBps} bps) exceeds maximum acceptable creator fee (${this.config.fees.maxAcceptableRoyaltyBps} bps).`;
    } else if (netProfitEth < targetProfitEth - 1e-12) {
      reason = `Check B Failed: Net profit ($${netProfitUsd.toFixed(2)}) is below minimum required net profit ($${minNetProfit.toFixed(2)}) after creator fees, marketplace fees, and gas.`;
    } else if (bidPriceUsd > tier1MaxUsd && !checkTier2NetPassed) {
      reason = `Check B Failed: Profit after creator fee (${netProfitPercentAfterCreator.toFixed(1)}%) is below required minimum (12.0%).`;
    } else if (marginPercent < applicableMinMargin) {
      reason = `Check B Failed: Margin (${marginPercent.toFixed(1)}%, creator fees excluded) is below minimum threshold (${applicableMinMargin}%).`;
    }

    return {
      network: activeNetworkKey,
      currency: marketData.currency || 'ETH',
      bidPriceEth: finalBidEth,
      bidPriceUsd,
      bidPriceUsdg: (marketData.currency === 'USDG') ? bidPriceUsd : undefined,
      targetListPriceEth,
      targetListPriceUsd,
      targetListPriceUsdg: (marketData.currency === 'USDG') ? targetListPriceUsd : undefined,
      expectedSaleRevenueUsd,
      purchasePriceUsd,
      creatorFeeUsd,
      totalCostsUsd,
      grossProfitEth: roundToPrecision(grossProfitEth, 6),
      grossProfitUsd,
      openseaFeeEth: roundToPrecision(openseaFeeEth, 6),
      openseaFeeUsd: openseaFeeUsdAmount,
      royaltyFeeEth: roundToPrecision(royaltyFeeEth, 6),
      royaltyFeeUsd: creatorFeeUsd,
      totalFeesEth: roundToPrecision(totalFeesEth, 6),
      totalFeesUsd: roundToPrecision(totalFeesEth * ethPriceUsd, 2),
      estimatedGasCostEth: roundToPrecision(estimatedGasCostEth, 6),
      estimatedGasCostUsd: estimatedGasCostUsdAmount,
      netProfitEth: roundToPrecision(netProfitEth, 6),
      netProfitUsd,
      marginPercent: roundToPrecision(marginPercent, 2),
      sales1Hour: marketData.sales1Hour,
      uniqueWallets1Hour: marketData.uniqueWallets1Hour,
      sales30Minutes: marketData.sales30Minutes,
      uniqueBuyers30Minutes: marketData.uniqueBuyers30Minutes,
      sameBuyerActivityDetected: marketData.sameBuyerActivityDetected,
      sales3Hours,
      uniqueWallets3Hours,
      checkLLiquidityPassed,
      checkFFloorRatioPassed,
      checkACapitalPassed,
      checkBProfitPassed,
      checkMintCompletedPassed,
      checkMarketDumpPassed,
      floorDeclinePercent,
      minAcceptableFloorEth: Number.isFinite(minAcceptableFloorEth) ? roundToPrecision(minAcceptableFloorEth, 8) : minAcceptableFloorEth,
      checkMinFloorPassed,
      isProfitable,
      decision,
      reason
    };
  }

  /**
   * Condition 1: Incomplete Public Mint — Strict Rejection (100% Mint-Out Rule)
   * 1. Must verify collection's current mint status using reliable, up-to-date data.
   * 2. If collection has not reached 100% of total mint supply, REJECT.
   * 3. Recheck before every offer. If status cannot be verified, DO NOT OFFER.
   * 4. No exceptions or overrides (volume, floor, profit cannot override).
   * 5. Core rule: If mint-out is not 100% complete, DO NOT OFFER.
   */
  public verifyMintCompletion(marketData: CollectionMarketData): {
    passed: boolean;
    reason: string;
  } {
    if (marketData.mintCompleted === false) {
      return {
        passed: false,
        reason: marketData.mintDemandReason || 'Incomplete Collection: Mint has not reached 100% completion. Core rule: If mint-out is not 100% complete, DO NOT OFFER ❌'
      };
    }

    const total = marketData.totalSupply;
    const max = marketData.maxSupply;

    // Reject if public mint is actively ongoing
    if (marketData.isMinting === true) {
      if (max !== undefined && max > 0 && total !== undefined) {
        return {
          passed: false,
          reason: `Incomplete Public Mint: Public mint is still active and supply has not reached 100% (${total}/${max} minted, ${((total / max) * 100).toFixed(1)}%). Core rule: If mint-out is not 100% complete, DO NOT OFFER ❌`
        };
      }
      return {
        passed: false,
        reason: 'Incomplete Public Mint: Public mint is currently active (is_minting: true). Collection is not fully minted out. Core rule: If mint-out is not 100% complete, DO NOT OFFER ❌'
      };
    }

    // Strict 100% supply check: If maxSupply is known, totalSupply MUST be >= maxSupply
    if (max !== undefined && max > 0 && total !== undefined && total < max) {
      return {
        passed: false,
        reason: `Incomplete Collection: Collection has not reached 100% of its total mint supply (${total}/${max} minted, ${((total / max) * 100).toFixed(1)}%). Core rule: If mint-out is not 100% complete, DO NOT OFFER ❌`
      };
    }

    // Unverified mint status rejection (Rule 4: If status cannot be verified, do not place offer).
    // Mint-out must be POSITIVELY verified: explicit verified flag AND known supply with totalSupply >= maxSupply.
    // Missing/unknown supply data is treated as "cannot be verified" -> REJECT.
    if (
      marketData.mintStatusVerified !== true ||
      max === undefined ||
      max <= 0 ||
      total === undefined ||
      total < max
    ) {
      return {
        passed: false,
        reason: 'Incomplete Public Mint: Mint-out status cannot be verified from reliable marketplace data. Core rule: If status cannot be verified, DO NOT OFFER ❌'
      };
    }

    if (marketData.liquidityPassed === false) {
      return {
        passed: false,
        reason: `Mint-Demand / Secondary Demand Failed: Collection lacks verified secondary-market liquidity (${marketData.liquidityReason || 'low volume/diversity'}). Strict Rejection ❌`
      };
    }

    return {
      passed: true,
      reason: '100% Mint-out verified and secondary-market demand confirmed ✅'
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
    // Use ?? so a disabled optional creator fee (0 bps) stays 0 instead of being replaced by a default
    const royaltyFeeRate = (marketData.royaltyFeeBps ?? 50) / 10000;
    const totalFeeRate = openseaFeeRate + royaltyFeeRate;

    // Hard rule: List price must NEVER be below acquiredPriceEth (Rule 6)
    // No-loss selling: proceeds after ALL fees (incl. creator) & gas must cover cost + min net profit
    // Tiered Margin Rule:
    //  - $1.00 to $4.00: minimum list price preserves 30% margin
    //  - > $4.00 to $9.00: minimum list price preserves 12% profit AFTER creator fee
    const acquiredUsd = acquiredPriceEth * ethPriceUsd;
    const tier1MaxUsd = this.config.profitTargets?.tier1MaxPriceUsd ?? PricingEngine.TIER1_MAX_PRICE_USD;
    const creatorFeePercent = (marketData.royaltyFeeBps || 0) / 100;
    const margin = this.getMinMarginPercent(acquiredUsd, undefined, creatorFeePercent) / 100;
    const ceil6 = (v: number) => Math.ceil(v * 1e6 - 1e-9) / 1e6;

    // For >$4 NFTs, 12% profit after creator fee means profitGoal is at least 12% of acquired cost
    const minProfitAfterCreatorEth = acquiredUsd > tier1MaxUsd ? acquiredPriceEth * 0.12 : profitGoalEth;
    const effectiveProfitEth = Math.max(profitGoalEth, minProfitAfterCreatorEth);

    const minProfitablePriceEth = Math.max(
      acquiredPriceEth,
      ceil6((acquiredPriceEth + effectiveProfitEth + estimatedGasCostEth) / (1 - totalFeeRate)),
      ceil6((acquiredPriceEth * (1 + margin) + estimatedGasCostEth) / (1 - openseaFeeRate))
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
   * Evaluates if an NFT qualifies for a Stop-Loss price update based on the floor drop from its purchase price.
   * Stop-Loss Rules:
   * 1. 45% Price Drop: list at current floor and maintain top-priority (#1) listing status.
   * 2. 60% Price Drop: update listing to current floor and regain top-priority (#1) status.
   * 3. 80% Price Drop: update listing to current floor and regain top-priority (#1) status.
   * 4. One-Time Trigger Per Threshold: Each threshold (45%, 60%, 80%) must trigger only once per NFT.
   */
  public getEligibleStopLossThreshold(
    acquiredPriceEth: number,
    currentFloorEth: number,
    alreadyTriggeredThresholds: number[] = []
  ): number | null {
    if (!(acquiredPriceEth > 0) || !(currentFloorEth > 0)) return null;
    const dropPercent = roundToPrecision(((acquiredPriceEth - currentFloorEth) / acquiredPriceEth) * 100, 4);

    if (dropPercent >= 80) {
      return alreadyTriggeredThresholds.includes(80) ? null : 80;
    }
    if (dropPercent >= 60) {
      return alreadyTriggeredThresholds.includes(60) ? null : 60;
    }
    if (dropPercent >= 45) {
      return alreadyTriggeredThresholds.includes(45) ? null : 45;
    }
    return null;
  }

  /**
   * Evaluates whether an acquired NFT should be listed or held.
   * Part 1:
   * 1. Normal Market Conditions: automatically listed at the normal current floor price (undercutting by 1%).
   * 2. When Floor Price Drops: automatically listed within the applicable profit range (minProfitablePriceEth).
   *    Never hold an NFT simply because its floor price has dropped.
   * Part 2 (Stop-Loss Auto-Listing & Top-Priority Rules):
   * 1. At 45% Price Drop: automatically list at current floor and maintain top-priority (#1) listing status.
   * 2. At 60% Price Drop: automatically update listing to current floor and regain top-priority (#1) status.
   * 3. At 80% Price Drop: automatically update listing to current floor and regain top-priority (#1) status.
   * 4. One-Time Trigger Per Threshold: each threshold triggers only once per NFT.
   */
  public evaluateListingOrHold(
    acquiredPriceEth: number,
    currentFloorEth: number,
    marketData: { openseaFeeBps: number; royaltyFeeBps: number; ethPriceUsd: number },
    targetProfitUsd?: number,
    networkKey?: string,
    lowestCompetingListingEth?: number,
    alreadyTriggeredStopLossThresholds?: number[]
  ): {
    action: 'LIST' | 'HOLD';
    recommendedListPriceEth?: number;
    expectedNetProfitUsd?: number;
    minProfitablePriceEth: number;
    reason: string;
    isStopLoss?: boolean;
    stopLossThreshold?: number;
  } {
    const { minProfitablePriceEth, totalFeeRate, estimatedGasCostEth } = this.getMinProfitableListPrice(
      acquiredPriceEth,
      marketData,
      targetProfitUsd,
      networkKey
    );
    const ethPriceUsd = marketData.ethPriceUsd || 2700;

    // Price reference: the lowest COMPETING listing (excluding our own) when known, else the market floor
    const referencePriceEth = lowestCompetingListingEth !== undefined && lowestCompetingListingEth > 0 ? lowestCompetingListingEth : currentFloorEth;

    // Check Stop-Loss Auto-Listing & Top-Priority Rules (45%, 60%, 80% drops)
    const stopLossThreshold = this.getEligibleStopLossThreshold(
      acquiredPriceEth,
      referencePriceEth,
      alreadyTriggeredStopLossThresholds
    );

    const undercutPercent = this.config.profitTargets.undercutFloorByPercent ?? 1.0;

    if (stopLossThreshold !== null) {
      const stopLossPriceEth = referencePriceEth > 0
        ? Math.max(0.000001, Math.floor(referencePriceEth * (1 - undercutPercent / 100) * 1e6) / 1e6)
        : Math.floor(acquiredPriceEth * (1 - stopLossThreshold / 100) * 1e6) / 1e6;

      const netProceeds = stopLossPriceEth * (1 - totalFeeRate);
      const netProfitEth = netProceeds - acquiredPriceEth - estimatedGasCostEth;
      const expectedNetProfitUsd = roundToPrecision(netProfitEth * ethPriceUsd, 2);

      return {
        action: 'LIST',
        recommendedListPriceEth: stopLossPriceEth,
        expectedNetProfitUsd,
        minProfitablePriceEth,
        reason: `Stop-Loss Rule Triggered (${stopLossThreshold}% price drop): Listing at current floor (${stopLossPriceEth} ETH) to maintain top-priority (#1) status.`,
        isStopLoss: true,
        stopLossThreshold
      };
    }

    // Lowest competitive floor listing (e.g. undercut by 1% while staying >= minProfitablePriceEth)
    const competitiveFloorPrice = referencePriceEth > 0 ? referencePriceEth * (1 - undercutPercent / 100) : minProfitablePriceEth;
    // Round DOWN to stay strictly below the competitor, but never below the minimum profitable price
    const finalListingPriceEth = Math.max(minProfitablePriceEth, Math.floor(competitiveFloorPrice * 1e6) / 1e6);

    const netProceeds = finalListingPriceEth * (1 - totalFeeRate);
    const netProfitEth = netProceeds - acquiredPriceEth - estimatedGasCostEth;
    const expectedNetProfitUsd = roundToPrecision(netProfitEth * ethPriceUsd, 2);

    const isFloorDropped = referencePriceEth > 0 && competitiveFloorPrice < minProfitablePriceEth;
    const reason = isFloorDropped
      ? `Floor price dropped below cost: Listing within configured profit range at ${finalListingPriceEth} ETH.`
      : `Market supports profitable sale: Listing at lowest competitive floor price (${finalListingPriceEth} ETH).`;

    return {
      action: 'LIST',
      recommendedListPriceEth: finalListingPriceEth,
      expectedNetProfitUsd,
      minProfitablePriceEth,
      reason,
      isStopLoss: false
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
