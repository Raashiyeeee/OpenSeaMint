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
    referenceFloorUsd?: number;
    mintCompleted?: boolean;
    royaltyPercent: number; // e.g. 10 for 10%
    marketplaceFeePercent?: number; // e.g. 0.5 for 0.5%
    networkGasUsd?: number;
    availableCapitalUsd?: number;
    minNetProfitUsd?: number;
    minOfferPriceUsd?: number;
    liquidityDiscountPercent?: number; // e.g. 0% for exact floor, or 1% undercut
    minFloorMultiplier?: number;
    enforceFloorRatio?: boolean;
  }): {
    netProceedsUsd: number;
    royaltyUsd: number;
    marketplaceFeeUsd: number;
    gasUsd: number;
    expectedNetProfitUsd: number;
    checkACapitalPassed: boolean;
    checkMinOfferPassed: boolean;
    checkBProfitPassed: boolean;
    checkFFloorRatioPassed: boolean;
    checkMintCompletedPassed: boolean;
    checkMarketDumpPassed: boolean;
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
      availableCapitalUsd = this.config.capital?.totalTradingCapitalUsd ?? 10.0,
      minNetProfitUsd = this.config.capital?.minNetProfitUsd ?? 2.0,
      minOfferPriceUsd = this.config.capital?.minOfferPriceUsd ?? 1.00,
      liquidityDiscountPercent = 0.0,
      minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.40,
      enforceFloorRatio = false
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

    // Check A2: Minimum Offer Price Rule ($1.00 minimum offer per NFT)
    const checkMinOfferPassed = offerPriceUsd >= minOfferPriceUsd;

    // Check B: Profitability check
    const checkBProfitPassed = expectedNetProfitUsd >= minNetProfitUsd && expectedNetProfitUsd > 0;

    // Check F: Minimum Floor Difference (Formula: Floor Price >= Offer Price * 1.40, excluding creator fees from this comparison)
    const checkFFloorRatioPassed = offerPriceUsd > 0 && floorPriceUsd >= (offerPriceUsd * minFloorMultiplier - 0.000001);

    // Condition 1: Incomplete Public Mint Protection
    const checkMintCompletedPassed = mintCompleted !== false;

    // Condition 2: Market Dump Protection
    const refFloorUsd = referenceFloorUsd && referenceFloorUsd > 0 ? referenceFloorUsd : floorPriceUsd;
    const floorDeclinePercent = refFloorUsd > 0 ? roundToPrecision(((refFloorUsd - floorPriceUsd) / refFloorUsd) * 100, 2) : 0;
    const checkMarketDumpPassed = floorDeclinePercent < 40.0;

    const isProfitable = checkACapitalPassed && checkMinOfferPassed && checkBProfitPassed && (enforceFloorRatio ? checkFFloorRatioPassed : true) && checkMintCompletedPassed && checkMarketDumpPassed;
    const decision: 'ACCEPT' | 'REJECT' = isProfitable ? 'ACCEPT' : 'REJECT';

    let reason = 'All criteria passed';
    if (!checkMinOfferPassed) {
      reason = `Minimum Offer Price Failed: Proposed offer ($${offerPriceUsd.toFixed(2)}) is below the required minimum offer price of $${minOfferPriceUsd.toFixed(2)}. Offers below $1.00 are strictly prohibited ❌`;
    } else if (!checkMintCompletedPassed) {
      reason = 'Incomplete Public Mint: Public mint has not completed successfully or collection lacks sufficient mint demand. Strict Rejection ❌';
    } else if (!checkMarketDumpPassed) {
      reason = `Market Dump Protection: Floor declined by ${floorDeclinePercent.toFixed(1)}% >= 40% threshold (Reference: $${refFloorUsd.toFixed(2)}, Current: $${floorPriceUsd.toFixed(2)}). Strict Rejection ❌`;
    } else if (!checkACapitalPassed) {
      reason = `Check A Failed: Required capital ($${offerPriceUsd.toFixed(2)}) exceeds available capital ($${availableCapitalUsd.toFixed(2)})`;
    } else if (expectedNetProfitUsd <= 0) {
      reason = `Check B Failed: Trade yields negative or zero net profit ($${expectedNetProfitUsd.toFixed(2)}) after royalties ($${royaltyUsd.toFixed(2)}), fees ($${marketplaceFeeUsd.toFixed(2)}), and gas ($${gasUsd.toFixed(2)})`;
    } else if (!checkBProfitPassed) {
      reason = `Check B Failed: Expected net profit ($${expectedNetProfitUsd.toFixed(2)}) is below minimum threshold ($${minNetProfitUsd.toFixed(2)})`;
    } else if (enforceFloorRatio && !checkFFloorRatioPassed) {
      reason = `Floor Ratio Check Failed: Current floor ($${floorPriceUsd.toFixed(2)}) is not at least ${((minFloorMultiplier - 1) * 100).toFixed(0)}% above offer ($${offerPriceUsd.toFixed(2)}). Formula Floor Price >= Offer Price * ${minFloorMultiplier.toFixed(2)} required (creator fees excluded).`;
    }

    return {
      netProceedsUsd: roundToPrecision(netProceedsUsd, 2),
      royaltyUsd: roundToPrecision(royaltyUsd, 2),
      marketplaceFeeUsd: roundToPrecision(marketplaceFeeUsd, 2),
      gasUsd: roundToPrecision(gasUsd, 2),
      expectedNetProfitUsd: roundToPrecision(expectedNetProfitUsd, 2),
      checkACapitalPassed,
      checkMinOfferPassed,
      checkBProfitPassed,
      checkFFloorRatioPassed,
      checkMintCompletedPassed,
      checkMarketDumpPassed,
      floorDeclinePercent,
      isProfitable,
      decision,
      reason
    };
  }

  /**
   * Verifies NFT Offer Eligibility Rules:
   * Rule 1. Native ETH Sales: At least 10 completed floor-price sales within the last 3 hours, paid in native ETH. WETH sales must not count.
   * Rule 2. Actual Floor Sales: Genuine completed sales must occur at or around the current floor price. Offer acceptances and WETH sales must not count toward this requirement.
   * Rule 3. Minimum Floor Difference: The current floor price must be at least 40% higher than the bot's offer price.
   *         Formula: "Floor Price >= Offer Price * 1.40"
   * Rule 4. Creator Fee Exclusion: Calculate the 40% floor-to-offer price difference without including creator fees in this specific calculation.
   * Rule 5. Mandatory Rejection: If any condition fails, the bot must not place an offer.
   * Core Rule: Only place offers when there are at least 10 genuine native ETH floor-price sales in the last 3 hours
   * and the current floor is at least 40% above the offer price, excluding creator fees from this comparison.
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
      minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.40
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

    // 1. Calculate Maximum Profitable Bid Price
    const minMarginPercent = targetConfig?.minMarginPercent ?? this.config.profitTargets.defaultMinMarginPercent ?? 15.0;
    const maxMarginBidEth = netProceedsAfterGasEth / (1 + (minMarginPercent / 100));
    
    // Floor ratio ceiling (Floor Price >= Offer Price * 1.40, excluding creator fees from this comparison)
    const minFloorMultiplier = this.config.liquidity?.minFloorMultiplier ?? 1.40;
    const maxOfferFloorRuleEth = floor / minFloorMultiplier;

    // Larry's strategy: floor price multiple (e.g. 0.85 = 15% discount)
    const floorMultiple = targetConfig?.floorPriceMultiple ?? (1 - (this.config.profitTargets.bidUnderFloorPercent / 100));
    const floorDiscountLimit = floor * floorMultiple;
    const maxBuyPriceUsd = this.config.capital?.maxBuyPriceUsd ?? 5.00;
    const maxBuyPriceEth = maxBuyPriceUsd / ethPriceUsd;

    let maxProfitableBidEth = Math.min(
      maxMarginBidEth,
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

    const bidPriceUsd = roundToPrecision(finalBidEth * ethPriceUsd, 2);

    // Recompute exact margins based on this bid price
    const grossProfitEth = targetListPriceEth - finalBidEth;
    const grossProfitUsd = roundToPrecision(grossProfitEth * ethPriceUsd, 2);
    const netProfitEth = targetListPriceEth - totalFeesEth - finalBidEth - estimatedGasCostEth;
    const netProfitUsd = roundToPrecision(netProfitEth * ethPriceUsd, 2);
    const marginPercent = finalBidEth > 0 ? (netProfitEth / finalBidEth) * 100 : 0;

    // Final Buy Filter (NFT Offer Eligibility Rules & Protections):
    // Rule 1: 10+ completed sales within 3 hours in native ETH (WETH strictly excluded)
    // Rule 2: Genuine completed sales around current floor-price range (offer acceptances excluded)
    // Rule 3: Floor Price >= Offer Price * 1.40 (current floor at least 40% higher than offer)
    // Rule 4: Creator fee excluded from the 40% floor-to-offer price comparison
    // Condition 1: Incomplete Public Mint — Strict Rejection
    // Condition 2: Market Dump Protection — Floor decline < 40%
    const sales3Hours = marketData.sales3Hours ?? marketData.sales1Hour ?? 0;
    const uniqueWallets3Hours = marketData.uniqueWallets3Hours ?? marketData.uniqueWallets1Hour ?? 0;
    const minSales = this.config.liquidity?.minSales3Hours ?? 10;
    const minWallets = this.config.liquidity?.minUniqueWallets3Hours ?? 5;

    const checkLLiquidityPassed = marketData.liquidityPassed !== false &&
      (sales3Hours >= minSales && uniqueWallets3Hours >= minWallets);

    // Rule 3 & 4: Floor difference calculation compares raw Floor Price to Offer Price directly without creator fees
    const checkFFloorRatioPassed = finalBidEth > 0 && floor >= (finalBidEth * minFloorMultiplier - 0.000001);
    const checkACapitalPassed = finalBidEth <= maxCapitalEth && finalBidEth > 0 && bidPriceUsd <= maxBuyPriceUsd;

    // Minimum Offer Price Rule ($1.00 minimum offer per NFT)
    const minOfferPriceUsd = this.config.capital?.minOfferPriceUsd ?? 1.00;
    const minOfferPriceEth = minOfferPriceUsd / ethPriceUsd;
    const checkMinOfferPassed = bidPriceUsd >= minOfferPriceUsd && finalBidEth >= (minOfferPriceEth - 0.000001);

    const checkBProfitPassed = netProfitUsd > 0 && marginPercent >= (minMarginPercent - 0.5) && competitivePassed;

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
    } else if (!checkLLiquidityPassed) {
      reason = marketData.liquidityReason || `Liquidity Check Failed: ${sales3Hours}/${minSales} qualified floor sales in last 3h, ${uniqueWallets3Hours}/${minWallets} unique wallets (offer sales excluded).`;
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
    } else if (marginPercent < minMarginPercent) {
      reason = `Check B Failed: Margin (${marginPercent.toFixed(1)}%) is below minimum net profit threshold (${minMarginPercent}%).`;
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
      checkMintCompletedPassed,
      checkMarketDumpPassed,
      floorDeclinePercent,
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

    // Unverified mint status rejection (Rule 4: If status cannot be verified, do not place offer)
    if (marketData.mintStatusVerified === false) {
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

    // Rule 8: Floor Dump Protection (only applies if an active market floor exists > 0)
    if (currentFloorEth > 0 && currentFloorEth < minProfitablePriceEth) {
      return {
        action: 'HOLD',
        minProfitablePriceEth,
        reason: `Floor Dump Protection: Market floor (${currentFloorEth} ETH / $${(currentFloorEth * ethPriceUsd).toFixed(2)}) fell below min profitable price (${minProfitablePriceEth} ETH / $${(minProfitablePriceEth * ethPriceUsd).toFixed(2)}). HOLDING NFT to prevent loss selling.`
      };
    }

    // Rule 5: Lowest competitive floor listing (e.g. undercut by 1% while staying >= minProfitablePriceEth)
    const undercutPercent = this.config.profitTargets.undercutFloorByPercent ?? 1.0;
    const competitiveFloorPrice = currentFloorEth > 0 ? currentFloorEth * (1 - undercutPercent / 100) : minProfitablePriceEth;
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
