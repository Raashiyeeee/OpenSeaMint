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
// TEST 5: Simultaneous Offers Across Qualifying NFTs & 60% Capital Allocation Rule
// Number of NFTs is unlimited by count; limited only by active-offer capital allocation (e.g. 60% of $10 = $6.00 max).
// --------------------------------------------------------------------------
console.log('--- Test 5: Simultaneous Offers & 60% Active-Offer Capital Allocation ---');
const inventoryManager = new InventoryManager(config);

assert.strictEqual(inventoryManager.getTotalCapitalUsd(), 10.0, 'Total capital must be $10');
assert.strictEqual(inventoryManager.getAvailableCapitalUsd(), 10.0, 'Available capital must start at $10');

// Place first simultaneous offer ($2.50)
const offer1Check = inventoryManager.canAllocateCapitalForOffer(2.50);
assert.strictEqual(offer1Check.allowed, true, 'First offer ($2.50 <= $6.00 limit) must be allowed');
inventoryManager.registerActiveOffer({
  orderHash: 'offer_1',
  collectionSlug: 'collection-a',
  contractAddress: '0xa5c0bd78d1667c13bfb403e2a3336871396713c5',
  priceEth: 0.000925,
  priceUsd: 2.50,
  createdTimestamp: Date.now(),
  expiresTimestamp: Date.now() + 3600000,
  status: 'ACTIVE'
});

// Place second simultaneous offer ($2.50) across another qualifying collection (count is unlimited!)
const offer2Check = inventoryManager.canAllocateCapitalForOffer(2.50);
assert.strictEqual(offer2Check.allowed, true, 'Second simultaneous offer ($2.50 + $2.50 = $5.00 <= $6.00) must be allowed');
inventoryManager.registerActiveOffer({
  orderHash: 'offer_2',
  collectionSlug: 'collection-b',
  contractAddress: '0xb5c0bd78d1667c13bfb403e2a3336871396713c5',
  priceEth: 0.000925,
  priceUsd: 2.50,
  createdTimestamp: Date.now(),
  expiresTimestamp: Date.now() + 3600000,
  status: 'ACTIVE'
});
console.log('Simultaneous offers allowed across multiple collections: Total active offers = $' + inventoryManager.getActiveOffersCapitalUsd());

// Attempt third offer ($2.00) -> $5.00 + $2.00 = $7.00 > $6.00 (60% of $10) -> Must be blocked!
const offer3Check = inventoryManager.canAllocateCapitalForOffer(2.00);
assert.strictEqual(offer3Check.allowed, false, 'Third offer exceeding 60% active offer allocation ($7.00 > $6.00) must be blocked');
console.log('Third offer blocked by capital allocation limit:', offer3Check.reason);

// Now simulate NFT acquired & then sold for $4.00
const saleResult = inventoryManager.markItemSold(
  '0xa5c0bd78d1667c13bfb403e2a3336871396713c5:1',
  0.0015,
  2700,
  100, // 1% fee
  0.01 // gas
);

assert(saleResult.newTotalCapitalUsd >= 10.0, 'Capital after sale must be updated with profit');
console.log('Sale completed: Capital released, new balance: $' + saleResult.newTotalCapitalUsd);
console.log('Test 5 PASSED: Simultaneous offers and 60% active-offer capital allocation verified!\n');

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
console.log('--- Test 8: Minimum 40% Net Profit Margin Rule ($3 Max NFT Profile) ---');
const highMarginData: CollectionMarketData = {
  slug: 'high-margin-nft',
  contractAddress: '0x4444444444444444444444444444444444444444',
  floorPriceEth: 0.0008, // ~$2.16
  topOfferEth: 0.0004,   // ~$1.08 (like Primal Apes)
  numListings: 10,
  openseaFeeBps: 100,
  royaltyFeeBps: 50,
  ethPriceUsd: 2700,
  timestamp: Date.now(),
  sales1Hour: 20,
  uniqueWallets1Hour: 6,
  liquidityPassed: true
};
const highMarginCalc = pricingEngine.calculateMaxBid(highMarginData, 0.20, 10.0, 'robinhood');
assert.strictEqual(highMarginCalc.decision, 'ACCEPT', 'High margin liquid trade must be accepted');
assert(highMarginCalc.marginPercent >= 40.0, 'Profit margin must be >= 40%');
assert(highMarginCalc.netProfitUsd > 0, 'Net profit must be positive');
assert(highMarginCalc.bidPriceUsd <= 3.0, 'Bid price must be <= $3.00');
console.log('Test 8 PASSED: Margin is ' + highMarginCalc.marginPercent + '% (>= 40%) and net profit is $' + highMarginCalc.netProfitUsd, '\n');

// --------------------------------------------------------------------------
// TEST 9: Strict $5.00 Maximum Buy Price Ceiling
// --------------------------------------------------------------------------
console.log('--- Test 9: Strict $5.00 Maximum Buy Price Ceiling ---');
const expensiveData: CollectionMarketData = {
  slug: 'expensive-nft',
  contractAddress: '0x5555555555555555555555555555555555555555',
  floorPriceEth: 0.008, // ~$21.60
  topOfferEth: 0.003,   // ~$8.10
  numListings: 10,
  openseaFeeBps: 100,
  royaltyFeeBps: 50,
  ethPriceUsd: 2700,
  timestamp: Date.now(),
  sales1Hour: 25,
  uniqueWallets1Hour: 8,
  liquidityPassed: true
};
const expensiveCalc = pricingEngine.calculateMaxBid(expensiveData, 0.20, 10.0, 'robinhood');
assert.strictEqual(expensiveCalc.decision, 'REJECT', 'Expensive trade (> $5 buy price) must be rejected');
console.log('Test 9 PASSED: Trade above $5 correctly rejected:', expensiveCalc.reason, '\n');

// --------------------------------------------------------------------------
// TEST 10: Floor Dump Protection & Relist/Hold Evaluation (Rule 6, 7, 8)
// Acquired at 0.001 ETH (~$2.70). Min profitable price is ~0.001185 ETH (~$3.20).
// Case 10a: Floor dumps to 0.0009 ETH (< min profitable price) -> MUST HOLD!
// Case 10b: Floor rises to 0.0020 ETH (> min profitable price) -> MUST LIST!
// --------------------------------------------------------------------------
console.log('--- Test 10: Floor Dump Protection & Listing Evaluation ---');
const marketFees = { openseaFeeBps: 50, royaltyFeeBps: 50, ethPriceUsd: 2700 };
const dumpEval = pricingEngine.evaluateListingOrHold(0.001, 0.0009, marketFees, 0.20, 'robinhood');
assert.strictEqual(dumpEval.action, 'HOLD', 'Dumped floor must trigger HOLD action');
assert(dumpEval.reason.includes('Floor Dump Protection'), 'Reason must cite Floor Dump Protection');
console.log('Case 10a PASSED: Dumped floor correctly held:', dumpEval.reason);

const normalEval = pricingEngine.evaluateListingOrHold(0.001, 0.0020, marketFees, 0.20, 'robinhood');
assert.strictEqual(normalEval.action, 'LIST', 'Healthy floor must trigger LIST action');
assert(normalEval.recommendedListPriceEth! >= dumpEval.minProfitablePriceEth, 'List price must be >= min profitable price');
assert(normalEval.expectedNetProfitUsd! > 0, 'Expected net profit must be positive');
console.log('Case 10b PASSED: Healthy floor correctly listed at ' + normalEval.recommendedListPriceEth + ' ETH, profit: $' + normalEval.expectedNetProfitUsd, '\n');

// --------------------------------------------------------------------------
// TEST 11: Inventory Manager HOLDING Status & Capital Locking
// --------------------------------------------------------------------------
console.log('--- Test 11: Inventory Manager HOLDING Status & Capital Locking ---');
const holdInvManager = new InventoryManager(config);
holdInvManager.addInventoryItem({
  identifier: 'test-contract:42',
  collectionSlug: 'test-collection',
  contractAddress: '0x1234567890123456789012345678901234567890',
  tokenId: '42',
  acquiredPriceEth: 0.003,
  acquiredPriceUsd: 8.10,
  acquiredAtTimestamp: Date.now(),
  status: 'PENDING_LISTING'
});

holdInvManager.updateHoldStatus('test-contract:42', 'Market floor dumped');
assert.strictEqual(holdInvManager.getActiveTradesCount(), 1, 'Holding item must count as active trade');
assert.strictEqual(holdInvManager.getAllocatedCapitalUsd(2700), 8.10, 'Holding item must lock capital');
// In test 11, with 1 held item, attempting to allocate capital beyond available must be blocked
const blockedCheck = holdInvManager.canAllocateCapital(5.0);
assert.strictEqual(blockedCheck.allowed, false, 'New trade must be blocked when capital exceeds available');
console.log('Test 11 PASSED: Held item correctly locks capital: ' + blockedCheck.reason, '\n');

// --------------------------------------------------------------------------
// TEST 12: Mandatory vs Optional Creator Fee Rule
// --------------------------------------------------------------------------
console.log('--- Test 12: Mandatory vs Optional Creator Fee Rule ---');
// Case 12a: Optional creator fee (required: false) -> Automatically DISABLED to 0%
const optionalFeeData: CollectionMarketData = {
  slug: 'optional-fee-nft',
  contractAddress: '0x6666666666666666666666666666666666666666',
  floorPriceEth: 0.0015, // ~$4.05
  topOfferEth: 0.0008,   // ~$2.16
  numListings: 10,
  openseaFeeBps: 50,     // 0.5%
  royaltyFeeBps: 0,      // Optional fee was verified & disabled to 0 bps!
  mandatoryRoyaltyFeeBps: 0,
  optionalRoyaltyFeeBps: 500, // 5% creator fee was optional
  creatorFeeDisabled: true,
  ethPriceUsd: 2700,
  timestamp: Date.now(),
  sales1Hour: 25,
  uniqueWallets1Hour: 8,
  liquidityPassed: true,
  fees: [
    { fee: 0.5, recipient: '0x0000a26b00c1f0df003000390027140000faa719', required: true }, // OpenSea
    { fee: 5.0, recipient: '0xcreator1111111111111111111111111111111111', required: false, disabled: true } // Optional creator fee
  ]
};
const optionalFeeCalc = pricingEngine.calculateMaxBid(optionalFeeData, 0.20, 10.0, 'robinhood');
assert.strictEqual(optionalFeeCalc.royaltyFeeUsd, 0, 'Optional creator fee must be 0 in calculations when disabled');
assert.strictEqual(optionalFeeCalc.decision, 'ACCEPT', 'Profitable trade with optional fee disabled must be accepted');
console.log('Case 12a PASSED: Optional creator fee successfully disabled to $0.00 royalty, net profit: $' + optionalFeeCalc.netProfitUsd);

// Case 12b: Mandatory creator fee (required: true) -> Must be included in profitability calculations
const mandatoryFeeData: CollectionMarketData = {
  ...optionalFeeData,
  slug: 'mandatory-fee-nft',
  royaltyFeeBps: 500, // 5% mandatory fee included
  mandatoryRoyaltyFeeBps: 500,
  optionalRoyaltyFeeBps: 0,
  creatorFeeDisabled: false,
  fees: [
    { fee: 0.5, recipient: '0x0000a26b00c1f0df003000390027140000faa719', required: true },
    { fee: 5.0, recipient: '0xcreator1111111111111111111111111111111111', required: true, disabled: false }
  ]
};
const mandatoryFeeCalc = pricingEngine.calculateMaxBid(mandatoryFeeData, 0.20, 10.0, 'robinhood');
assert(mandatoryFeeCalc.royaltyFeeUsd > 0, 'Mandatory creator fee must be included in calculation');
console.log('Case 12b PASSED: Mandatory creator fee included in calculation: $' + mandatoryFeeCalc.royaltyFeeUsd);

// Case 12c: Seaport order fee verification rejects inclusion of optional creator fee
let feeVerificationThrew = false;
try {
  const dummyConsideration = [
    { recipient: '0xcreator1111111111111111111111111111111111' } // Errantly includes optional fee
  ];
  const dummyRawFees = [
    { fee: 5.0, recipient: '0xcreator1111111111111111111111111111111111', required: false, disabled: true }
  ];
  // Verify using verifyOrderFees
  const seaportService = new (require('../src/services/SeaportService').SeaportService)(config, require('ethers').Wallet.createRandom());
  seaportService.verifyOrderFees(dummyConsideration, dummyRawFees);
} catch (e: any) {
  feeVerificationThrew = true;
  assert(e.message.includes('Creator fee violation'), 'Error must identify creator fee violation');
}
assert.strictEqual(feeVerificationThrew, true, 'verifyOrderFees must reject order containing optional creator fee');
console.log('Case 12c PASSED: Seaport verification strictly guarantees optional creator fee is disabled in order!\n');

// --------------------------------------------------------------------------
// TEST 13: Wallet Reconciliation & Total Bot Inventory Cap Resolution
// --------------------------------------------------------------------------
console.log('--- Test 13: Wallet Reconciliation & Inventory Cap Resolution ---');
const reconcileInvManager = new InventoryManager(config);
// Simulate bot previously had 1 NFT in inventory
reconcileInvManager.addInventoryItem({
  identifier: '0xcontract1:100',
  collectionSlug: 'slug-a',
  contractAddress: '0xcontract1',
  tokenId: '100',
  acquiredPriceEth: 0.001,
  acquiredPriceUsd: 2.70,
  acquiredAtTimestamp: Date.now(),
  status: 'LISTED'
});
assert.strictEqual(reconcileInvManager.getInventoryCount(), 1, 'Inventory count should be 1');

// Now simulate user sold the NFT on OpenSea/wallet: Wallet now has 0 NFTs
const removed = reconcileInvManager.reconcileWalletInventory([]);
assert.strictEqual(removed.length, 1, 'Should reconcile and remove sold NFT');
assert.strictEqual(reconcileInvManager.getInventoryCount(), 0, 'Inventory count must reset to 0');
assert.strictEqual(reconcileInvManager.canBidOnCollection('slug-a', 5), true, 'Bidding must be allowed once inventory is cleared');
console.log('Test 13 PASSED: Wallet reconciliation immediately detects sold NFT, frees capital, and clears inventory cap!\n');

console.log('================================================================');
console.log('All 13 Capital Allocation, Liquidity, Floor Protection, Creator Fee & Inventory tests passed successfully!');
console.log('================================================================');
