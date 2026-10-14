import assert from 'assert';
import { Wallet } from 'ethers';
import { PricingEngine } from '../src/services/PricingEngine';
import { InventoryManager } from '../src/services/InventoryManager';
import { OpenSeaApiService } from '../src/services/OpenSeaApiService';
import { SeaportService } from '../src/services/SeaportService';
import { CircuitBreaker } from '../src/security/CircuitBreaker';
import { CollectionBidderStrategy } from '../src/strategies/CollectionBidderStrategy';
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
// TEST 5: Simultaneous Offers Across Qualifying NFTs & 70% Capital Allocation Rule
// Number of NFTs is unlimited by count; limited only by capital allocation (70% of $10 = $7.00 max, 30% reserved).
// --------------------------------------------------------------------------
console.log('--- Test 5: Simultaneous Offers & 70% Capital Allocation ---');
const inventoryManager = new InventoryManager(config);

assert.strictEqual(inventoryManager.getTotalCapitalUsd(), 10.0, 'Total capital must be $10');
assert.strictEqual(inventoryManager.getAvailableCapitalUsd(), 10.0, 'Available capital must start at $10');

// Place first simultaneous offer ($2.50)
const offer1Check = inventoryManager.canAllocateCapitalForOffer(2.50);
assert.strictEqual(offer1Check.allowed, true, 'First offer ($2.50 <= $7.00 limit) must be allowed');
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
assert.strictEqual(offer2Check.allowed, true, 'Second simultaneous offer ($2.50 + $2.50 = $5.00 <= $7.00) must be allowed');
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

// Attempt third offer ($2.50) -> $5.00 + $2.50 = $7.50 > $7.00 (70% of $10) -> Must be blocked!
const offer3Check = inventoryManager.canAllocateCapitalForOffer(2.50);
assert.strictEqual(offer3Check.allowed, false, 'Third offer exceeding 70% allocation ($7.50 > $7.00) must be blocked');
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
console.log('Test 5 PASSED: Simultaneous offers and 70% capital allocation verified!\n');

// --------------------------------------------------------------------------
// TEST 6: Network Gas Impact: Robinhood Chain vs Ethereum Mainnet
// Robinhood Chain gas ($0.01) vs Ethereum Mainnet gas ($3.50) on $10 trade
// --------------------------------------------------------------------------
console.log('--- Test 6: Network Gas Comparison on $10 Trade ---');
const rhTrade = pricingEngine.evaluateOfferScenario({
  offerPriceUsd: 10.0,
  floorPriceUsd: 15.0, // 40% net margin rule: floor 13 (~23% margin) no longer qualifies
  royaltyPercent: 5.0,
  marketplaceFeePercent: 0.5,
  networkGasUsd: 0.01, // Robinhood Chain low gas
  availableCapitalUsd: 10.0,
  minNetProfitUsd: 2.0
});

const ethMainnetTrade = pricingEngine.evaluateOfferScenario({
  offerPriceUsd: 10.0,
  floorPriceUsd: 15.0,
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
  sales3Hours: 5,
  uniqueWallets3Hours: 2,
  mintStatusVerified: true,
  totalSupply: 1000,
  maxSupply: 1000,
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
  uniqueWallets1Hour: 1,
  sales3Hours: 16,
  uniqueWallets3Hours: 1,
  mintStatusVerified: true,
  totalSupply: 1000,
  maxSupply: 1000, // Only 1 wallet!
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
  sales3Hours: 25,
  uniqueWallets3Hours: 12,
  mintStatusVerified: true,
  totalSupply: 1000,
  maxSupply: 1000,
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
  sales3Hours: 20,
  uniqueWallets3Hours: 6,
  mintStatusVerified: true,
  totalSupply: 1000,
  maxSupply: 1000,
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
  sales3Hours: 25,
  uniqueWallets3Hours: 8,
  mintStatusVerified: true,
  totalSupply: 1000,
  maxSupply: 1000,
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
  sales3Hours: 25,
  uniqueWallets3Hours: 8,
  mintStatusVerified: true,
  totalSupply: 1000,
  maxSupply: 1000,
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

// Now simulate user sold the NFT on OpenSea/wallet: Wallet now has 0 NFTs and a confirmed sale event exists
const removed = reconcileInvManager.reconcileWalletInventory([], 2700, new Map([['0xcontract1:100', { salePriceEth: 0.0015, txHash: '0xsale13' }]]));
assert.strictEqual(removed.length, 1, 'Should reconcile and remove sold NFT');
assert.strictEqual(reconcileInvManager.getInventoryCount(), 0, 'Inventory count must reset to 0');
assert.strictEqual(reconcileInvManager.canBidOnCollection('slug-a', 5), true, 'Bidding must be allowed once inventory is cleared');
console.log('Test 13 PASSED: Wallet reconciliation immediately detects sold NFT, frees capital, and clears inventory cap!\n');

// --------------------------------------------------------------------------
// TEST 14: NFT Offer Eligibility Rules
// Rule 1: Native ETH Sales (>= 10 floor sales in last 3h paid in native ETH. WETH must not count)
// Rule 2: Actual Floor Sales (genuine sales around floor. Offer acceptances and WETH sales must not count)
// Rule 3: Minimum Floor Difference (Floor Price >= Offer Price * 1.30, floor at least 30% higher)
// Rule 4: Creator Fee Exclusion (calculate 30% difference without including creator fees in comparison)
// Rule 5: Mandatory Rejection (if any condition fails, bot must not place an offer)
// --------------------------------------------------------------------------
(async () => {
  console.log('--- Test 14: NFT Offer Eligibility Rules ---');
  const apiService = new OpenSeaApiService(config);
  const nowSec = Math.floor(Date.now() / 1000);

  // Case 14a: WETH Sales Exclusion (Rule 1 & Rule 2)
  // 15 total sales in last 3h: 7 native ETH floor sales + 8 WETH sales
  // WETH sales must NOT count -> Only 7 valid sales -> REJECT!
  (apiService as any).client = {
    get: async () => ({
      data: {
        asset_events: [
          // 7 Native ETH floor sales (0.001 ETH)
          ...Array.from({ length: 7 }, (_, i) => ({
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            buyer: `0xbuyer_${i}`,
            seller: `0xseller_${i}`
          })),
          // 8 WETH sales (must NOT count)
          ...Array.from({ length: 8 }, (_, i) => ({
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'WETH', quantity: '1000000000000000', decimals: 18 },
            buyer: `0xbuyer_weth_${i}`,
            seller: `0xseller_weth_${i}`
          }))
        ]
      }
    })
  };

  const wethExcludedResult = await apiService.getCollectionLiquidity('test-weth-exclude', 0.001);
  assert.strictEqual(wethExcludedResult.sales3Hours, 7, 'WETH sales must not count toward 3h sales count');
  assert.strictEqual(wethExcludedResult.liquidityPassed, false, 'Must reject when native ETH floor sales < 10');
  assert(wethExcludedResult.liquidityReason?.includes('WETH and offer acceptances excluded'), 'Reason must state WETH/offers excluded');
  console.log('Case 14a PASSED: WETH sales excluded. Only 7/10 native ETH sales -> REJECTED ✅');

  // Case 14b: Offer Acceptances Exclusion (Rule 2)
  // 12 sales in last 3h: 8 direct floor buys in ETH + 4 offer acceptances in ETH
  // Offer acceptances must NOT count -> Only 8 valid sales -> REJECT!
  (apiService as any).client = {
    get: async () => ({
      data: {
        asset_events: [
          // 8 Genuine floor buys in ETH
          ...Array.from({ length: 8 }, (_, i) => ({
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            order_type: 'listing',
            buyer: `0xbuyer_${i}`,
            seller: `0xseller_${i}`
          })),
          // 4 Offer acceptances in ETH (must NOT count)
          ...Array.from({ length: 4 }, (_, i) => ({
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            order_type: 'offer',
            buyer: `0xbuyer_offer_${i}`,
            seller: `0xseller_offer_${i}`
          }))
        ]
      }
    })
  };

  const offerAcceptanceExcluded = await apiService.getCollectionLiquidity('test-offer-exclude', 0.001);
  assert.strictEqual(offerAcceptanceExcluded.sales3Hours, 8, 'Offer acceptances must not count toward floor sales');
  assert.strictEqual(offerAcceptanceExcluded.liquidityPassed, false, 'Must reject when genuine floor sales < 10');
  console.log('Case 14b PASSED: Offer acceptances excluded. Only 8/10 floor sales -> REJECTED ✅');

  // Case 14b2: Sales Older Than 3 Hours Exclusion
  // 12 native ETH sales, but 5 are from 4 hours ago (older than 3h) and only 7 are within 3h
  // Sales older than 3 hours must not count -> Only 7 valid sales -> REJECT!
  (apiService as any).client = {
    get: async () => ({
      data: {
        asset_events: [
          // 7 sales within the last 2 hours
          ...Array.from({ length: 7 }, (_, i) => ({
            event_timestamp: nowSec - 3600,
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            order_type: 'listing',
            buyer: `0xbuyer_recent_${i}`,
            seller: `0xseller_recent_${i}`
          })),
          // 5 sales from 4 hours ago (> 3 hours old)
          ...Array.from({ length: 5 }, (_, i) => ({
            event_timestamp: nowSec - (4 * 3600),
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            order_type: 'listing',
            buyer: `0xbuyer_old_${i}`,
            seller: `0xseller_old_${i}`
          }))
        ]
      }
    })
  };

  const oldSalesExcluded = await apiService.getCollectionLiquidity('test-old-sales-exclude', 0.001);
  assert.strictEqual(oldSalesExcluded.sales3Hours, 7, 'Sales older than 3 hours must not count');
  assert.strictEqual(oldSalesExcluded.liquidityPassed, false, 'Must reject when valid sales in last 3h < 10');
  console.log('Case 14b2 PASSED: Sales older than 3 hours excluded. Only 7/10 recent sales -> REJECTED ✅');

  // Case 14b3: Non-completed / pending / cancelled sales must not count
  (apiService as any).client = {
    get: async () => ({
      data: {
        asset_events: [
          // 8 completed sales
          ...Array.from({ length: 8 }, (_, i) => ({
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            status: 'successful',
            order_type: 'listing',
            buyer: `0xbuyer_comp_${i}`,
            seller: `0xseller_comp_${i}`
          })),
          // 2 pending sales (must not count)
          {
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            status: 'pending',
            buyer: '0xbuyer_pend1',
            seller: '0xseller_pend1'
          },
          // 2 cancelled/failed sales (must not count)
          {
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            status: 'failed',
            buyer: '0xbuyer_fail1',
            seller: '0xseller_fail1'
          }
        ]
      }
    })
  };

  const incompleteSalesExcluded = await apiService.getCollectionLiquidity('test-incomplete-exclude', 0.001);
  assert.strictEqual(incompleteSalesExcluded.sales3Hours, 8, 'Incomplete/pending/failed sales must not count');
  assert.strictEqual(incompleteSalesExcluded.liquidityPassed, false, 'Must reject when completed floor sales < 10');
  console.log('Case 14b3 PASSED: Incomplete/pending/failed sales excluded. Only 8/10 completed sales -> REJECTED ✅');

  // Case 14c: Genuine Floor Sales Around Current Floor Price (Rule 2)
  // Floor is 0.001 ETH. 12 native ETH sales:
  // 10 sales at 0.001 ETH (within 80% - 135% floor range)
  // 1 sale at 0.0003 ETH (far below floor, offer/dump) -> Excluded
  // 1 sale at 0.0050 ETH (far above floor, rare outlier) -> Excluded
  // Result: Exactly 10 genuine floor sales across 10 unique wallets -> PASSES!
  (apiService as any).client = {
    get: async () => ({
      data: {
        asset_events: [
          ...Array.from({ length: 10 }, (_, i) => ({
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '1000000000000000', decimals: 18 },
            buyer: `0xbuyer_floor_${i}`,
            seller: `0xseller_floor_${i}`
          })),
          {
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '300000000000000', decimals: 18 }, // 0.0003 ETH (too low)
            buyer: '0xbuyer_low',
            seller: '0xseller_low'
          },
          {
            event_timestamp: nowSec - 1800,
            payment: { symbol: 'ETH', quantity: '5000000000000000', decimals: 18 }, // 0.005 ETH (outlier)
            buyer: '0xbuyer_high',
            seller: '0xseller_high'
          }
        ]
      }
    })
  };

  const floorRangeResult = await apiService.getCollectionLiquidity('test-floor-range', 0.001);
  assert.strictEqual(floorRangeResult.sales3Hours, 10, 'Only genuine sales within floor range must count');
  assert.strictEqual(floorRangeResult.liquidityPassed, true, 'At least 10 genuine floor sales passes liquidity check');
  console.log('Case 14c PASSED: Outlier & below-floor sales excluded. Exactly 10/10 genuine floor sales -> PASSED ✅');

  // Case 14d: Minimum 30% Floor Difference Formula (Current Floor Price >= Offer Price * 1.30)
  // Floor: 0.0013 ETH, Offer: 0.0010 ETH -> 0.0013 >= 0.0010 * 1.30 -> Exactly 30% -> PASSES
  const floor30Pass = pricingEngine.evaluateOfferEligibility({
    floorPriceEth: 0.0013,
    offerPriceEth: 0.0010,
    sales3HoursNativeEth: 10
  });
  assert.strictEqual(floor30Pass.eligible, true, 'Offer with 30% floor premium must be eligible');
  assert.strictEqual(floor30Pass.floorDifferencePassed, true, 'Floor difference check must pass');
  console.log('Case 14d PASSED: Floor 0.0013 ETH >= Offer 0.0010 ETH * 1.30 -> PASSED ✅');

  // Test User Required Examples (Table with 30% floor multiplier):
  // - Offer: $1.00 -> Minimum floor: $1.30
  // - Offer: $2.00 -> Minimum floor: $2.60
  // - Offer: $3.00 -> Minimum floor: $3.90
  // - Offer: $5.00 -> Minimum floor: $6.50
  const exampleTable1 = pricingEngine.evaluateOfferScenario({ offerPriceUsd: 1.00, floorPriceUsd: 1.30, royaltyPercent: 0, enforceFloorRatio: true });
  assert.strictEqual(exampleTable1.checkFFloorRatioPassed, true, 'Offer $1.00 with Floor $1.30 must pass 30% rule');
  assert.strictEqual(exampleTable1.checkMinOfferPassed, true, 'Offer $1.00 must pass minimum offer price rule');

  const exampleTable2 = pricingEngine.evaluateOfferScenario({ offerPriceUsd: 2.00, floorPriceUsd: 2.60, royaltyPercent: 0, enforceFloorRatio: true });
  assert.strictEqual(exampleTable2.checkFFloorRatioPassed, true, 'Offer $2.00 with Floor $2.60 must pass 30% rule');
  assert.strictEqual(exampleTable2.checkMinOfferPassed, true, 'Offer $2.00 must pass minimum offer price rule');

  const exampleTable3 = pricingEngine.evaluateOfferScenario({ offerPriceUsd: 3.00, floorPriceUsd: 3.90, royaltyPercent: 0, enforceFloorRatio: true });
  assert.strictEqual(exampleTable3.checkFFloorRatioPassed, true, 'Offer $3.00 with Floor $3.90 must pass 30% rule');
  assert.strictEqual(exampleTable3.checkMinOfferPassed, true, 'Offer $3.00 must pass minimum offer price rule');

  const exampleTable4 = pricingEngine.evaluateOfferScenario({ offerPriceUsd: 5.00, floorPriceUsd: 6.50, royaltyPercent: 0, enforceFloorRatio: true });
  assert.strictEqual(exampleTable4.checkFFloorRatioPassed, true, 'Offer $5.00 with Floor $6.50 must pass 30% rule');
  assert.strictEqual(exampleTable4.checkMinOfferPassed, true, 'Offer $5.00 must pass minimum offer price rule');
  console.log('Case 14d2 PASSED: Verified all user table examples ($1.00->$1.30, $2.00->$2.60, $3.00->$3.90, $5.00->$6.50) ✅');

  // Case 14e: Floor Difference Fails (< 1.30 * Offer -> Mandatory Rejection)
  // Floor: 0.00129 ETH, Offer: 0.0010 ETH -> 0.00129 < 0.00130 (only 29% higher) -> REJECT!
  const floor29Fail = pricingEngine.evaluateOfferEligibility({
    floorPriceEth: 0.00129,
    offerPriceEth: 0.0010,
    sales3HoursNativeEth: 10
  });
  assert.strictEqual(floor29Fail.eligible, false, 'Offer below 30% floor premium must be rejected');
  assert.strictEqual(floor29Fail.floorDifferencePassed, false, 'Floor difference check must fail');
  assert(floor29Fail.reason.includes('Mandatory Rejection'), 'Must state Mandatory Rejection');
  console.log('Case 14e PASSED: Floor 0.00129 ETH < Offer 0.0010 ETH * 1.30 -> MANDATORY REJECTION ✅');

  // Case 14f: Creator Fee Exclusion from 30% Floor Difference Calculation
  // The 30% comparison is strictly between raw Floor Price and Offer Price without subtracting creator fees.
  // With 10% creator fee (royaltyFeeBps: 1000), Floor = 0.0013 ETH and Offer = 0.0010 ETH:
  // Floor Price (0.0013) is still >= Offer Price (0.0010) * 1.30 because creator fee is NOT deducted in this ratio check!
  const marketDataWithRoyalty: CollectionMarketData = {
    slug: 'creator-fee-excluded-ratio',
    contractAddress: '0x8888888888888888888888888888888888888888',
    floorPriceEth: 0.0013, // Raw floor
    topOfferEth: 0.0005,
    numListings: 10,
    openseaFeeBps: 50,
    royaltyFeeBps: 1000, // 10% creator fee!
    mandatoryRoyaltyFeeBps: 1000,
    ethPriceUsd: 2700,
    timestamp: Date.now(),
    sales3Hours: 12,
    uniqueWallets3Hours: 6,
    liquidityPassed: true
  };
  const calcWithRoyalty = pricingEngine.calculateMaxBid(marketDataWithRoyalty, 0.10, 10.0, 'robinhood');
  // Bid calculated by pricing engine must respect floor / 1.30 ceiling (0.0013 / 1.30 = 0.0010 ETH)
  assert(calcWithRoyalty.bidPriceEth <= 0.0010, `Calculated bid (${calcWithRoyalty.bidPriceEth}) must not exceed Floor / 1.30 (0.0010)`);
  assert.strictEqual(calcWithRoyalty.checkFFloorRatioPassed, true, '30% floor ratio comparison must pass excluding creator fees');
  console.log('Case 14f PASSED: Creator fee excluded in 30% floor difference calculation -> PASSED ✅');

  // Case 14g: Mandatory Rejection in evaluateOfferScenario with enforceFloorRatio (< 30%)
  const rejectedScenario = pricingEngine.evaluateOfferScenario({
    offerPriceUsd: 1.00,
    floorPriceUsd: 1.25, // Only 25% above offer (< 30%)
    royaltyPercent: 0,
    minNetProfitUsd: 0.10,
    enforceFloorRatio: true
  });
  assert.strictEqual(rejectedScenario.decision, 'REJECT', 'Scenario failing 30% floor difference must be REJECTED');
  assert.strictEqual(rejectedScenario.checkFFloorRatioPassed, false, 'checkFFloorRatioPassed must be false');
  console.log('Case 14g PASSED: evaluateOfferScenario with enforceFloorRatio rejects sub-30% trades -> MANDATORY REJECTION ✅');

  // Case 14h: Minimum Offer Price Rule ($1.00 USD per NFT) & Prevent Accidental Low-Value Purchases
  // Offers below $1.00 (e.g., $0.30, $0.40) are strictly prohibited even if profitable or allowed by market!
  const lowOffer030 = pricingEngine.evaluateOfferScenario({
    offerPriceUsd: 0.30,
    floorPriceUsd: 2.00, // Floor is well above 30%
    royaltyPercent: 0,
    minNetProfitUsd: 0.10,
    enforceFloorRatio: true
  });
  assert.strictEqual(lowOffer030.decision, 'REJECT', 'Offer of $0.30 must be strictly REJECTED');
  assert.strictEqual(lowOffer030.checkMinOfferPassed, false, 'checkMinOfferPassed must be false for $0.30');
  assert(lowOffer030.reason.includes('Minimum Offer Price Failed'), 'Reason must mention Minimum Offer Price Failed');

  const lowOffer040 = pricingEngine.evaluateOfferScenario({
    offerPriceUsd: 0.40,
    floorPriceUsd: 2.00,
    royaltyPercent: 0,
    minNetProfitUsd: 0.10,
    enforceFloorRatio: true
  });
  assert.strictEqual(lowOffer040.decision, 'REJECT', 'Offer of $0.40 must be strictly REJECTED');
  assert.strictEqual(lowOffer040.checkMinOfferPassed, false, 'checkMinOfferPassed must be false for $0.40');

  // Offer at exactly $1.00 with $1.30 floor passes
  const validMinOffer = pricingEngine.evaluateOfferScenario({
    offerPriceUsd: 1.00,
    floorPriceUsd: 1.30,
    royaltyPercent: 0,
    minNetProfitUsd: 0.10,
    enforceFloorRatio: true
  });
  assert.strictEqual(validMinOffer.checkMinOfferPassed, true, 'checkMinOfferPassed must be true for $1.00');
  assert.strictEqual(validMinOffer.checkFFloorRatioPassed, true, 'checkFFloorRatioPassed must be true for $1.00 offer with $1.30 floor');
  console.log('Case 14h PASSED: Strictly rejected $0.30 and $0.40 offers; accepted $1.00 offer -> PASSED ✅');

  // --------------------------------------------------------------------------
  // TEST 14i: NFT Offer Profitability Rule — Creator Fee Included in Profit Calculation
  // User Prompt Example:
  // "If the highest existing offer is $1.00, the bot considers placing an offer of $1.25,
  // and the floor price is $1.50, the bot must not automatically accept this trade.
  // If a 10% creator fee and other costs eliminate the expected profit, the offer must be rejected.
  // Core rule: High sales volume alone is not enough. The bot may place an offer only when
  // the floor-price requirement is satisfied and the trade is expected to generate the required net profit after all applicable fees."
  // --------------------------------------------------------------------------
  console.log('--- Case 14i: User Example — Highest Offer $1.00, Considers $1.25, Floor $1.50, 10% Creator Fee ---');
  const userExampleEval = pricingEngine.evaluateProposedOffer({
    highestExistingOfferUsd: 1.00,
    proposedOfferUsd: 1.25,
    currentFloorUsd: 1.50,
    creatorFeePercent: 10.0,
    marketplaceFeePercent: 0.5,
    estimatedGasUsd: 0.01,
    minNetProfitUsd: 0.20,
    minMarginPercent: 15.0,
    sales3Hours: 50 // HIGH SALES VOLUME!
  });

  // Verify Formula 1: Floor Price ($1.50) >= Offer Price ($1.25) * 1.30 = $1.625 -> FAILS!
  assert.strictEqual(userExampleEval.floorRequirementPassed, false, 'Formula 1 must fail: $1.50 < $1.25 * 1.30 = $1.625');
  assert.strictEqual(userExampleEval.requiredFloorUsd, 1.63, 'Required floor should be $1.63 (or 1.625)');

  // Verify Formula 2: Total Acquisition and Selling Costs:
  // Purchase price: $1.25, Creator fee (10%): $0.15, Marketplace fee (0.5%): $0.0075, Gas: $0.01
  // Total costs: $1.4175 (~$1.42)
  // Expected Net Profit: $1.50 - $1.4175 = $0.0825 < $0.20 min threshold and 6.6% < 15% min margin
  assert.strictEqual(userExampleEval.costsBreakdown.purchasePriceUsd, 1.25, 'Purchase price must be $1.25');
  assert.strictEqual(userExampleEval.costsBreakdown.creatorFeeUsd, 0.15, '10% creator fee must be $0.15');
  assert(userExampleEval.totalAcquisitionAndSellingCostsUsd >= 1.41, 'Total costs must include purchase price, creator fees, marketplace fees, gas');
  assert(userExampleEval.expectedNetProfitUsd < 0.20, 'Net profit after creator fees is below required $0.20 threshold');
  assert.strictEqual(userExampleEval.netProfitabilityPassed, false, 'Formula 2 must fail due to insufficient profit after creator fee');

  // Verify Core Rule: High sales volume alone is not enough!
  assert.strictEqual(userExampleEval.salesVolumePassed, true, 'Sales volume is high (50 sales)');
  assert.strictEqual(userExampleEval.decision, 'REJECT', 'Bot must REJECT trade despite high sales volume');
  assert.strictEqual(userExampleEval.isAcceptable, false, 'Trade is not acceptable');
  console.log('Case 14i PASSED: User Example rejected due to 30% floor requirement AND 10% creator fee eliminating profit (high volume cannot override) ✅');

  // Case 14j: Trade where Floor requirement passes ($1.25 offer with $1.65 floor),
  // but high creator fee + gas eliminates profit -> REJECT!
  const highFeeReject = pricingEngine.evaluateProposedOffer({
    proposedOfferUsd: 1.25,
    currentFloorUsd: 1.65, // Floor is 32% higher (passes Formula 1: 1.65 >= 1.25 * 1.30 = 1.625)
    creatorFeePercent: 10.0, // 10% creator fee ($0.165)
    marketplaceFeePercent: 2.5, // 2.5% OpenSea fee ($0.041)
    estimatedGasUsd: 0.25, // $0.25 gas
    minNetProfitUsd: 0.20,
    minMarginPercent: 15.0
  });
  assert.strictEqual(highFeeReject.floorRequirementPassed, true, 'Formula 1 passes: $1.65 >= $1.25 * 1.30');
  assert.strictEqual(highFeeReject.netProfitabilityPassed, false, 'Formula 2 must fail: 10% creator fee + costs eliminate profit');
  assert.strictEqual(highFeeReject.decision, 'REJECT', 'Trade must be rejected when creator fees eliminate profit');
  console.log('Case 14j PASSED: Formula 1 passes but Formula 2 fails due to creator fee -> REJECTED ✅');

  // Case 14k: Trade where both Formula 1 and Formula 2 pass -> ACCEPT!
  // Offer $1.25, Floor $2.00 (60% higher), 5% creator fee ($0.10), 0.5% fee ($0.01), $0.01 gas
  // Total costs: $1.25 + $0.10 + $0.01 + $0.01 = $1.37
  // Net profit: $2.00 - $1.37 = $0.63 >= $0.20 (50.4% margin >= 15%)
  const allPassTrade = pricingEngine.evaluateProposedOffer({
    proposedOfferUsd: 1.25,
    currentFloorUsd: 2.00,
    creatorFeePercent: 5.0,
    marketplaceFeePercent: 0.5,
    estimatedGasUsd: 0.01,
    minNetProfitUsd: 0.20,
    minMarginPercent: 15.0,
    sales3Hours: 15
  });
  assert.strictEqual(allPassTrade.floorRequirementPassed, true, 'Formula 1 passes');
  assert.strictEqual(allPassTrade.netProfitabilityPassed, true, 'Formula 2 passes');
  assert.strictEqual(allPassTrade.decision, 'ACCEPT', 'Offer must be ACCEPTED when floor requirement and net profit after fees are satisfied');
  console.log('Case 14k PASSED: Trade meets Formula 1 (Floor >= Offer * 1.30) and Formula 2 (Net profit after all costs) -> ACCEPTED ✅\n');

  // --------------------------------------------------------------------------
  // TEST 15: NFT Re-Bidding & Simultaneous Offers Rule Verification
  // 1. Same NFT Re-Bidding Restriction & No Re-Bidding Before Sale
  // 2. Simultaneous Offers on Different NFTs within 40% Capital Limit
  // 3. Independent NFT Tracking (Token ID, Collection, Ownership, Listing, Sale Confirmation)
  // 4. Re-bidding allowed on same NFT only after confirmed sale and criteria pass again
  // --------------------------------------------------------------------------
  console.log('--- Test 15: NFT Re-Bidding & Simultaneous Offers Rule ---');
  const rebiddingManager = new InventoryManager(config);
  const testContract = '0x1111222233334444555566667777888899990000';
  const testTokenId = '101';
  const testIdentifier = `${testContract.toLowerCase()}:${testTokenId}`;

  // Step 1: Initial state - NFT is not owned and has no offers -> Bidding allowed
  const initialCheck = rebiddingManager.canPlaceOfferOnNft(testContract, testTokenId, 1.50);
  assert.strictEqual(initialCheck.allowed, true, 'Initial offer placement must be allowed on unowned NFT');
  console.log('Case 15a PASSED: Fresh NFT can receive offer within capital limit ✅');

  // Step 2: Bot acquires the NFT (simulated offer accepted)
  rebiddingManager.addInventoryItem({
    identifier: testIdentifier,
    collectionSlug: 'alpha-collection',
    contractAddress: testContract,
    tokenId: testTokenId,
    acquiredPriceEth: 0.0005,
    acquiredPriceUsd: 1.35,
    acquiredAtTimestamp: Date.now(),
    status: 'PENDING_LISTING'
  });

  // Verify Independent NFT Tracking immediately after acquisition
  const trackedAfterAcquisition = rebiddingManager.getTrackedNft(testContract, testTokenId);
  assert(trackedAfterAcquisition !== undefined, 'Acquired NFT must be tracked independently');
  assert.strictEqual(trackedAfterAcquisition.tokenId, testTokenId, 'Token ID must be tracked');
  assert.strictEqual(trackedAfterAcquisition.ownershipStatus, 'OWNED', 'Ownership status must be OWNED');
  assert.strictEqual(trackedAfterAcquisition.listingStatus, 'PENDING_LISTING', 'Listing status must be PENDING_LISTING');
  assert.strictEqual(trackedAfterAcquisition.saleConfirmation, undefined, 'Sale confirmation must be undefined before sale');
  console.log('Case 15b PASSED: Independent NFT Tracking initialized upon acquisition ✅');

  // Step 3: Same NFT Re-Bidding Restriction - Bot MUST NOT place another offer on same NFT while owned
  const rebiddingBlockedPending = rebiddingManager.canPlaceOfferOnNft(testContract, testTokenId, 1.50);
  assert.strictEqual(rebiddingBlockedPending.allowed, false, 'Re-bidding must be strictly blocked while NFT is PENDING_LISTING');
  assert(rebiddingBlockedPending.reason?.includes('Same NFT Re-Bidding Restriction'), 'Reason must specify Same NFT Re-Bidding Restriction');
  console.log('Case 15c PASSED: Re-bidding on same NFT strictly blocked while PENDING_LISTING ✅');

  // Step 4: NFT is listed on OpenSea - trade is still unresolved -> Re-bidding MUST STILL BE BLOCKED
  rebiddingManager.updateListingStatus(testIdentifier, 0.001, 'order_123', 2.70);
  const trackedAfterListing = rebiddingManager.getTrackedNft(testContract, testTokenId);
  assert.strictEqual(trackedAfterListing?.listingStatus, 'LISTED', 'Listing status must update to LISTED');
  assert.strictEqual(trackedAfterListing?.ownershipStatus, 'OWNED', 'Ownership status must remain OWNED');

  const rebiddingBlockedListed = rebiddingManager.canPlaceOfferOnNft(testContract, testTokenId, 1.50);
  assert.strictEqual(rebiddingBlockedListed.allowed, false, 'Re-bidding must be strictly blocked while NFT is LISTED');
  console.log('Case 15d PASSED: Re-bidding on same NFT strictly blocked while LISTED ✅');

  // Step 5: Floor dump occurs, NFT marked HOLDING - trade is still unresolved -> Re-bidding MUST STILL BE BLOCKED
  rebiddingManager.updateHoldStatus(testIdentifier, 'Floor dump protection active');
  const trackedAfterHold = rebiddingManager.getTrackedNft(testContract, testTokenId);
  assert.strictEqual(trackedAfterHold?.listingStatus, 'HOLDING', 'Listing status must update to HOLDING');

  const rebiddingBlockedHolding = rebiddingManager.canPlaceOfferOnNft(testContract, testTokenId, 1.50);
  assert.strictEqual(rebiddingBlockedHolding.allowed, false, 'Re-bidding must be strictly blocked while NFT is HOLDING');
  console.log('Case 15e PASSED: Re-bidding on same NFT strictly blocked while HOLDING ✅');

  // Step 6: Simultaneous Offers on DIFFERENT NFTs while earlier NFT is awaiting resale
  // Total capital: $10.00. 60% active offer allocation limit: $6.00.
  // Place offer on different NFT #1 (testContract:102) for $2.50
  const diffNft1Check = rebiddingManager.canPlaceOfferOnNft(testContract, '102', 2.50);
  assert.strictEqual(diffNft1Check.allowed, true, 'Offer on different NFT #102 must be allowed while earlier NFT awaits resale');
  rebiddingManager.registerActiveOffer({
    orderHash: 'offer_diff_1',
    collectionSlug: 'alpha-collection',
    contractAddress: testContract,
    tokenId: '102',
    priceEth: 0.000925,
    priceUsd: 2.50,
    createdTimestamp: Date.now(),
    expiresTimestamp: Date.now() + 3600000,
    status: 'ACTIVE'
  });

  // Place offer on different NFT #2 (diffContract:200) for $2.50 (Total offers = $2.50 + $2.50 = $5.00 <= $6.00)
  const diffContract = '0x9999888877776666555544443333222211110000';
  const diffNft2Check = rebiddingManager.canPlaceOfferOnNft(diffContract, '200', 2.50);
  assert.strictEqual(diffNft2Check.allowed, true, 'Simultaneous offer on NFT #200 across different collection must be allowed');
  rebiddingManager.registerActiveOffer({
    orderHash: 'offer_diff_2',
    collectionSlug: 'beta-collection',
    contractAddress: diffContract,
    tokenId: '200',
    priceEth: 0.000925,
    priceUsd: 2.50,
    createdTimestamp: Date.now(),
    expiresTimestamp: Date.now() + 3600000,
    status: 'ACTIVE'
  });
  console.log('Case 15f PASSED: Simultaneous offers on multiple different NFTs running concurrently while earlier NFT awaits resale ✅');

  // Verify 60% capital allocation limit blocks third offer exceeding $6.00
  // Current active offers: $5.00. New offer: $2.00 -> $7.00 > $6.00 limit -> Must be blocked!
  const thirdOfferExceeded = rebiddingManager.canPlaceOfferOnNft(diffContract, '201', 2.00);
  assert.strictEqual(thirdOfferExceeded.allowed, false, 'Third simultaneous offer exceeding 60% capital limit ($7.00 > $6.00) must be blocked');
  console.log('Case 15g PASSED: 60% capital allocation limit enforced across simultaneous offers ✅');

  // Verify independent tracking of multiple NFTs simultaneously
  const tracked102 = rebiddingManager.getTrackedNft(testContract, '102');
  const tracked200 = rebiddingManager.getTrackedNft(diffContract, '200');
  assert(tracked102?.activeOffers.length === 1, 'NFT #102 must track its own active offer');
  assert(tracked200?.activeOffers.length === 1, 'NFT #200 must track its own active offer');
  console.log('Case 15h PASSED: Independent active offer tracking on distinct NFT tokens ✅');

  // Step 7: Earlier NFT is SOLD and SALE IS CONFIRMED
  const soldResult = rebiddingManager.markItemSold(testIdentifier, 0.0012, 2700, 100, 0.01, '0xtxhash123');
  assert.strictEqual(soldResult.saleConfirmation.confirmed, true, 'Sale confirmation must be true');

  const trackedAfterSale = rebiddingManager.getTrackedNft(testContract, testTokenId);
  assert.strictEqual(trackedAfterSale?.ownershipStatus, 'SOLD', 'Ownership status must be SOLD');
  assert.strictEqual(trackedAfterSale?.listingStatus, 'SOLD', 'Listing status must be SOLD');
  assert.strictEqual(trackedAfterSale?.saleConfirmation?.confirmed, true, 'Sale confirmation must be recorded');
  assert(rebiddingManager.isNftSaleConfirmed(testContract, testTokenId), 'isNftSaleConfirmed must return true');
  console.log('Case 15i PASSED: Confirmed sale recorded with full audit details and trade resolved ✅');

  // Step 8: After confirmed sale, re-bidding on same NFT is now ALLOWED (once all criteria pass again)
  // Let active offers expire or cancel to free up capital
  rebiddingManager.cancelActiveOffer('alpha-collection');
  rebiddingManager.cancelActiveOffer('beta-collection');

  const rebiddingAllowedPostSale = rebiddingManager.canPlaceOfferOnNft(testContract, testTokenId, 1.50);
  assert.strictEqual(rebiddingAllowedPostSale.allowed, true, 'Re-bidding on same NFT must now be allowed after confirmed sale');
  console.log('Case 15j PASSED: Re-bidding on same NFT allowed after confirmed sale ✅\n');

  // --------------------------------------------------------------------------
  // TEST 16: Failed Mint & Market Dump Protection Rules
  // Condition 1: Incomplete Public Mint — Strict Rejection
  // Condition 2: Market Dump Protection (30% eligible, 40% reject, 99% exclude)
  // --------------------------------------------------------------------------
  console.log('--- Test 16: Incomplete Public Mint & Market Dump Protection Rules ---');
  const circuitBreaker = new CircuitBreaker(config);

  // Case 16a: Incomplete public mint flag (mintCompleted: false) -> REJECT
  const incompleteMintMarketData: CollectionMarketData = {
    slug: 'incomplete-mint-nft',
    contractAddress: '0x1234000000000000000000000000000000000001',
    floorPriceEth: 0.002,
    topOfferEth: 0.001,
    numListings: 10,
    openseaFeeBps: 50,
    royaltyFeeBps: 100,
    ethPriceUsd: 2700,
    timestamp: Date.now(),
    sales3Hours: 15,
    uniqueWallets3Hours: 10,
    liquidityPassed: true,
    mintCompleted: false,
    mintDemandReason: 'Incomplete Public Mint: Public mint has not completed successfully. Strict Rejection ❌'
  };
  const calcIncompleteMint = pricingEngine.calculateMaxBid(incompleteMintMarketData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcIncompleteMint.checkMintCompletedPassed, false, 'checkMintCompletedPassed must be false when mintCompleted is false');
  assert.strictEqual(calcIncompleteMint.decision, 'REJECT', 'Must REJECT offer when public mint is incomplete');
  assert(calcIncompleteMint.reason?.includes('Incomplete Public Mint'), 'Reason must specify Incomplete Public Mint');
  console.log('Case 16a PASSED: Incomplete public mint flag triggers strict rejection ✅');

  // Case 16b: Active public mint with incomplete supply (isMinting: true, 500/5000 minted) -> REJECT
  const activeUnsoldMintData: CollectionMarketData = {
    ...incompleteMintMarketData,
    slug: 'struggling-mint-nft',
    mintCompleted: undefined, // Dynamic detection
    isMinting: true,
    totalSupply: 500,
    maxSupply: 5000
  };
  const calcActiveUnsold = pricingEngine.calculateMaxBid(activeUnsoldMintData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcActiveUnsold.checkMintCompletedPassed, false, 'checkMintCompletedPassed must be false when supply is struggling to sell out');
  assert.strictEqual(calcActiveUnsold.decision, 'REJECT', 'Must REJECT offer when mint supply remains incomplete');
  console.log('Case 16b PASSED: Active mint struggling to sell supply triggers strict rejection ✅');

  // Case 16b2: 99% Minted Collection (4950/5000) -> Must REJECT under strict 100% Mint-Out Rule
  const almostMintedData: CollectionMarketData = {
    ...incompleteMintMarketData,
    slug: 'almost-minted-nft',
    mintCompleted: undefined,
    isMinting: false,
    totalSupply: 4950,
    maxSupply: 5000
  };
  const verifyAlmostMinted = pricingEngine.verifyMintCompletion(almostMintedData);
  assert.strictEqual(verifyAlmostMinted.passed, false, 'Must REJECT collection even at 99% supply (strict 100% rule)');
  assert(verifyAlmostMinted.reason.includes('100%'), 'Reason must specify 100% mint supply requirement');
  const calcAlmostMinted = pricingEngine.calculateMaxBid(almostMintedData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcAlmostMinted.decision, 'REJECT', 'Must REJECT 99% minted collection');
  console.log('Case 16b2 PASSED: 99% minted collection strictly rejected (100% Mint-Out Rule) ✅');

  // Case 16b3: Unverified Mint Status -> Must REJECT (Rule 4: If status cannot be verified, do not offer)
  const unverifiedMintData: CollectionMarketData = {
    ...incompleteMintMarketData,
    slug: 'unverified-mint-nft',
    mintCompleted: undefined,
    mintStatusVerified: false,
    totalSupply: undefined,
    maxSupply: undefined
  };
  const verifyUnverified = pricingEngine.verifyMintCompletion(unverifiedMintData);
  assert.strictEqual(verifyUnverified.passed, false, 'Must REJECT offer when mint status cannot be verified');
  const calcUnverified = pricingEngine.calculateMaxBid(unverifiedMintData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcUnverified.decision, 'REJECT', 'Must REJECT offer when mint status cannot be verified');
  console.log('Case 16b3 PASSED: Unverified mint status triggers strict rejection ✅');

  // Case 16b4: No Exceptions or Overrides (Rule 5: Volume, floor price, or potential profit CANNOT override)
  const highProfitIncompleteMint = pricingEngine.evaluateOfferScenario({
    offerPriceUsd: 1.00,
    floorPriceUsd: 10.00, // Massive 10x spread
    mintCompleted: false, // Incomplete mint!
    royaltyPercent: 0,
    minNetProfitUsd: 0.20
  });
  assert.strictEqual(highProfitIncompleteMint.checkMintCompletedPassed, false, 'Mint check must fail despite massive potential profit');
  assert.strictEqual(highProfitIncompleteMint.decision, 'REJECT', 'High profit cannot override incomplete mint rule');
  console.log('Case 16b4 PASSED: No exceptions - potential profit cannot override 100% mint rule ✅');

  // Case 16c: Mint-demand failed / unreliable secondary market liquidity -> REJECT
  const poorLiquidityMintData: CollectionMarketData = {
    ...incompleteMintMarketData,
    slug: 'low-demand-mint-nft',
    mintCompleted: true,
    liquidityPassed: false,
    liquidityReason: 'Low secondary-market liquidity: 2 sales in 3h'
  };
  const calcPoorLiquidity = pricingEngine.calculateMaxBid(poorLiquidityMintData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcPoorLiquidity.checkMintCompletedPassed, false, 'checkMintCompletedPassed must fail when secondary market liquidity is unreliable');
  assert.strictEqual(calcPoorLiquidity.decision, 'REJECT', 'Must REJECT offer when secondary market demand fails');
  console.log('Case 16c PASSED: Incomplete secondary-market demand triggers strict rejection ✅');

  // Case 16d: Valid 100% mint completion (5000/5000) & healthy secondary demand -> Passed
  const validMintData: CollectionMarketData = {
    ...incompleteMintMarketData,
    slug: 'completed-mint-nft',
    mintCompleted: true,
    mintStatusVerified: true,
    totalSupply: 5000,
    maxSupply: 5000,
    isMinting: false,
    liquidityPassed: true,
    sales3Hours: 12,
    uniqueWallets3Hours: 8
  };
  const mintVerification = pricingEngine.verifyMintCompletion(validMintData);
  assert.strictEqual(mintVerification.passed, true, 'Mint completion check must pass when 100% minted and liquidity is verified');
  console.log('Case 16d PASSED: Verified 100% mint completion and secondary-market demand passed ✅');

  // Case 16e: Market Dump Protection - 30% floor decline ($1.00 -> $0.70)
  // Reference Floor: $1.00, Current Floor: $0.70 -> 30% decline -> ELIGIBLE
  const dump30Check = circuitBreaker.evaluateMarketDumpProtection('dump-test-slug', 0.00025926, 0.00037037); // $0.70 vs $1.00 @ 2700 ETH
  assert.strictEqual(dump30Check.allowed, true, '30% floor decline must be allowed for further checks');
  assert.strictEqual(dump30Check.action, 'ELIGIBLE', '30% floor decline action must be ELIGIBLE');
  assert(Math.abs(dump30Check.declinePercent - 30.0) < 0.5, 'Decline percent should be ~30%');
  console.log('Case 16e PASSED: 30% floor decline allows collection for further checks (ELIGIBLE) ✅');

  // Case 16f: Market Dump Protection - 40% floor decline ($1.00 -> $0.60) -> REJECT
  // Reference Floor: $1.00, Current Floor: $0.60 -> 40% decline -> AUTOMATIC REJECTION
  const dump40Check = circuitBreaker.evaluateMarketDumpProtection('dump-test-slug', 0.00022222, 0.00037037); // $0.60 vs $1.00 @ 2700 ETH
  assert.strictEqual(dump40Check.allowed, false, '40% floor decline must NOT be allowed');
  assert.strictEqual(dump40Check.action, 'REJECT', '40% floor decline action must be REJECT');
  assert(Math.abs(dump40Check.declinePercent - 40.0) < 0.5, 'Decline percent should be ~40%');
  console.log('Case 16f PASSED: 40% floor decline automatically rejected (REJECT) ✅');

  // Case 16g: Market Dump Protection - 99% extreme collapse ($1.00 -> $0.01) -> EXCLUDE
  // Reference Floor: $1.00, Current Floor: $0.01 -> 99% collapse -> PERMANENT EXCLUSION
  const dump99Check = circuitBreaker.evaluateMarketDumpProtection('collapsed-slug', 0.0000037, 0.00037037); // $0.01 vs $1.00 @ 2700 ETH
  assert.strictEqual(dump99Check.allowed, false, '99% floor collapse must NOT be allowed');
  assert.strictEqual(dump99Check.action, 'EXCLUDE', '99% floor collapse action must be EXCLUDE');
  assert.strictEqual(circuitBreaker.isCollectionPermanentlyExcluded('collapsed-slug'), true, 'Collapsed collection must be added to permanentlyExcludedCollections');
  console.log('Case 16g PASSED: 99% collapse permanently excludes collection from new offers (EXCLUDE) ✅');

  // Case 16h: Subsequent offer attempts on permanently excluded collection are strictly blocked
  const subsequentBlocked = circuitBreaker.evaluateMarketDumpProtection('collapsed-slug', 0.00025926); // Even if price attempts recovery
  assert.strictEqual(subsequentBlocked.allowed, false, 'Subsequent attempts on permanently excluded collection must remain blocked');
  assert.strictEqual(subsequentBlocked.action, 'EXCLUDE', 'Action must remain EXCLUDE');
  console.log('Case 16h PASSED: Permanently excluded collection remains blocked on subsequent attempts ✅');

  // Case 16i: User reviews and explicitly re-enables collection -> Exclusion cleared
  circuitBreaker.reEnableCollection('collapsed-slug');
  assert.strictEqual(circuitBreaker.isCollectionPermanentlyExcluded('collapsed-slug'), false, 'Collection must no longer be permanently excluded after user re-enables it');
  const postReEnableCheck = circuitBreaker.evaluateMarketDumpProtection('collapsed-slug', 0.00037037);
  assert.strictEqual(postReEnableCheck.allowed, true, 'Collection must be allowed after explicit re-enable');
  console.log('Case 16i PASSED: User review and explicit re-enable clears permanent exclusion ✅\n');

  // --------------------------------------------------------------------------
  // TEST 17: Automatic Offer Cancellation — 20-Minute Rule
  // 1. Offer Expiry: Automatically cancelled if unaccepted within 20 minutes.
  // 2. Automatic Cancellation: Tracks creation time and initiates cancellation at 20 minutes.
  // 3. Cancellation Verification: Verify offer is no longer active before treating as cancelled.
  //    If cancellation fails, retry or flag for immediate attention; must not assume capital released.
  // 4. Re-Filtering Before Re-Offering: All eligibility checks must run again.
  // 5. Re-Offer Rule: If all pass -> place new offer. If any fail -> skip NFT.
  // --------------------------------------------------------------------------
  console.log('--- Test 17: Automatic Offer Cancellation — 20-Minute Rule ---');
  const cancelTestInv = new InventoryManager(config);
  const ephemeralWallet = Wallet.createRandom();
  const cancelTestSeaport = new SeaportService(config, ephemeralWallet);
  const cancelTestApi = new OpenSeaApiService(config);
  const cancelTestCb = new CircuitBreaker(config);
  const cancelBidder = new CollectionBidderStrategy(
    config,
    cancelTestApi,
    pricingEngine,
    cancelTestSeaport,
    cancelTestInv,
    cancelTestCb
  );

  const t0 = Date.now();

  // Case 17a: Offer Expiry & Tracking creation time
  // Active offer placed tracks creation time and locks capital
  cancelTestInv.registerActiveOffer({
    orderHash: 'offer_test_20m',
    collectionSlug: 'cryptopunks-minimal',
    contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    tokenId: '1001',
    network: 'robinhood',
    priceEth: 0.001,
    priceUsd: 2.70,
    createdTimestamp: t0,
    expiresTimestamp: t0 + 20 * 60 * 1000,
    status: 'ACTIVE'
  });

  assert.strictEqual(cancelTestInv.getActiveOffersCapitalUsd(), 2.70, 'Capital must be locked for active offer');
  assert.strictEqual(cancelTestInv.getAvailableCapitalUsd(), 7.30, 'Available capital must be $7.30');

  // When offer is < 20 minutes old (e.g. 5m elapsed), must NOT be cancelled prematurely
  const youngOffers = cancelTestInv.getOffersExceeding20Minutes(20 * 60 * 1000);
  assert.strictEqual(youngOffers.length, 0, 'Offers < 20 minutes old must NOT be marked for cancellation');
  console.log('Case 17a PASSED: Offer creation tracks creation time and is NOT prematurely cancelled under 20 minutes ✅');

  // Case 17b: Automatic Cancellation: 20-minute limit expires -> Initiates cancellation
  // Simulate 20 minutes and 1 second having elapsed
  const offerToCancel = cancelTestInv.getActiveOffer('offer_test_20m')!;
  offerToCancel.createdTimestamp = t0 - (20 * 60 * 1000 + 1000); // 20m 1s ago
  offerToCancel.expiresTimestamp = t0 - 1000;

  const expiredOffers = cancelTestInv.getOffersExceeding20Minutes(20 * 60 * 1000);
  assert.strictEqual(expiredOffers.length, 1, 'Offer exceeding 20 minutes must be identified for cancellation');
  assert.strictEqual(expiredOffers[0].orderHash, 'offer_test_20m', 'Correct offer must be targeted');
  console.log('Case 17b PASSED: Bot tracks creation time and identifies unaccepted offer at 20-minute limit ✅');

  // Case 17c: Cancellation Verification: Fails verification -> Capital is NOT assumed released!
  cancelTestApi.setMockOrderState('offer_test_20m', { isCancelled: false, verificationFails: true });
  await cancelBidder.processAutomaticOfferCancellations(20);

  // Capital must STILL be locked ($2.70 locked, $7.30 available)!
  assert.strictEqual(
    cancelTestInv.getActiveOffersCapitalUsd(),
    2.70,
    'Capital must NOT be released when cancellation verification fails!'
  );
  assert.strictEqual(
    cancelTestInv.getAvailableCapitalUsd(),
    7.30,
    'Available capital must not increase when cancellation fails!'
  );
  assert.strictEqual(
    offerToCancel.status,
    'CANCELLATION_PENDING',
    'Offer status must remain CANCELLATION_PENDING on first verification failure'
  );
  console.log('Case 17c PASSED: Cancellation failure/unverified state strictly keeps capital locked ✅');

  // Case 17d: Cancellation Verification: Repeated failures flag offer for immediate attention and capital remains locked
  await cancelBidder.processAutomaticOfferCancellations(20); // Attempt 2
  await cancelBidder.processAutomaticOfferCancellations(20); // Attempt 3 (reaches max retries)

  assert.strictEqual(offerToCancel.status, 'CANCELLATION_FAILED', 'Status must transition to CANCELLATION_FAILED');
  assert.strictEqual(offerToCancel.flaggedForAttention, true, 'Offer must be flagged for immediate manual attention');
  assert.strictEqual(cancelTestInv.getOffersFlaggedForAttention().length, 1, 'Flagged list must contain the failed offer');
  assert.strictEqual(
    cancelTestInv.getActiveOffersCapitalUsd(),
    2.70,
    'Capital must STILL remain locked even after failure flagging!'
  );
  console.log('Case 17d PASSED: Max cancellation retries flag offer for immediate attention without releasing capital ✅');

  // Case 17e: Re-offering blocked while cancellation is unverified / failed
  const reOfferBeforeVerify = cancelTestInv.canPlaceOfferOnNft(
    '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    '1001',
    2.70
  );
  assert.strictEqual(
    reOfferBeforeVerify.allowed,
    false,
    'Re-offering must be blocked while previous offer cancellation is unverified / pending / failed'
  );
  console.log('Case 17e PASSED: Re-offering strictly blocked while previous offer cancellation is unconfirmed ✅');

  // Case 17f: Cancellation Verification confirmed -> Capital is released!
  cancelTestApi.setMockOrderState('offer_test_20m', { isCancelled: true, verificationFails: false });
  await cancelBidder.processAutomaticOfferCancellations(20);

  assert.strictEqual(
    cancelTestInv.getActiveOffersCapitalUsd(),
    0.0,
    'Capital must be fully released only after cancellation is confirmed!'
  );
  assert.strictEqual(
    cancelTestInv.getAvailableCapitalUsd(),
    10.0,
    'Total available capital must return to $10.00 after confirmed cancellation'
  );
  assert.strictEqual(
    cancelTestInv.getActiveOffer('offer_test_20m'),
    undefined,
    'Offer must be cleared from active tracking once confirmed cancelled'
  );
  console.log('Case 17f PASSED: Cancellation verified and confirmed releases capital back to pool ✅');

  // Case 17g: Re-Filtering - Native ETH floor-sales criteria fails (< 10 sales in 3h) -> Skip NFT
  const baseEligibleData: CollectionMarketData = {
    slug: 'cryptopunks-minimal',
    contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    floorPriceEth: 0.002,
    topOfferEth: 0.0008,
    numListings: 15,
    openseaFeeBps: 50,
    royaltyFeeBps: 0,
    ethPriceUsd: 2700,
    timestamp: Date.now(),
    sales3Hours: 6, // FAILING: Only 6 sales in 3h (< 10 required)
    uniqueWallets3Hours: 6,
    liquidityPassed: false,
    liquidityReason: 'Only 6 native ETH floor sales in last 3h (< 10 required)',
    mintCompleted: true,
    mintStatusVerified: true,
    totalSupply: 1000,
    maxSupply: 1000
  };
  const calcFailedSales = pricingEngine.calculateMaxBid(baseEligibleData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcFailedSales.checkLLiquidityPassed, false, 'Liquidity check must fail on sales volume');
  assert.strictEqual(calcFailedSales.decision, 'REJECT', 'Must REJECT offer when floor sales < 10');
  console.log('Case 17g PASSED: Re-filtering rejects NFT when native ETH floor sales < 10 in 3h ✅');

  // Case 17h: Re-Filtering - Unique-wallet count fails (< 5 unique wallets in 3h) -> Skip NFT
  const failedWalletsData: CollectionMarketData = {
    ...baseEligibleData,
    sales3Hours: 12,
    uniqueWallets3Hours: 3, // FAILING: Only 3 unique wallets (< 5 required)
    liquidityPassed: false,
    liquidityReason: 'Only 3 unique wallets in last 3h (< 5 required)'
  };
  const calcFailedWallets = pricingEngine.calculateMaxBid(failedWalletsData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcFailedWallets.checkLLiquidityPassed, false, 'Liquidity check must fail on unique wallets');
  assert.strictEqual(calcFailedWallets.decision, 'REJECT', 'Must REJECT offer when unique wallets < 5');
  console.log('Case 17h PASSED: Re-filtering rejects NFT when unique wallets < 5 in 3h ✅');

  // Case 17i: Re-Filtering - Market Dump Protection triggers (>= 40% decline) -> Skip NFT
  const dumpReCheck = cancelTestCb.evaluateMarketDumpProtection('cryptopunks-minimal', 0.00055, 0.0010); // 45% decline
  assert.strictEqual(dumpReCheck.allowed, false, 'Market Dump Protection must reject collection with >= 40% decline');
  assert.strictEqual(dumpReCheck.action, 'REJECT', 'Action must be REJECT');
  console.log('Case 17i PASSED: Re-filtering rejects NFT when floor dumped by >= 40% ✅');

  // Case 17j: Re-Filtering - Incomplete Public Mint fails -> Skip NFT
  const failedMintData: CollectionMarketData = {
    ...baseEligibleData,
    sales3Hours: 15,
    uniqueWallets3Hours: 8,
    liquidityPassed: true,
    mintCompleted: false, // FAILING
    mintDemandReason: 'Incomplete Public Mint: Public mint has not completed successfully'
  };
  const mintCheckResult = pricingEngine.verifyMintCompletion(failedMintData);
  assert.strictEqual(mintCheckResult.passed, false, 'Mint completion check must fail');
  const calcFailedMint = pricingEngine.calculateMaxBid(failedMintData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcFailedMint.decision, 'REJECT', 'Must REJECT offer when public mint is incomplete');
  console.log('Case 17j PASSED: Re-filtering rejects NFT when public mint is incomplete ✅');

  // Case 17k: Re-Filtering - Floor ratio requirement fails (Floor < 1.30 * Offer) -> Skip NFT
  const failedFloorRatio = pricingEngine.evaluateOfferScenario({
    offerPriceUsd: 2.00,
    floorPriceUsd: 2.30, // Floor $2.30 < $2.00 * 1.30 = $2.60 (Only 15% higher instead of 30%)
    royaltyPercent: 0,
    availableCapitalUsd: 10.0,
    minNetProfitUsd: 0.20,
    enforceFloorRatio: true
  });
  assert.strictEqual(failedFloorRatio.checkFFloorRatioPassed, false, 'Floor ratio check must fail');
  assert.strictEqual(failedFloorRatio.decision, 'REJECT', 'Must REJECT offer when floor < 1.30 * offer');
  console.log('Case 17k PASSED: Re-filtering rejects NFT when floor price is < 1.30 * offer price ✅');

  // Case 17l: Re-Filtering - Capital allocation limit fails (> 60% of total capital) -> Skip NFT
  // Register $5.50 active offer in another collection
  cancelTestInv.registerActiveOffer({
    orderHash: 'other_active_offer',
    collectionSlug: 'other-collection',
    contractAddress: '0x2222000000000000000000000000000000000002',
    priceEth: 0.002,
    priceUsd: 5.50,
    createdTimestamp: Date.now(),
    expiresTimestamp: Date.now() + 20 * 60 * 1000,
    status: 'ACTIVE'
  });
  // Attempting $2.00 offer: $5.50 + $2.00 = $7.50 > $7.00 (70% of $10.00)
  const capitalExceededCheck = cancelTestInv.canAllocateCapitalForOffer(2.00);
  assert.strictEqual(capitalExceededCheck.allowed, false, 'Must reject offer that exceeds 70% allocation limit');
  assert(capitalExceededCheck.reason?.includes('allocation limit'), 'Reason must specify capital allocation limit');
  console.log('Case 17l PASSED: Re-filtering rejects NFT when capital allocation limit (>70%) would be exceeded ✅');

  // Case 17m: Re-Offer Rule - All conditions pass -> New offer permitted!
  cancelTestInv.cancelActiveOffer('other-collection'); // Clear the temporary offer
  assert.strictEqual(cancelTestInv.getActiveOffersCapitalUsd(), 0.0);

  const allPassingData: CollectionMarketData = {
    slug: 'cryptopunks-minimal',
    contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    floorPriceEth: 0.0016, // ~$4.32 floor
    topOfferEth: 0.0006,
    numListings: 20,
    openseaFeeBps: 50,
    royaltyFeeBps: 0,
    ethPriceUsd: 2700,
    timestamp: Date.now(),
    sales3Hours: 16, // PASSED: >= 10
    uniqueWallets3Hours: 9, // PASSED: >= 5
    liquidityPassed: true,
    mintCompleted: true,
    mintStatusVerified: true,
    totalSupply: 1000,
    maxSupply: 1000,
    referenceFloorEth: 0.00165,
    floorDeclinePercent: 3.0 // PASSED: < 40%
  };

  const calcPassing = pricingEngine.calculateMaxBid(allPassingData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calcPassing.checkLLiquidityPassed, true, 'Liquidity check must pass');
  assert.strictEqual(calcPassing.checkFFloorRatioPassed, true, 'Floor ratio check must pass');
  assert.strictEqual(calcPassing.checkACapitalPassed, true, 'Capital check must pass');
  assert.strictEqual(calcPassing.checkBProfitPassed, true, 'Profit check must pass');
  assert.strictEqual(calcPassing.decision, 'ACCEPT', 'Decision must be ACCEPT');
  assert.strictEqual(calcPassing.isProfitable, true, 'Trade must be profitable');

  // Place fresh re-offer after confirmed cancellation and passing all filters
  cancelTestInv.registerActiveOffer({
    orderHash: 'new_reoffer_punks',
    collectionSlug: 'cryptopunks-minimal',
    contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    priceEth: calcPassing.bidPriceEth,
    priceUsd: calcPassing.bidPriceUsd,
    createdTimestamp: Date.now(),
    expiresTimestamp: Date.now() + 20 * 60 * 1000,
    status: 'ACTIVE'
  });

  const activeReoffer = cancelTestInv.getActiveOffer('new_reoffer_punks');
  assert(activeReoffer !== undefined, 'New offer must be placed and actively tracked');
  assert.strictEqual(activeReoffer?.status, 'ACTIVE', 'New offer must be active');
  assert(activeReoffer?.expiresTimestamp > Date.now(), 'Fresh 20-minute countdown initialized');
  console.log('Case 17m PASSED: Re-offer placed successfully after confirmed cancellation and all eligibility filters pass again! ✅\n');

  // --------------------------------------------------------------------------
  // TEST 18: Automatic Post-Sale ETH to WETH Conversion Rule (90% WETH, 10% Gas Reserve)
  // After an NFT is sold, the bot must automatically convert 90% of the ETH received into WETH
  // for future NFT offers and hold the remaining 10% of the ETH as a gas fee reserve.
  // --------------------------------------------------------------------------
  console.log('--- Test 18: Automatic Post-Sale ETH to WETH Conversion Rule (90% WETH, 10% Gas Reserve) ---');
  const postSaleInvManager = new InventoryManager(config);
  const testSoldContract = '0x9999888877776666555544443333222211110000';
  const testSoldTokenId = '777';
  const testSoldIdentifier = `${testSoldContract.toLowerCase()}:${testSoldTokenId}`;

  // Step 1: Add acquired NFT to inventory and list it at floor price (0.002 ETH)
  postSaleInvManager.addInventoryItem({
    identifier: testSoldIdentifier,
    collectionSlug: 'swap-rule-collection',
    contractAddress: testSoldContract,
    tokenId: testSoldTokenId,
    acquiredPriceEth: 0.001,
    currentListingPriceEth: 0.002,
    network: 'robinhood',
    acquiredAtTimestamp: Date.now(),
    status: 'LISTED'
  });

  // Step 2: Simulate NFT is sold at floor price on OpenSea (0.002 ETH with 100 bps combined fee)
  // Fee = 0.002 * 1% = 0.00002 ETH. Net Proceeds = 0.002 - 0.00002 = 0.00198 ETH
  const saleEventResult = postSaleInvManager.markItemSold(
    testSoldIdentifier,
    0.002, // floor price
    2700,
    100 // 100 bps fee
  );

  assert.strictEqual(saleEventResult.netProceedsEth, 0.00198, 'Net proceeds must equal floor price minus fees (0.00198 ETH)');
  assert.strictEqual(saleEventResult.soldItem?.network, 'robinhood', 'Sold item must retain network metadata');
  console.log('Case 18a PASSED: NFT sold at floor price. Net proceeds calculated accurately: ' + saleEventResult.netProceedsEth + ' ETH ✅');

  // Step 3: Execute immediate automatic conversion from received ETH: 90% to WETH, 10% held as gas fee reserve
  const testSigner = Wallet.createRandom();
  const testSeaport = new SeaportService(config, testSigner);

  // Set BOT_MODE to SIMULATION to test swap logic
  const originalBotMode = process.env.BOT_MODE;
  process.env.BOT_MODE = 'SIMULATION';

  const swapResult = await testSeaport.handlePostSaleEthConversion(saleEventResult.netProceedsEth, 'robinhood');
  assert.strictEqual(swapResult.success, true, 'Immediate post-sale ETH conversion must succeed');
  assert.strictEqual(swapResult.amountWrappedEth, 0.001782, 'Amount wrapped must be exactly 90% of net ETH proceeds (0.00198 * 0.9 = 0.001782 ETH)');
  assert.strictEqual(swapResult.gasReserveRetainedEth, 0.000198, 'Gas reserve retained must be exactly 10% of net ETH proceeds (0.00198 * 0.1 = 0.000198 ETH)');
  assert(swapResult.txHash?.startsWith('0xsim_weth_deposit_'), 'Swap transaction hash must be recorded');
  console.log('Case 18b PASSED: Received ETH (' + saleEventResult.netProceedsEth + ' ETH) automatically converted: 90% (' + swapResult.amountWrappedEth + ' ETH) -> WETH, 10% (' + swapResult.gasReserveRetainedEth + ' ETH) held as gas fee reserve! ✅');

  // Step 4: Test wallet reconciliation trigger for 90% WETH conversion and 10% gas fee reserve
  postSaleInvManager.addInventoryItem({
    identifier: `${testSoldContract.toLowerCase()}:888`,
    collectionSlug: 'swap-rule-collection',
    contractAddress: testSoldContract,
    tokenId: '888',
    acquiredPriceEth: 0.001,
    currentListingPriceEth: 0.0025,
    network: 'robinhood',
    acquiredAtTimestamp: Date.now(),
    status: 'LISTED'
  });

  // Reconcile when NFT is sold on-chain (disappears from wallet AND a confirmed sale event exists)
  const reconciledSales = postSaleInvManager.reconcileWalletInventory([], 2700, new Map([[`${testSoldContract.toLowerCase()}:888`, { salePriceEth: 0.0025, txHash: '0xsale18c' }]]));
  assert.strictEqual(reconciledSales.length, 1, 'Reconciliation must detect 1 sold NFT');
  assert.strictEqual(reconciledSales[0].netProceedsEth, 0.002475, 'Reconciled sale proceeds must be 0.002475 ETH (0.0025 - 1% fee)');

  const reconcileSwap = await testSeaport.handlePostSaleEthConversion(reconciledSales[0].netProceedsEth, reconciledSales[0].network);
  assert.strictEqual(reconcileSwap.success, true, 'Reconciled sale ETH to WETH conversion must succeed');
  assert.strictEqual(reconcileSwap.amountWrappedEth, 0.002228, 'Reconciled amount wrapped must be exactly 90% of proceeds (0.002475 * 0.9 = 0.002228 ETH)');
  assert.strictEqual(reconcileSwap.gasReserveRetainedEth, 0.000247, 'Reconciled gas reserve must be the remaining ~10% of proceeds (0.002475 - 0.002228 = 0.000247 ETH)');
  console.log('Case 18c PASSED: Reconciled sale automatically triggers 90% WETH conversion (' + reconcileSwap.amountWrappedEth + ' ETH) & 10% gas reserve (' + reconcileSwap.gasReserveRetainedEth + ' ETH)! ✅\n');

  // --------------------------------------------------------------------------
  // TEST 19: Automatic Offer Cancellation & Re-entry Rules
  // 1. Cancel When Outbid: If another buyer places a higher offer, automatically cancel existing offer.
  // 2. Recheck Eligibility: After cancellation, continue monitoring and place new offer ONLY if all criteria met.
  // 3. 20-Minute Expiry: If not accepted within 20 minutes, automatically cancel.
  // 4. Re-entry After Expiry: Recheck all trading criteria and place new offer only if qualifying.
  // 5. No Stale Offers: Never leave outdated offers active after being outbid or after 20-minute expiry.
  // --------------------------------------------------------------------------
  console.log('--- Test 19: Automatic Offer Cancellation & Re-entry Rules ---');
  const test19InvManager = new InventoryManager(config);
  const test19Signer = Wallet.createRandom();
  const test19Api = new OpenSeaApiService(config);
  const test19Seaport = new SeaportService(config, test19Signer);
  const test19Breaker = new CircuitBreaker(config);
  const test19Bidder = new CollectionBidderStrategy(
    config,
    test19Api,
    pricingEngine,
    test19Seaport,
    test19InvManager,
    test19Breaker
  );

  // Case 19a: Outbid Scenario -> Cancel When Outbid -> Recheck Criteria -> Re-offer when eligible
  const test19Slug = 'outbid-reentry-collection';
  const test19Contract = '0x1111222233334444555566667777888899990001';

  // Register existing bot offer at 0.001 ETH
  test19InvManager.registerActiveOffer({
    orderHash: 'offer_outbid_initial',
    collectionSlug: test19Slug,
    contractAddress: test19Contract,
    network: 'robinhood',
    priceEth: 0.001,
    priceUsd: 2.70,
    createdTimestamp: Date.now() - 5 * 60 * 1000, // 5 minutes old (not expired yet)
    expiresTimestamp: Date.now() + 15 * 60 * 1000,
    status: 'ACTIVE'
  });

  // Mock OpenSea market data: another buyer placed higher offer of 0.0011 ETH!
  // Floor is 0.0020 ETH, 12 sales in 3h native ETH, 100% minted
  (test19Api as any).getCollectionMarketData = async () => ({
    collectionSlug: test19Slug,
    contractAddress: test19Contract,
    floorPriceEth: 0.0020,
    topOfferEth: 0.0011, // Outbid!
    openseaFeeBps: 50,
    royaltyFeeBps: 0,
    creatorFeeDisabled: true,
    ethPriceUsd: 2700,
    sales3Hours: 12,
    sales1Hour: 5,
    uniqueWallets3Hours: 6,
    liquidityPassed: true,
    mintCompleted: true,
    mintStatusVerified: true,
    totalSupply: 10000,
    maxSupply: 10000,
    referenceFloorEth: 0.0020
  });
  // Outbid detection uses the lightweight competing-offers lookup (not full market-data gates)
  (test19Api as any).getTopCompetingCollectionOffer = async () => ({ priceEth: 0.0011, orderHash: 'competitor_higher' });

  (test19Api as any).cancelOffer = async () => ({ success: true });
  (test19Api as any).verifyOfferInactive = async () => ({ isInactive: true });
  (test19Api as any).postCollectionOffer = async () => ({ order_hash: 'offer_outbid_reentered' });
  (test19Seaport as any).getWethBalance = async () => 1.0;

  // Run outbid cancellation scan
  const outbidScanResult = await test19Bidder.processOutbidOfferCancellations();
  assert.strictEqual(outbidScanResult.cancelled, 1, 'Process outbid cancellations must cancel 1 outbid offer');
  assert.strictEqual(test19InvManager.getActiveOffer('offer_outbid_initial'), undefined, 'Outbid offer must no longer be active in inventory');
  console.log('Case 19a-1 PASSED: Outbid offer automatically detected, cancelled, and verified ✅ Stale offer removed!');

  // Now evaluate collection: bot rechecks all criteria and places new higher competitive offer because it is eligible
  await (test19Bidder as any).processCollectionBid({
    name: 'Outbid Re-entry Collection',
    slug: test19Slug,
    contractAddress: test19Contract,
    network: 'robinhood',
    targetNetProfitUsd: 0.20
  }, 'robinhood');

  const newReenteredOffer = test19InvManager.getActiveOffer(test19Slug);
  assert(newReenteredOffer !== undefined, 'Bot must re-offer on collection after cancellation when criteria qualify');
  assert.strictEqual(newReenteredOffer.orderHash, 'offer_outbid_reentered', 'New offer must be registered');
  assert(newReenteredOffer.priceEth > 0.001, 'New offer price must be higher than previous outbid offer');
  console.log('Case 19a-2 PASSED: Recheck Eligibility confirmed criteria satisfied -> New offer placed at ' + newReenteredOffer.priceEth + ' ETH! ✅\n');

  // Case 19b: Outbid Scenario where outbid price makes re-offer INELIGIBLE (Floor ratio fails or profit negative)
  // Another buyer bids 0.0018 ETH on floor of 0.0020 ETH (Floor is NOT 30% higher: 0.0020 < 0.0018 * 1.30 = 0.00234)
  (test19Api as any).getCollectionMarketData = async () => ({
    collectionSlug: test19Slug,
    contractAddress: test19Contract,
    floorPriceEth: 0.0020,
    topOfferEth: 0.0018, // High outbid! Floor ratio and net profit cannot be satisfied
    openseaFeeBps: 50,
    royaltyFeeBps: 0,
    creatorFeeDisabled: true,
    ethPriceUsd: 2700,
    sales3Hours: 12,
    sales1Hour: 5,
    uniqueWallets3Hours: 6,
    liquidityPassed: true,
    mintCompleted: true,
    mintStatusVerified: true,
    totalSupply: 10000,
    maxSupply: 10000,
    referenceFloorEth: 0.0020
  });
  (test19Api as any).getTopCompetingCollectionOffer = async () => ({ priceEth: 0.0018, orderHash: 'competitor_too_high' });

  // Execute processCollectionBid: should detect outbid -> cancel existing offer -> recheck criteria -> REJECT re-entry!
  await (test19Bidder as any).processCollectionBid({
    name: 'Outbid Re-entry Collection',
    slug: test19Slug,
    contractAddress: test19Contract,
    network: 'robinhood',
    targetNetProfitUsd: 0.20
  }, 'robinhood');

  const afterHighOutbidOffer = test19InvManager.getActiveOffer(test19Slug);
  assert.strictEqual(afterHighOutbidOffer, undefined, 'When outbid price causes criteria failure, re-entry must be rejected (0 active offers)');
  console.log('Case 19b PASSED: Outbid offer cancelled -> Recheck criteria failed (Floor < Offer * 1.30) -> Re-entry strictly rejected! No stale offer left active ✅\n');

  // Case 19c: 20-Minute Expiry -> Cancel -> Recheck Criteria -> Re-offer if eligible
  test19InvManager.registerActiveOffer({
    orderHash: 'offer_expired_20m',
    collectionSlug: 'expired-20m-collection',
    contractAddress: '0x2222333344445555666677778888999900001111',
    network: 'robinhood',
    priceEth: 0.001,
    priceUsd: 2.70,
    createdTimestamp: Date.now() - 21 * 60 * 1000, // 21 minutes old (> 20 min cutoff)
    expiresTimestamp: Date.now() + 10 * 60 * 1000,
    status: 'ACTIVE'
  });

  (test19Api as any).getCollectionMarketData = async () => ({
    collectionSlug: 'expired-20m-collection',
    contractAddress: '0x2222333344445555666677778888999900001111',
    floorPriceEth: 0.0025,
    topOfferEth: 0.0009,
    openseaFeeBps: 50,
    royaltyFeeBps: 0,
    creatorFeeDisabled: true,
    ethPriceUsd: 2700,
    sales3Hours: 15,
    sales1Hour: 5,
    uniqueWallets3Hours: 8,
    liquidityPassed: true,
    mintCompleted: true,
    mintStatusVerified: true,
    totalSupply: 10000,
    maxSupply: 10000,
    referenceFloorEth: 0.0025
  });
  (test19Api as any).postCollectionOffer = async () => ({ order_hash: 'offer_expired_reentered' });

  // Process automatic 20-minute cancellations
  const expireResult = await test19Bidder.processAutomaticOfferCancellations(20);
  assert.strictEqual(expireResult.cancelled, 1, 'Expired offer must be cancelled');
  assert.strictEqual(test19InvManager.getActiveOffer('offer_expired_20m'), undefined, 'Expired offer must be removed');

  // Re-evaluation: Criteria still qualify, so re-offer placed
  await (test19Bidder as any).processCollectionBid({
    name: 'Expired 20m Collection',
    slug: 'expired-20m-collection',
    contractAddress: '0x2222333344445555666677778888999900001111',
    network: 'robinhood',
    targetNetProfitUsd: 0.20
  }, 'robinhood');

  const reentered20mOffer = test19InvManager.getActiveOffer('expired-20m-collection');
  assert(reentered20mOffer !== undefined, 'Bot must re-offer after 20-minute expiry when criteria still qualify');
  assert.strictEqual(reentered20mOffer.orderHash, 'offer_expired_reentered', 'Re-entered offer must be active');
  console.log('Case 19c PASSED: 20-Minute Expiry -> Cancelled & Verified -> Criteria Rechecked -> Re-offered successfully ✅\n');

  // --------------------------------------------------------------------------
  // TEST 20: Mandatory Creator Fee Disable Rule
  // If creator fee is optional and can be disabled, bot must disable it before executing any NFT sale.
  // The bot must verify that the fee is disabled before proceeding with the sale.
  // --------------------------------------------------------------------------
  console.log('--- Test 20: Mandatory Creator Fee Disable Rule ---');
  const test20Signer = Wallet.createRandom();
  const test20Seaport = new SeaportService(config, test20Signer);

  // Case 20a: Optional Creator Fee is disabled to 0% and verified before sale
  const rawFeesWithOptional = [
    { recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', fee: 0.5, required: true },
    { recipient: '0x9999999999999999999999999999999999999999', fee: 5.0, required: false } // OPTIONAL creator fee
  ];

  const disableResult = test20Seaport.verifyAndDisableOptionalCreatorFees(rawFeesWithOptional);
  assert.strictEqual(disableResult.verified, true, 'Verification must pass');
  assert.strictEqual(disableResult.disabledCount, 1, 'Must detect 1 optional creator fee');
  assert.strictEqual(disableResult.effectiveFees.length, 1, 'Only required OpenSea fee must remain in effectiveFees');
  assert.strictEqual(disableResult.effectiveFees[0].recipient, '0x0000a26b00c1F0DF003000390027140000fAa719');

  // Create signed listing
  const signedListing = await test20Seaport.createSignedListing(
    '0x3333444455556666777788889999000011112222',
    '42',
    0.01,
    50,
    30,
    'robinhood',
    rawFeesWithOptional
  );

  // Pre-sale verification check
  const preSaleCheck = test20Seaport.verifyCreatorFeeDisabledBeforeSale(
    signedListing.orderComponents.consideration,
    rawFeesWithOptional
  );
  assert.strictEqual(preSaleCheck.verified, true, 'Pre-sale verification must confirm optional fee is disabled');
  assert.strictEqual(preSaleCheck.disabledFeesCount, 1, '1 optional creator fee verified disabled');

  // Verify that optional recipient received 0 ETH (is NOT in considerations)
  const optionalRecipientInConsideration = signedListing.orderComponents.consideration.find(
    (c: any) => c.recipient?.toLowerCase() === '0x9999999999999999999999999999999999999999'
  );
  assert.strictEqual(optionalRecipientInConsideration, undefined, 'Optional creator fee recipient must NOT receive consideration');
  console.log('Case 20a PASSED: Optional creator fee (5%) successfully disabled (0 bps) and verified before sale execution ✅');

  // Case 20b: Violation Detection - Sale strictly aborted if optional creator fee was not disabled
  const violationConsideration = [
    {
      itemType: 0,
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: '0',
      startAmount: '10000000000000000',
      endAmount: '10000000000000000',
      recipient: '0x9999999999999999999999999999999999999999' // Optional creator fee recipient included with payment!
    }
  ];

  const violationCheck = test20Seaport.verifyCreatorFeeDisabledBeforeSale(
    violationConsideration,
    rawFeesWithOptional
  );
  assert.strictEqual(violationCheck.verified, false, 'Pre-sale verification must FAIL if optional creator fee is present');
  assert(violationCheck.reason?.includes('VIOLATION'), 'Reason must indicate mandatory creator fee disable rule violation');
  console.log('Case 20b PASSED: Pre-sale verification strictly aborts sale if optional creator fee is not disabled: ' + violationCheck.reason + ' ✅\n');

  process.env.BOT_MODE = originalBotMode;

  console.log('================================================================');
  console.log('All 20 Capital Allocation, Liquidity, Floor Protection, Creator Fee, Inventory, NFT Eligibility, Re-Bidding, Mint & Market Dump, 20-Minute Cancellation, Post-Sale WETH Conversion, Outbid Cancellation & Re-entry, and Mandatory Creator Fee Disable tests passed successfully!');
  console.log('================================================================');
})().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});



