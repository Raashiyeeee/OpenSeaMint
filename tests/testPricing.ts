import assert from 'assert';
import { PricingEngine } from '../src/services/PricingEngine';
import { InventoryManager } from '../src/services/InventoryManager';
import { loadConfig } from '../src/config/schema';
import { CollectionMarketData } from '../src/types';

console.log('================================================================');
console.log('Running OpenSea Bot Capital & Profitability Rule Tests');
console.log('================================================================\n');

const config = loadConfig();
const pricingEngine = new PricingEngine(config);

// --------------------------------------------------------------------------
// TEST 1: User Example 5 - Bad Trade (Loss before fees)
// Offer: $10, Floor: $11, Creator Royalty: 10%
// Resale at $11 - 10% royalty = $9.90 -> $9.90 - $10 = -$0.10 loss -> REJECT
// --------------------------------------------------------------------------
console.log('--- Test 1: Bad Trade Scenario (Example 5) ---');
const badTrade = pricingEngine.evaluateOfferScenario({
  offerPriceUsd: 10.0,
  floorPriceUsd: 11.0,
  royaltyPercent: 10.0,
  marketplaceFeePercent: 0.5,
  networkGasUsd: 0.01,
  availableCapitalUsd: 10.0,
  minNetProfitUsd: 2.0
});

console.log('Bad Trade Evaluation:', badTrade);
assert.strictEqual(badTrade.decision, 'REJECT', 'Bad trade must be rejected');
assert.strictEqual(badTrade.isProfitable, false, 'Bad trade must not be marked profitable');
assert.strictEqual(badTrade.checkBProfitPassed, false, 'Check B must fail due to negative profit');
console.log('Test 1 PASSED: Bad trade successfully rejected with reason:', badTrade.reason, '\n');

// --------------------------------------------------------------------------
// TEST 2: User Example 6 - Potentially Profitable Trade
// Offer: $10, Realistic Sale: $15, Royalty: 5%
// Royalty: $0.75, Net after royalty: $14.25, Fee (0.5%): $0.075, Gas: $0.01
// Expected Net Profit: ~$4.165 >= $2 -> ACCEPT
// --------------------------------------------------------------------------
console.log('--- Test 2: Profitable Trade Scenario (Example 6) ---');
const goodTrade = pricingEngine.evaluateOfferScenario({
  offerPriceUsd: 10.0,
  floorPriceUsd: 15.0,
  royaltyPercent: 5.0,
  marketplaceFeePercent: 0.5,
  networkGasUsd: 0.01,
  availableCapitalUsd: 10.0,
  minNetProfitUsd: 2.0
});

console.log('Good Trade Evaluation:', goodTrade);
assert.strictEqual(goodTrade.decision, 'ACCEPT', 'Profitable trade must be accepted');
assert.strictEqual(goodTrade.isProfitable, true, 'Trade must be marked profitable');
assert.strictEqual(goodTrade.checkACapitalPassed, true, 'Check A (Capital) must pass');
assert.strictEqual(goodTrade.checkBProfitPassed, true, 'Check B (Profit) must pass');
assert(goodTrade.expectedNetProfitUsd >= 2.0, 'Net profit must exceed $2 threshold');
console.log('Test 2 PASSED: Profitable trade successfully accepted with net profit: $' + goodTrade.expectedNetProfitUsd, '\n');

// --------------------------------------------------------------------------
// TEST 3: Profit Safety Margin Rule ($0.20 profit when MIN_NET_PROFIT = $2)
// Small profit must be rejected to prevent fee/gas slippage from turning trade negative
// --------------------------------------------------------------------------
console.log('--- Test 3: Profit Below Minimum Threshold ($0.20 vs $2 MIN_NET_PROFIT) ---');
const thinMarginTrade = pricingEngine.evaluateOfferScenario({
  offerPriceUsd: 10.0,
  floorPriceUsd: 10.80,
  royaltyPercent: 5.0,
  marketplaceFeePercent: 0.5,
  networkGasUsd: 0.01,
  availableCapitalUsd: 10.0,
  minNetProfitUsd: 2.0
});

console.log('Thin Margin Evaluation:', thinMarginTrade);
assert.strictEqual(thinMarginTrade.decision, 'REJECT', 'Thin margin trade must be rejected');
assert.strictEqual(thinMarginTrade.checkBProfitPassed, false, 'Check B must fail when profit < $2');
console.log('Test 3 PASSED: Thin margin trade correctly rejected: ' + thinMarginTrade.reason, '\n');

// --------------------------------------------------------------------------
// TEST 4: Capital Constraint Check A (Offer exceeds available capital)
// Attempting $12 offer with $10 total capital -> REJECT
// --------------------------------------------------------------------------
console.log('--- Test 4: Capital Limit Check (Check A) ---');
const capitalExceededTrade = pricingEngine.evaluateOfferScenario({
  offerPriceUsd: 12.0,
  floorPriceUsd: 18.0,
  royaltyPercent: 5.0,
  availableCapitalUsd: 10.0,
  minNetProfitUsd: 2.0
});

console.log('Capital Exceeded Evaluation:', capitalExceededTrade);
assert.strictEqual(capitalExceededTrade.decision, 'REJECT', 'Trade exceeding capital must be rejected');
assert.strictEqual(capitalExceededTrade.checkACapitalPassed, false, 'Check A must fail');
console.log('Test 4 PASSED: Capital limit check correctly failed: ' + capitalExceededTrade.reason, '\n');

// --------------------------------------------------------------------------
// TEST 5: Single Active Trade Rule & Capital Locking / Release
// Bot has $10 capital. Only 1 active trade at a time.
// --------------------------------------------------------------------------
console.log('--- Test 5: Single Active Trade & Capital Lifecycle in InventoryManager ---');
const inventoryManager = new InventoryManager(config);

assert.strictEqual(inventoryManager.getTotalCapitalUsd(), 10.0, 'Total capital must be $10');
assert.strictEqual(inventoryManager.getAvailableCapitalUsd(), 10.0, 'Available capital must start at $10');

// Place first offer (locks capital)
inventoryManager.registerActiveOffer({
  orderHash: 'offer_1',
  collectionSlug: 'robinhood-early-pass',
  contractAddress: '0xa5c0bd78d1667c13bfb403e2a3336871396713c5',
  priceEth: 0.0035,
  priceUsd: 9.45,
  createdTimestamp: Date.now(),
  expiresTimestamp: Date.now() + 3600000,
  status: 'ACTIVE'
});

// Attempting second trade must be blocked!
const secondTradeCheck = inventoryManager.canAllocateCapital(9.45);
assert.strictEqual(secondTradeCheck.allowed, false, 'Second trade must be blocked by single active trade constraint');
console.log('Second trade blocked as expected:', secondTradeCheck.reason);

// Now simulate NFT acquired & then sold for $14
const saleResult = inventoryManager.markItemSold(
  '0xa5c0bd78d1667c13bfb403e2a3336871396713c5:1',
  0.0052, // ~$14.04
  2700,
  100, // 1% fee
  0.01 // gas
);

// Release capital and verify ready for next trade
assert(saleResult.newTotalCapitalUsd >= 10.0, 'Capital after sale must be updated with profit');
console.log('Sale completed: Capital released, new balance: $' + saleResult.newTotalCapitalUsd);
console.log('Test 5 PASSED: Capital lock and release lifecycle verified!\n');

// --------------------------------------------------------------------------
// TEST 6: Network Gas Impact: Robinhood Chain vs Ethereum Mainnet
// Robinhood Chain gas ($0.01) vs Ethereum Mainnet gas ($3.50) on $10 trade
// --------------------------------------------------------------------------
console.log('--- Test 6: Network Gas Comparison on $10 Trade ---');
const rhTrade = pricingEngine.evaluateOfferScenario({
  offerPriceUsd: 10.0,
  floorPriceUsd: 13.0,
  royaltyPercent: 5.0,
  marketplaceFeePercent: 0.5,
  networkGasUsd: 0.01, // Robinhood Chain low gas
  availableCapitalUsd: 10.0,
  minNetProfitUsd: 2.0
});

const ethMainnetTrade = pricingEngine.evaluateOfferScenario({
  offerPriceUsd: 10.0,
  floorPriceUsd: 13.0,
  royaltyPercent: 5.0,
  marketplaceFeePercent: 0.5,
  networkGasUsd: 3.50, // Ethereum Mainnet high gas
  availableCapitalUsd: 10.0,
  minNetProfitUsd: 2.0
});

console.log('Robinhood Chain Trade Profit: $' + rhTrade.expectedNetProfitUsd, '-> Decision:', rhTrade.decision);
console.log('Ethereum Mainnet Trade Profit: $' + ethMainnetTrade.expectedNetProfitUsd, '-> Decision:', ethMainnetTrade.decision);

assert.strictEqual(rhTrade.decision, 'ACCEPT', 'Robinhood chain with low gas allows profitable $10 trade');
assert.strictEqual(ethMainnetTrade.decision, 'REJECT', 'Ethereum Mainnet with high gas correctly rejects eroded trade');
// --------------------------------------------------------------------------
// TEST 7: Liquidity Requirement Rule
// Rule: >= 15 completed sales in 1 hour AND >= 4 unique wallets.
// Low-volume or single-wallet wash trading must automatically be rejected!
// --------------------------------------------------------------------------
console.log('--- Test 7: Liquidity Requirement (15 Sales, 4 Unique Wallets) ---');

// Case 7a: Low volume (only 5 sales, 2 wallets) -> REJECT
const lowVolumeData: CollectionMarketData = {
  slug: 'low-volume-nft',
  contractAddress: '0x1111111111111111111111111111111111111111',
  floorPriceEth: 0.005,
  topOfferEth: 0.003,
  numListings: 10,
  openseaFeeBps: 100,
  royaltyFeeBps: 50,
  ethPriceUsd: 2700,
  timestamp: Date.now(),
  sales1Hour: 5,
  uniqueWallets1Hour: 2,
  liquidityPassed: false
};
const lowVolCalc = pricingEngine.calculateMaxBid(lowVolumeData, 2.0, 10.0, 'robinhood');
assert.strictEqual(lowVolCalc.decision, 'REJECT', 'Low-volume collection must be rejected');
assert.strictEqual(lowVolCalc.checkLLiquidityPassed, false, 'Check L must fail when sales < 15');
console.log('Case 7a PASSED: Low volume collection rejected: ' + lowVolCalc.reason);

// Case 7b: Wash trading / concentrated activity (16 sales, but only 1 wallet) -> REJECT
const washTradingData: CollectionMarketData = {
  slug: 'wash-trade-nft',
  contractAddress: '0x2222222222222222222222222222222222222222',
  floorPriceEth: 0.005,
  topOfferEth: 0.003,
  numListings: 10,
  openseaFeeBps: 100,
  royaltyFeeBps: 50,
  ethPriceUsd: 2700,
  timestamp: Date.now(),
  sales1Hour: 16,
  uniqueWallets1Hour: 1, // Only 1 wallet!
  liquidityPassed: false
};
const washCalc = pricingEngine.calculateMaxBid(washTradingData, 2.0, 10.0, 'robinhood');
assert.strictEqual(washCalc.decision, 'REJECT', 'Single-wallet wash trading must be rejected');
assert.strictEqual(washCalc.checkLLiquidityPassed, false, 'Check L must fail when unique wallets < 4');
console.log('Case 7b PASSED: Concentrated single-wallet volume rejected: ' + washCalc.reason);

// Case 7c: Genuine Liquid Collection (25 sales, 12 unique wallets) -> Liquidity PASSES
const liquidData: CollectionMarketData = {
  slug: 'liquid-nft',
  contractAddress: '0x3333333333333333333333333333333333333333',
  floorPriceEth: 0.005,
  topOfferEth: 0.003,
  numListings: 10,
  openseaFeeBps: 100,
  royaltyFeeBps: 50,
  ethPriceUsd: 2700,
  timestamp: Date.now(),
  sales1Hour: 25,
  uniqueWallets1Hour: 12,
  liquidityPassed: true
};
const liquidCalc = pricingEngine.calculateMaxBid(liquidData, 2.0, 10.0, 'robinhood');
assert.strictEqual(liquidCalc.checkLLiquidityPassed, true, 'Check L must pass for genuine liquid activity');
console.log('Case 7c PASSED: Genuine liquid collection passed Check L!\n');

// --------------------------------------------------------------------------
// TEST 8: Minimum 13% Price Advantage & Profit Percentage Rule
// Expected resale must be >= 13% above offer price and yield >= $2 profit.
// --------------------------------------------------------------------------
console.log('--- Test 8: Minimum 13% Price Advantage & Profit Percentage Rule ---');
const highMarginData: CollectionMarketData = {
  slug: 'high-margin-nft',
  contractAddress: '0x4444444444444444444444444444444444444444',
  floorPriceEth: 0.008, // ~$21.60
  topOfferEth: 0.003,
  numListings: 10,
  openseaFeeBps: 100,
  royaltyFeeBps: 50,
  ethPriceUsd: 2700,
  timestamp: Date.now(),
  sales1Hour: 20,
  uniqueWallets1Hour: 6,
  liquidityPassed: true
};
const highMarginCalc = pricingEngine.calculateMaxBid(highMarginData, 2.0, 10.0, 'robinhood');
assert.strictEqual(highMarginCalc.decision, 'ACCEPT', 'High margin liquid trade must be accepted');
assert(highMarginCalc.marginPercent >= 13.0, 'Profit margin must be >= 13%');
assert(highMarginCalc.netProfitUsd >= 2.0, 'Net profit must be >= $2.00');
console.log('Test 8 PASSED: Margin is ' + highMarginCalc.marginPercent + '% (>= 13%) and net profit is $' + highMarginCalc.netProfitUsd, '\n');

console.log('================================================================');
console.log('All 8 Capital Allocation, Liquidity & Profitability tests passed successfully!');
console.log('================================================================');
