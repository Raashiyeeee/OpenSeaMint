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

/**
 * Trading Rules Regression Tests (fix/trading-rules)
 * Rule 1: Mint-out protection (positive verification, re-verified before every offer)
 * Rule 2: Cancel & re-entry (20-minute max offer age, documented cancel endpoint)
 * Rule 3: Optional creator fee disabled (0 bps) before sale
 * Rule 4: Profitability (floor >= offer * 1.30, net profit >= configured minimum)
 * Rule 5: Recent floor sales (>= 10 completed native ETH floor sales in last 3 hours)
 *
 * All network access is stubbed. No live markets are touched and no orders are posted.
 */

const config = loadConfig();
const pricingEngine = new PricingEngine(config);
const ZERO = '0x0000000000000000000000000000000000000000';

function baseMarketData(overrides: Partial<CollectionMarketData> = {}): CollectionMarketData {
  return {
    slug: 'rules-collection',
    contractAddress: '0x1111222233334444555566667777888899990abc',
    floorPriceEth: 0.0020,
    topOfferEth: 0.0006,
    numListings: 20,
    openseaFeeBps: 50,
    royaltyFeeBps: 0,
    ethPriceUsd: 2700,
    timestamp: Date.now(),
    sales3Hours: 12,
    uniqueWallets3Hours: 8,
    liquidityPassed: true,
    isMinting: false,
    mintCompleted: true,
    mintStatusVerified: true,
    totalSupply: 1000,
    maxSupply: 1000,
    referenceFloorEth: 0.0020,
    ...overrides
  };
}

function makeBidder(api: OpenSeaApiService, inv: InventoryManager): { bidder: CollectionBidderStrategy; seaport: SeaportService } {
  const seaport = new SeaportService(config, Wallet.createRandom());
  (seaport as any).getWethBalance = async () => 1.0;
  (seaport as any).createSignedCollectionOffer = async () => ({ orderComponents: {}, signature: '0xsig' });
  (seaport as any).createSignedItemOffer = async () => ({ orderComponents: {}, signature: '0xsig' });
  const bidder = new CollectionBidderStrategy(config, api, pricingEngine, seaport, inv, new CircuitBreaker(config));
  return { bidder, seaport };
}

(async () => {
  const originalBotMode = process.env.BOT_MODE;
  delete process.env.BOT_MODE;

  console.log('================================================================');
  console.log('Running Trading Rules Regression Tests');
  console.log('================================================================\n');

  // ------------------------------------------------------------------------
  // RULE 1: Mint-out protection
  // ------------------------------------------------------------------------
  console.log('--- Rule 1: Mint-Out Protection ---');
  // 1a. Missing supply data (cannot verify) -> reject, even if not flagged as minting
  const noSupply = pricingEngine.verifyMintCompletion(
    baseMarketData({ mintCompleted: undefined, mintStatusVerified: undefined, totalSupply: undefined, maxSupply: undefined })
  );
  assert.strictEqual(noSupply.passed, false, 'Unknown supply must be rejected');
  // 1b. Verified flag but total < max -> reject
  assert.strictEqual(pricingEngine.verifyMintCompletion(baseMarketData({ totalSupply: 999 })).passed, false, '99.9% minted must be rejected');
  // 1c. Total known but max unknown -> reject
  assert.strictEqual(pricingEngine.verifyMintCompletion(baseMarketData({ maxSupply: undefined })).passed, false, 'Unknown max supply must be rejected');
  // 1d. Fully verified 100% -> pass
  assert.strictEqual(pricingEngine.verifyMintCompletion(baseMarketData()).passed, true, 'Verified 100% mint-out must pass');
  console.log('Case R1a-d PASSED: Mint-out requires positive verification (total >= max, both known) ✅');

  // 1e. API: collection without max_supply -> mintStatusVerified false; with total == max -> verified
  const mintApi = new OpenSeaApiService(config);
  (mintApi as any).getEthPriceUsd = async () => 2700;
  (mintApi as any).getCollectionLiquidity = async () => ({
    sales3Hours: 12, uniqueWallets3Hours: 8, sales1Hour: 4, uniqueWallets1Hour: 4, liquidityPassed: true
  });
  let collectionPayload: any = { total_supply: 500, fees: [] };
  (mintApi as any).client = {
    get: async (url: string) => {
      if (url.startsWith('/collections/') && !url.includes('/stats')) return { data: collectionPayload };
      if (url.includes('/stats')) return { data: { total: { floor_price: 0.002, floor_price_symbol: 'ETH' } } };
      return { data: { offers: [] } };
    }
  };
  const noMax = await mintApi.getCollectionMarketData('rules-collection', ZERO);
  assert.strictEqual(noMax.mintStatusVerified, false, 'Missing max_supply must leave mint-out unverified');
  assert.strictEqual(noMax.mintCompleted, false, 'Missing max_supply must not be treated as minted out');
  collectionPayload = { total_supply: 500, max_supply: 500, is_minting: false, fees: [] };
  const fullMint = await mintApi.getCollectionMarketData('rules-collection', ZERO);
  assert.strictEqual(fullMint.mintStatusVerified, true, 'total == max must verify mint-out');
  assert.strictEqual(fullMint.mintCompleted, true, 'total == max must be minted out');
  console.log('Case R1e PASSED: API only marks mint-out verified when total_supply >= max_supply ✅');

  // 1f. Re-verification immediately before posting: fresh data shows incomplete mint -> no offer posted
  const reverifyApi = new OpenSeaApiService(config);
  let marketCalls = 0;
  let posted = 0;
  (reverifyApi as any).getCollectionMarketData = async () => {
    marketCalls++;
    // First fetch (evaluation) looks fully minted; the fresh pre-offer fetch reveals the mint is not complete
    return marketCalls === 1 ? baseMarketData() : baseMarketData({ totalSupply: 900, mintCompleted: false });
  };
  (reverifyApi as any).postCollectionOffer = async () => { posted++; return { order_hash: 'should_not_post' }; };
  const r1Inv = new InventoryManager(config);
  const { bidder: r1Bidder } = makeBidder(reverifyApi, r1Inv);
  await (r1Bidder as any).processCollectionBid(
    { name: 'R1', slug: 'rules-collection', contractAddress: baseMarketData().contractAddress, targetNetProfitUsd: 0.20, maxBidEth: 1 },
    'robinhood'
  );
  assert(marketCalls >= 2, 'Mint-out must be re-fetched immediately before the offer');
  assert.strictEqual(posted, 0, 'No offer may be posted when fresh mint-out check fails');
  console.log('Case R1f PASSED: Fresh mint-out re-verification blocks offer right before posting ✅');

  // 1g. Re-verification API failure -> reject
  const failingApi = new OpenSeaApiService(config);
  (failingApi as any).getCollectionMarketData = async () => { throw new Error('network down'); };
  const { bidder: failBidder } = makeBidder(failingApi, new InventoryManager(config));
  const failCheck = await failBidder.reverifyMintOutBeforeOffer('rules-collection', ZERO);
  assert.strictEqual(failCheck.passed, false, 'Unverifiable mint status (API error) must reject');
  console.log('Case R1g PASSED: Mint-out re-verification failure rejects the offer ✅\n');

  // ------------------------------------------------------------------------
  // RULE 2: Cancel and re-entry
  // ------------------------------------------------------------------------
  console.log('--- Rule 2: Cancel & Re-entry ---');
  const longConfig = { ...config, general: { ...config.general, offerExpirationMinutes: 60 } };
  const longBidder = new CollectionBidderStrategy(
    longConfig, new OpenSeaApiService(longConfig), pricingEngine,
    new SeaportService(longConfig, Wallet.createRandom()), new InventoryManager(longConfig), new CircuitBreaker(longConfig)
  );
  assert.strictEqual(longBidder.getOfferMaxAgeMinutes(), 20, 'Offer lifetime must be clamped to 20 minutes');
  console.log('Case R2a PASSED: Offer lifetime can never exceed 20 minutes, even if configured higher ✅');

  // 2b. Expired offer whose cancellation cannot be verified: stays tracked, capital locked, no re-offer
  const r2Api = new OpenSeaApiService(config);
  let r2Posted = 0;
  (r2Api as any).getCollectionMarketData = async () => baseMarketData();
  (r2Api as any).cancelOffer = async () => ({ success: true });
  (r2Api as any).verifyOfferInactive = async () => ({ isInactive: false, error: 'still active' });
  (r2Api as any).postCollectionOffer = async () => { r2Posted++; return { order_hash: 'x' }; };
  const r2Inv = new InventoryManager(config);
  const { bidder: r2Bidder } = makeBidder(r2Api, r2Inv);
  r2Inv.registerActiveOffer({
    orderHash: 'expired_unverified', collectionSlug: 'rules-collection', contractAddress: baseMarketData().contractAddress,
    network: 'robinhood', priceEth: 0.0008, priceUsd: 2.16,
    createdTimestamp: Date.now() - 21 * 60 * 1000, expiresTimestamp: Date.now() - 60 * 1000, status: 'ACTIVE'
  });
  const expiryRes = await r2Bidder.processAutomaticOfferCancellations(r2Bidder.getOfferMaxAgeMinutes());
  assert.strictEqual(expiryRes.cancelled, 0, 'Unverified cancellation must not count as cancelled');
  await (r2Bidder as any).processCollectionBid(
    { name: 'R2', slug: 'rules-collection', contractAddress: baseMarketData().contractAddress, targetNetProfitUsd: 0.20, maxBidEth: 1 },
    'robinhood'
  );
  assert.strictEqual(r2Posted, 0, 'No re-offer while previous cancellation is unverified');
  console.log('Case R2b PASSED: Expired offer with unverified cancellation blocks re-entry ✅');

  // 2c. Expired offer, verified cancellation, criteria still pass -> re-offer placed (with fresh mint check)
  (r2Api as any).verifyOfferInactive = async () => ({ isInactive: true });
  const r2cInv = new InventoryManager(config);
  const { bidder: r2cBidder } = makeBidder(r2Api, r2cInv);
  r2cInv.registerActiveOffer({
    orderHash: 'expired_ok', collectionSlug: 'rules-collection', contractAddress: baseMarketData().contractAddress,
    network: 'robinhood', priceEth: 0.0008, priceUsd: 2.16,
    createdTimestamp: Date.now() - 21 * 60 * 1000, expiresTimestamp: Date.now() - 60 * 1000, status: 'ACTIVE'
  });
  (r2Api as any).postCollectionOffer = async () => { r2Posted++; return { order_hash: 'reoffer_ok' }; };
  const okRes = await r2cBidder.processAutomaticOfferCancellations(20);
  assert.strictEqual(okRes.cancelled, 1, 'Verified cancellation must count');
  await (r2cBidder as any).processCollectionBid(
    { name: 'R2', slug: 'rules-collection', contractAddress: baseMarketData().contractAddress, targetNetProfitUsd: 0.20, maxBidEth: 1 },
    'robinhood'
  );
  assert.strictEqual(r2Posted, 1, 'Re-offer must be placed once cancellation is verified and criteria pass');
  assert.strictEqual(r2cInv.getActiveOffer('rules-collection')?.orderHash, 'reoffer_ok');
  console.log('Case R2c PASSED: Verified cancellation + criteria recheck -> re-offer placed ✅');

  // 2d. Live cancel request uses OpenSea v2 order cancel endpoint
  const cancelApi = new OpenSeaApiService(config);
  let cancelUrl = '';
  (cancelApi as any).client = { post: async (url: string) => { cancelUrl = url; return { data: {} }; } };
  const cancelRes = await cancelApi.cancelOffer('0xabc', 'mainnet');
  assert.strictEqual(cancelRes.success, true);
  assert.strictEqual(cancelUrl, `/orders/chain/ethereum/protocol/${config.seaport.contractAddress}/0xabc/cancel`, 'Must use v2 order cancel endpoint');
  console.log('Case R2d PASSED: Cancellation uses /orders/chain/{chain}/protocol/{protocol}/{hash}/cancel ✅\n');

  // ------------------------------------------------------------------------
  // RULE 3: Creator fee
  // ------------------------------------------------------------------------
  console.log('--- Rule 3: Optional Creator Fee Disabled Before Sale ---');
  const disabledFee = pricingEngine.getMinProfitableListPrice(0.001, { openseaFeeBps: 50, royaltyFeeBps: 0, ethPriceUsd: 2700 });
  assert.strictEqual(disabledFee.totalFeeRate, 0.005, 'Disabled optional creator fee (0 bps) must stay 0, not default to 50 bps');
  const seaport3 = new SeaportService(config, Wallet.createRandom());
  const fees3 = [
    { fee: 0.5, recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', required: true },
    { fee: 5, recipient: '0x9999999999999999999999999999999999999999', required: false }
  ];
  const disabled3 = seaport3.verifyAndDisableOptionalCreatorFees(fees3);
  assert.strictEqual(disabled3.effectiveFees.length, 1, 'Only the required marketplace fee remains');
  assert(disabled3.effectiveFees.every((f) => f.required !== false), 'No optional fee may remain in effective fees');
  const verify3 = seaport3.verifyCreatorFeeDisabledBeforeSale(
    [{ recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', startAmount: '100' }], fees3
  );
  assert.strictEqual(verify3.verified, true, 'Sale may proceed only once optional fee is verified absent');
  console.log('Case R3a-b PASSED: Optional creator fee disabled & verified; 0 bps not replaced by default ✅\n');

  // ------------------------------------------------------------------------
  // RULE 4: Profitability
  // ------------------------------------------------------------------------
  console.log('--- Rule 4: Profitability ---');
  // 4a. Margin-only pass but net profit below configured USD minimum -> REJECT
  const tinyData = baseMarketData({ floorPriceEth: 0.0005 }); // ~$1.35 floor
  const tinyCalc = pricingEngine.calculateMaxBid(tinyData, 5.0, 10.0, 'robinhood');
  assert.strictEqual(tinyCalc.decision, 'REJECT', 'Must reject when net profit < required minimum net profit');
  // 4b. Normal eligible data -> ACCEPT; floor >= bid * 1.30 and net profit >= minimum
  const okCalc = pricingEngine.calculateMaxBid(baseMarketData(), 0.20, 10.0, 'robinhood');
  assert.strictEqual(okCalc.decision, 'ACCEPT', 'Eligible trade must be accepted: ' + okCalc.reason);
  assert(baseMarketData().floorPriceEth >= okCalc.bidPriceEth * 1.30 - 1e-9, 'Floor must be >= offer * 1.30');
  assert(okCalc.netProfitUsd >= 0.20 - 0.005, 'Net profit must meet configured minimum');
  assert(okCalc.marginPercent >= config.profitTargets.defaultMinMarginPercent, 'Margin must meet configured minimum (no tolerance)');
  // 4c. Creator fee is counted in full (not capped) and above-ceiling fees reject
  const highRoyalty = pricingEngine.calculateMaxBid(baseMarketData({ royaltyFeeBps: config.fees.maxAcceptableRoyaltyBps + 500 }), 0.20, 10.0, 'robinhood');
  assert.strictEqual(highRoyalty.decision, 'REJECT', 'Creator fee above acceptable ceiling must reject');
  const royalty500 = pricingEngine.calculateMaxBid(baseMarketData({ royaltyFeeBps: 500 }), 0.20, 10.0, 'robinhood');
  assert(royalty500.royaltyFeeEth > 0 && Math.abs(royalty500.royaltyFeeEth - royalty500.targetListPriceEth * 0.05) < 1e-6, 'Full creator fee must be counted');
  // 4d. evaluateOfferScenario enforces the 1.30 floor ratio by default (high profit cannot override)
  const scen = pricingEngine.evaluateOfferScenario({ offerPriceUsd: 1.25, floorPriceUsd: 1.50, royaltyPercent: 0, minNetProfitUsd: 0.01, minMarginPercent: 0 });
  assert.strictEqual(scen.decision, 'REJECT', 'Floor < offer * 1.30 must reject by default');
  console.log('Case R4a-d PASSED: Floor ratio + configurable minimum net profit/margin enforced, full creator fee counted ✅\n');

  // ------------------------------------------------------------------------
  // RULE 5: Recent floor sales
  // ------------------------------------------------------------------------
  console.log('--- Rule 5: Recent Native ETH Floor Sales ---');
  const salesApi = new OpenSeaApiService(config);
  const nowSec = Math.floor(Date.now() / 1000);
  const mk = (i: number, extra: any = {}) => ({
    event_type: 'sale',
    event_timestamp: nowSec - 600 - i,
    buyer: `0x${(1000 + i).toString(16).padStart(40, 'a')}`,
    seller: `0x${(5000 + i).toString(16).padStart(40, 'b')}`,
    payment: { symbol: 'ETH', token_address: ZERO, quantity: '2000000000000000', decimals: 18 },
    ...extra
  });
  const events: any[] = [];
  for (let i = 0; i < 9; i++) events.push(mk(i));
  events.push(mk(20, { payment: { symbol: 'WETH', token_address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', quantity: '2000000000000000', decimals: 18 } }));
  events.push(mk(21, { payment: { symbol: 'ETH', token_address: '0x1234567890123456789012345678901234567890', quantity: '2000000000000000', decimals: 18 } }));
  events.push(mk(22, { event_timestamp: nowSec - 3 * 3600 - 120 })); // older than 3h
  events.push(mk(23, { order_type: 'collection_offer' })); // accepted offer
  events.push(mk(24, { status: 'pending' })); // not completed
  events.push(mk(25, { event_timestamp: undefined })); // no timestamp
  let page = 0;
  let firstUrl = '';
  (salesApi as any).client = {
    get: async (url: string) => {
      if (!firstUrl) firstUrl = url;
      page++;
      // Paginated: return half the events with a cursor, then the rest
      if (page === 1) return { data: { asset_events: events.slice(0, 7), next: 'cursor1' } };
      return { data: { asset_events: events.slice(7) } };
    }
  };
  const liq9 = await salesApi.getCollectionLiquidity('rules-collection', 0.002);
  assert(firstUrl.includes('after='), 'Sales query must be bounded to the last 3 hours');
  assert.strictEqual(page, 2, 'Sales query must follow pagination');
  assert.strictEqual(liq9.sales3Hours, 9, 'Only completed native ETH floor sales within 3h count');
  assert.strictEqual(liq9.liquidityPassed, false, '9 qualifying sales must fail');
  events.push(mk(9));
  page = 0;
  const liq10 = await salesApi.getCollectionLiquidity('rules-collection', 0.002);
  assert.strictEqual(liq10.sales3Hours, 10);
  assert.strictEqual(liq10.liquidityPassed, true, '10 qualifying sales must pass');
  console.log('Case R5a PASSED: WETH, non-native tokens, >3h old, accepted offers, pending sales excluded; pagination followed ✅');

  // 5b. Strategy/pricing never fall back to 1h counts when the 3h count is missing
  const noThreeHour = baseMarketData({ sales3Hours: undefined, sales1Hour: 50, uniqueWallets3Hours: undefined, uniqueWallets1Hour: 20 });
  const calc5 = pricingEngine.calculateMaxBid(noThreeHour, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calc5.checkLLiquidityPassed, false, 'Missing 3h count must not fall back to 1h data');
  console.log('Case R5b PASSED: Missing 3-hour sales data rejects (no 1-hour fallback) ✅\n');

  process.env.BOT_MODE = originalBotMode;
  console.log('================================================================');
  console.log('All Trading Rules regression tests passed successfully!');
  console.log('================================================================');
})().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
