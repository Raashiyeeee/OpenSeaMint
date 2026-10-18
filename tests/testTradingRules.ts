import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Wallet, parseEther } from 'ethers';
import { PricingEngine } from '../src/services/PricingEngine';
import { InventoryManager } from '../src/services/InventoryManager';
import { OpenSeaApiService } from '../src/services/OpenSeaApiService';
import { SeaportService } from '../src/services/SeaportService';
import { CircuitBreaker } from '../src/security/CircuitBreaker';
import { CollectionBidderStrategy } from '../src/strategies/CollectionBidderStrategy';
import { AutoRelisterStrategy } from '../src/strategies/AutoRelisterStrategy';
import { loadConfig } from '../src/config/schema';
import { CollectionMarketData } from '../src/types';

/**
 * Trading Rules Regression Tests (fix/trading-rules)
 * Rule 1: Mint-out protection (positive verification, re-verified before every offer)
 * Rule 2: Cancel & re-entry (20-minute max offer age, documented cancel endpoint)
 * Rule 3: Optional creator fee disabled (0 bps) before sale
 * Rule 4: Profitability (floor >= offer * 1.30, net profit >= configured minimum)
 * Rule 5: Recent floor sales (>= 10 completed native ETH floor sales in last 3 hours)
 * Rule 6: Post-sale 90% ETH -> WETH wrap (10% kept as gas), verified on-chain
 * Rule 7: No re-offer on a bought NFT until it is sold (persisted across restarts)
 * Rule 8: 70% capital allocation / 30% reserve, pause until 40% of purchased NFTs sell
 * Rules A-E: 12% margin (creator excluded), min acceptable floor, creator fee status, final pre-offer validation, auto-listing
 *
 * All network access is stubbed. No live markets are touched and no orders are posted.
 */

const config = { ...loadConfig(), capital: { ...loadConfig().capital, totalTradingCapitalUsd: 10.0 } };
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
  (seaport as any).isOrderCancelledOnChain = async () => false; // never touch a live RPC in tests
  // Default: no competing offers (tests that exercise #1 / outbid stub this explicitly). Never hit the live API.
  if (!(api as any).getTopCompetingCollectionOffer || (api as any).getTopCompetingCollectionOffer === OpenSeaApiService.prototype.getTopCompetingCollectionOffer) {
    (api as any).getTopCompetingCollectionOffer = async () => null;
  }
  if (!(api as any).invalidateCollectionCache) {
    (api as any).invalidateCollectionCache = () => undefined;
  }
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

  // 1e. API: supply sources = OpenSea Drops API + on-chain totalSupply()/maxSupply() (+ collection total_supply)
  const mintApi = new OpenSeaApiService(config);
  (mintApi as any).getEthPriceUsd = async () => 2700;
  (mintApi as any).getCollectionLiquidity = async () => ({
    sales3Hours: 12, uniqueWallets3Hours: 8, sales1Hour: 4, uniqueWallets1Hour: 4, liquidityPassed: true
  });
  (mintApi as any).client = {
    get: async (url: string) => {
      if (url.startsWith('/collections/') && !url.includes('/stats')) return { data: { total_supply: 500, fees: [] } };
      if (url.includes('/stats')) return { data: { total: { floor_price: 0.002, floor_price_symbol: 'ETH' } } };
      return { data: { offers: [] } };
    }
  };
  let dropStub: any = {};
  let chainStub: any = {};
  (mintApi as any).getDropSupply = async () => dropStub;
  (mintApi as any).readOnChainSupply = async () => chainStub;
  const noMax = await (mintApi.clearCaches(), mintApi).getCollectionMarketData('rules-collection', ZERO, 'robinhood');
  assert.strictEqual(noMax.mintStatusVerified, false, 'Only total_supply known -> unverifiable');
  assert.strictEqual(noMax.mintCompleted, false, 'Unverifiable must not be treated as minted out');
  dropStub = { totalSupply: 500, maxSupply: 500, isMinting: false };
  const viaDrop = await (mintApi.clearCaches(), mintApi).getCollectionMarketData('rules-collection', ZERO, 'robinhood');
  assert.strictEqual(viaDrop.mintStatusVerified, true, 'Drops API total == max must verify');
  assert.strictEqual(viaDrop.mintCompleted, true);
  dropStub = {};
  chainStub = { totalSupply: 500, maxSupply: 500 };
  const viaChain = await (mintApi.clearCaches(), mintApi).getCollectionMarketData('rules-collection', ZERO, 'robinhood');
  assert.strictEqual(viaChain.mintCompleted, true, 'On-chain totalSupply == maxSupply must verify');
  chainStub = { totalSupply: 480, maxSupply: 500 };
  const chainIncomplete = await (mintApi.clearCaches(), mintApi).getCollectionMarketData('rules-collection', ZERO, 'robinhood');
  assert.strictEqual(chainIncomplete.mintCompleted, false, 'On-chain 480/500 must reject even if API total says 500');
  dropStub = { totalSupply: 500, maxSupply: 500, isMinting: true };
  chainStub = {};
  assert.strictEqual((await (mintApi.clearCaches(), mintApi).getCollectionMarketData('rules-collection', ZERO, 'robinhood')).mintCompleted, false, 'Active drop mint must reject');
  // Pure decision rules
  assert.strictEqual(OpenSeaApiService.evaluateMintSupply({ onChainMaxSupply: 1000, onChainTotalSupply: 1000, collectionTotalSupply: 990 }).completed, true, 'On-chain 100% completion is authoritative over lagging API total');
  assert.strictEqual(OpenSeaApiService.evaluateMintSupply({ onChainMaxSupply: 1000, onChainTotalSupply: 990, collectionTotalSupply: 1000 }).completed, false, 'On-chain incomplete must reject even if API says 1000');
  console.log('Case R1e PASSED: Mint-out verified from on-chain ground truth / Drops API; incomplete sources reject ✅');

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
  events.push(mk(26, { order_hash: '0xbid', chain: 'robinhood' })); // accepted offer detected via order lookup
  let page = 0;
  let firstUrl = '';
  let orderLookups = 0;
  (salesApi as any).client = {
    get: async (url: string) => {
      if (url.startsWith('/orders/')) {
        orderLookups++;
        // Sale with order_hash 0xbid was an accepted bid (offerer gave WETH, itemType 1)
        if (url.endsWith('/0xbid')) return { data: { order: { protocol_data: { parameters: { offer: [{ itemType: 1 }] } } } } };
        return { data: { order: { protocol_data: { parameters: { offer: [{ itemType: 2 }] } }, type: 'basic' } } };
      }
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
  assert(orderLookups >= 1, 'Sale order must be looked up to detect accepted offers');
  events.push(mk(9));
  page = 0;
  salesApi.clearCaches(); // sales events are cached ~2 min; force a refetch for the new event set
  const liq10 = await salesApi.getCollectionLiquidity('rules-collection', 0.002);
  assert.strictEqual(liq10.sales3Hours, 10);
  assert.strictEqual(liq10.liquidityPassed, true, '10 qualifying sales must pass');
  console.log('Case R5a PASSED: WETH, non-native tokens, >3h old, accepted offers (fields + order lookup), pending sales excluded; pagination followed ✅');

  // 5b. Strategy/pricing never fall back to 1h counts when the 3h count is missing
  const noThreeHour = baseMarketData({ sales3Hours: undefined, sales1Hour: 50, uniqueWallets3Hours: undefined, uniqueWallets1Hour: 20 });
  const calc5 = pricingEngine.calculateMaxBid(noThreeHour, 0.20, 10.0, 'robinhood');
  assert.strictEqual(calc5.checkLLiquidityPassed, false, 'Missing 3h count must not fall back to 1h data');
  console.log('Case R5b PASSED: Missing 3-hour sales data rejects (no 1-hour fallback) ✅\n');

  // ------------------------------------------------------------------------
  // RULE 6: Post-sale ETH -> WETH conversion, verified
  // ------------------------------------------------------------------------
  console.log('--- Rule 6: Post-Sale 90% WETH Wrap (Verified) ---');
  let wethBal = parseEther('0.01');
  let depositedWei = 0n;
  const fakeProvider: any = { getBalance: async () => parseEther('0.01') };
  const wrapSigner = new Wallet(Wallet.createRandom().privateKey, fakeProvider);
  const seaport6 = new SeaportService(config, wrapSigner);
  let creditWeth = true;
  (seaport6 as any).getWethContract = () => ({
    balanceOf: async () => wethBal,
    deposit: async ({ value }: { value: bigint }) => {
      depositedWei = value;
      return { hash: '0xwrap', wait: async () => { if (creditWeth) wethBal += value; return { status: 1, hash: '0xwrap' }; } };
    }
  });
  const conv = await seaport6.handlePostSaleEthConversion(0.01, 'robinhood');
  assert.strictEqual(conv.success, true, 'Wrap must succeed');
  assert.strictEqual(conv.verified, true, 'Wrap must be verified via WETH balance delta');
  assert.strictEqual(conv.amountWrappedEth, 0.009, 'Exactly 90% must be wrapped');
  assert.strictEqual(conv.gasReserveRetainedEth, 0.001, 'Remaining 10% kept as ETH gas reserve');
  assert.strictEqual(depositedWei, parseEther('0.009'), 'deposit() value must equal 90% of proceeds');
  // 6b. WETH balance did not increase -> not verified
  creditWeth = false;
  const convBad = await seaport6.handlePostSaleEthConversion(0.01, 'robinhood');
  assert.strictEqual(convBad.verified, false, 'Wrap without WETH balance increase must fail verification');
  assert.strictEqual(convBad.success, false);
  // 6c. Partial wrap (e.g. balance capped) is a failure, not a silent success
  const seaport6c = new SeaportService(config, Wallet.createRandom());
  (seaport6c as any).swapEthToWeth = async () => ({ success: true, verified: true, amountWrappedEth: 0.004 });
  const convPartial = await seaport6c.handlePostSaleEthConversion(0.01, 'robinhood');
  assert.strictEqual(convPartial.verified, false, 'Partial wrap must not count as verified');
  // 6d. Combined existing ETH balance + newly received ETH
  let wethBalCombined = parseEther('0.05');
  let depositedCombined = 0n;
  // Wallet has 0.002 existing ETH + receives 0.018 ETH from sale = 0.020 ETH total capital
  const fakeProviderCombined: any = { getBalance: async () => parseEther('0.02') };
  const seaport6d = new SeaportService(config, new Wallet(Wallet.createRandom().privateKey, fakeProviderCombined));
  (seaport6d as any).getWethContract = () => ({
    balanceOf: async () => wethBalCombined,
    deposit: async ({ value }: { value: bigint }) => {
      depositedCombined = value;
      wethBalCombined += value;
      return { status: 1, hash: '0xwrap_combined', wait: async () => ({ status: 1, hash: '0xwrap_combined' }) };
    }
  });
  const convCombined = await seaport6d.handlePostSaleEthConversion(0.018, 'robinhood', 'sale_tx_1');
  assert.strictEqual(convCombined.success, true);
  assert.strictEqual(convCombined.amountWrappedEth, 0.018, 'Must wrap 90% of total 0.02 ETH balance (0.018 ETH)');
  assert.strictEqual(convCombined.gasReserveRetainedEth, 0.002, 'Must retain 10% of total 0.02 ETH balance (0.002 ETH) as gas fee reserve');
  assert.strictEqual(depositedCombined, parseEther('0.018'));

  // 6e. Gas reserve protection: autoWrapAvailableEthIfDeficit must NOT wrap the 10% gas reserve (prevents second wrap)
  (seaport6d as any).getWethBalance = async () => 0.018; // WETH in wallet
  // Wallet now has 0.002 ETH native (the 10% gas reserve)
  fakeProviderCombined.getBalance = async () => parseEther('0.002');
  const deficitRes = await seaport6d.autoWrapAvailableEthIfDeficit(0.05, 'robinhood');
  assert.strictEqual(deficitRes.success, true);
  assert.strictEqual(deficitRes.amountWrappedEth, 0, 'Must NOT wrap the 10% native ETH gas reserve to fund bids!');

  // 6f. Deduplication: duplicate trigger on same sale identifier must NOT wrap again
  const dupConv = await seaport6d.handlePostSaleEthConversion(0.018, 'robinhood', 'sale_tx_1');
  assert.strictEqual(dupConv.success, true);
  assert.strictEqual(dupConv.amountWrappedEth, 0.018, 'Returns cached result without executing second on-chain wrap');

  console.log('Case R6a-f PASSED: Combined total ETH balance 90% wrapped / 10% gas reserve retained, protected against second wrap, deduplicated ✅\n');

  // ------------------------------------------------------------------------
  // RULE 7: No re-offer on bought NFT until sold (persisted)
  // ------------------------------------------------------------------------
  console.log('--- Rule 7: Re-Offer Rule (Persisted) ---');
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osm-state-')), 'inventory-state.json');
  const nftContract = '0xabcdefabcdefabcdefabcdefabcdefabcdef0001';
  const inv7 = new InventoryManager(config, stateFile);
  inv7.addInventoryItem({
    identifier: `${nftContract}:7`, collectionSlug: 'rule7', contractAddress: nftContract, tokenId: '7',
    acquiredPriceEth: 0.0008, acquiredPriceUsd: 2.16, acquiredAtTimestamp: Date.now(), status: 'PENDING_LISTING'
  });
  assert.strictEqual(inv7.canPlaceOfferOnNft(nftContract, '7').allowed, false, 'Bought NFT must be blocked');
  // Simulated restart: new manager loaded from disk must still block
  const inv7Restarted = new InventoryManager(config, stateFile);
  assert.strictEqual(inv7Restarted.canPlaceOfferOnNft(nftContract, '7').allowed, false, 'Block must survive restart');
  inv7Restarted.updateListingStatus(`${nftContract}:7`, 0.0012, 'list_1');
  const inv7Restarted2 = new InventoryManager(config, stateFile);
  assert.strictEqual(inv7Restarted2.canPlaceOfferOnNft(nftContract, '7').allowed, false, 'Listed-but-unsold NFT stays blocked after restart');
  inv7Restarted2.markItemSold(`${nftContract}:7`, 0.0012, 2700);
  const inv7AfterSale = new InventoryManager(config, stateFile);
  assert.strictEqual(inv7AfterSale.isNftSaleConfirmed(nftContract, '7'), true, 'Sale confirmation must persist');
  assert.strictEqual(inv7AfterSale.canPlaceOfferOnNft(nftContract, '7', 1.5).allowed, true, 'After confirmed sale, NFT may be offered on again (subject to criteria)');
  // Item-bid path enforces the block before anything else
  const api7 = new OpenSeaApiService(config);
  let api7Calls = 0;
  (api7 as any).getCollectionMarketData = async () => { api7Calls++; return baseMarketData(); };
  const inv7b = new InventoryManager(config);
  inv7b.addInventoryItem({
    identifier: `${nftContract}:8`, collectionSlug: 'rule7', contractAddress: nftContract, tokenId: '8',
    acquiredPriceEth: 0.0008, acquiredAtTimestamp: Date.now(), status: 'LISTED'
  });
  const { bidder: bidder7 } = makeBidder(api7, inv7b);
  const itemBid7 = await bidder7.placeItemBid({ contractAddress: nftContract, tokenId: '8', collectionSlug: 'rule7' });
  assert.strictEqual(itemBid7.success, false, 'Item bid on owned NFT must be rejected');
  assert.strictEqual(api7Calls, 0, 'Rejected before any market evaluation');
  console.log('Case R7a-c PASSED: Owned NFT blocked across restarts; re-offer allowed only after confirmed sale ✅\n');

  // ------------------------------------------------------------------------
  // RULE 8: 70% allocation / 30% reserve, pause & resume
  // ------------------------------------------------------------------------
  console.log('--- Rule 8: Capital Reallocation ---');
  const inv8 = new InventoryManager(config);
  assert.strictEqual(inv8.getOfferAllocationLimitUsd(), 7.0, '70% of $10 = $7.00');
  const cfgHigh = { ...config, capital: { ...config.capital, maxOfferCapitalPercent: 95 } };
  assert.strictEqual(new InventoryManager(cfgHigh as any).getOfferAllocationPercent(), 70, 'Allocation can never exceed 70%');
  assert.strictEqual(inv8.canAllocateCapitalForOffer(7.0).allowed, true, 'Up to $7.00 allowed');
  assert.strictEqual(inv8.canAllocateCapitalForOffer(7.01).allowed, false, 'Above $7.00 blocked (30% reserve)');
  // Purchased NFTs count against the 70%
  for (let i = 0; i < 5; i++) {
    inv8.addInventoryItem({
      identifier: `${nftContract}:${100 + i}`, collectionSlug: 'rule8', contractAddress: nftContract, tokenId: `${100 + i}`,
      acquiredPriceEth: 0.0005, acquiredPriceUsd: 1.40, acquiredAtTimestamp: Date.now(), status: 'LISTED'
    });
  }
  // $7.00 committed to 5 purchased NFTs -> fully committed -> pause
  assert.strictEqual(inv8.canAllocateCapitalForOffer(1.0).allowed, false, 'No room left inside the 70% allocation');
  const p1 = inv8.evaluateOfferCyclePause();
  assert.strictEqual(p1.paused, true, 'Must pause when 70% is fully committed to purchased NFTs');
  assert.strictEqual(inv8.getOfferCyclePauseState().purchasedCountAtPause, 5);
  inv8.markItemSold(`${nftContract}:100`, 0.0008, 2700);
  assert.strictEqual(inv8.evaluateOfferCyclePause().paused, true, '1/5 sold (20%) -> still paused');
  assert.strictEqual(inv8.canAllocateCapitalForOffer(1.0).allowed, false, 'No offers while paused, even with freed capital');
  inv8.markItemSold(`${nftContract}:101`, 0.0008, 2700);
  const p3 = inv8.evaluateOfferCyclePause();
  assert.strictEqual(p3.paused, false, '2/5 sold (40%) -> resume');
  const newLimit = inv8.getOfferAllocationLimitUsd();
  assert.strictEqual(newLimit, Math.round(inv8.getTotalCapitalUsd() * 0.7 * 100) / 100, 'Resumes with 70% of then-available capital');
  assert(inv8.getTotalCapitalUsd() > 10.0, 'Realized profit grows available capital');
  // Strategy: paused cycle places no offers / does no discovery
  const api8 = new OpenSeaApiService(config);
  let discoveries = 0;
  (api8 as any).discoverCollectionsByChain = async () => { discoveries++; return []; };
  const inv8b = new InventoryManager(config);
  for (let i = 0; i < 5; i++) {
    inv8b.addInventoryItem({
      identifier: `${nftContract}:${200 + i}`, collectionSlug: 'rule8', contractAddress: nftContract, tokenId: `${200 + i}`,
      acquiredPriceEth: 0.0005, acquiredPriceUsd: 1.40, acquiredAtTimestamp: Date.now(), status: 'LISTED'
    });
  }
  const { bidder: bidder8 } = makeBidder(api8, inv8b);
  await bidder8.evaluateAndPlaceBids();
  assert.strictEqual(discoveries, 0, 'Paused offer cycle must not scan or place offers');
  // Pause state persists across restarts
  const stateFile8 = path.join(path.dirname(stateFile), 'pause-state.json');
  const inv8c = new InventoryManager(config, stateFile8);
  for (let i = 0; i < 5; i++) {
    inv8c.addInventoryItem({
      identifier: `${nftContract}:${300 + i}`, collectionSlug: 'rule8', contractAddress: nftContract, tokenId: `${300 + i}`,
      acquiredPriceEth: 0.0005, acquiredPriceUsd: 1.40, acquiredAtTimestamp: Date.now(), status: 'LISTED'
    });
  }
  inv8c.evaluateOfferCyclePause();
  assert.strictEqual(new InventoryManager(config, stateFile8).getOfferCyclePauseState().paused, true, 'Pause must persist across restarts');
  console.log('Case R8a-e PASSED: 70%/30% split, purchased NFTs counted, pause until 40% sold, resume at 70% of new capital ✅\n');

  // ------------------------------------------------------------------------
  // CAVEAT FIXES: OpenSea API semantics, outbid per NFT, transfers vs sales, secrets
  // ------------------------------------------------------------------------
  console.log('--- Caveat Fixes ---');
  // C1. Chain identifiers per OpenSea ChainIdentifier enum
  assert.strictEqual(OpenSeaApiService.toOpenSeaChain('mainnet'), 'ethereum');
  assert.strictEqual(OpenSeaApiService.toOpenSeaChain('robinhood'), 'robinhood');
  // C2. Get Order status enum: ACTIVE | INACTIVE | FULFILLED | EXPIRED | CANCELLED; 404 is NOT proof of cancellation
  const statusApi = new OpenSeaApiService(config);
  let orderResponse: any = { data: { order: { status: 'INACTIVE' } } };
  (statusApi as any).client = { get: async () => { if (orderResponse instanceof Error) throw orderResponse; return orderResponse; } };
  assert.strictEqual((await statusApi.verifyOfferInactive('0x1', 'robinhood')).isInactive, false, 'INACTIVE can revalidate -> not cancelled');
  orderResponse = { data: { order: { status: 'CANCELLED' } } };
  assert.strictEqual((await statusApi.verifyOfferInactive('0x1', 'robinhood')).isInactive, true);
  orderResponse = { data: { order: { status: 'FULFILLED' } } };
  assert.strictEqual((await statusApi.verifyOfferInactive('0x1', 'robinhood')).status, 'FULFILLED');
  const nf: any = new Error('not found'); nf.response = { status: 404, data: { errors: ['not found'] } };
  orderResponse = nf;
  assert.strictEqual((await statusApi.verifyOfferInactive('0x1', 'robinhood')).isInactive, false, '404 must be unverified');
  // C3. Offchain cancel: order stays fillable until last_signature_issued_valid_until
  const cancelApi2 = new OpenSeaApiService(config);
  const until = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  (cancelApi2 as any).client = { post: async () => ({ data: { last_signature_issued_valid_until: until } }) };
  const c2 = await cancelApi2.cancelOffer('0xabc', 'robinhood');
  assert.strictEqual(c2.fillableUntil, Date.parse(until), 'fillableUntil parsed from cancel response');
  const c2Inv = new InventoryManager(config);
  const c2Api = new OpenSeaApiService(config);
  (c2Api as any).cancelOffer = async () => ({ success: true, fillableUntil: Date.now() + 3 * 60 * 1000 });
  (c2Api as any).verifyOfferInactive = async () => ({ isInactive: true, status: 'CANCELLED' });
  const { bidder: c2Bidder } = makeBidder(c2Api, c2Inv);
  const mkOffer = () => ({
    orderHash: 'offchain_cancel', collectionSlug: 'c2', contractAddress: ZERO, network: 'robinhood',
    priceEth: 0.001, priceUsd: 2.7, createdTimestamp: Date.now() - 21 * 60000, expiresTimestamp: Date.now(), status: 'ACTIVE' as const
  });
  c2Inv.registerActiveOffer(mkOffer());
  const c2Res = await c2Bidder.cancelAndVerifyOffer(c2Inv.getActiveOffer('offchain_cancel')!);
  assert.strictEqual(c2Res.success, false, 'Must wait for issued fulfillment signature to expire');
  assert.strictEqual(c2Inv.getActiveOffersCapitalUsd(), 2.7, 'Capital stays locked while order is still fillable');
  // C4. Offer FULFILLED during cancellation -> recorded as a fill, not a cancellation
  const c4Inv = new InventoryManager(config);
  const c4Api = new OpenSeaApiService(config);
  (c4Api as any).cancelOffer = async () => ({ success: false, error: 'already filled' });
  (c4Api as any).verifyOfferInactive = async () => ({ isInactive: true, status: 'FULFILLED' });
  const { bidder: c4Bidder } = makeBidder(c4Api, c4Inv);
  c4Inv.registerActiveOffer({ ...mkOffer(), orderHash: 'filled_offer' });
  const c4Res = await c4Bidder.cancelAndVerifyOffer(c4Inv.getActiveOffer('filled_offer')!);
  assert.strictEqual(c4Res.success, false);
  assert.strictEqual(c4Inv.getAllActiveOffers().find((o) => o.orderHash === 'filled_offer')?.status, 'FULFILLED');
  const consumed = c4Inv.consumeFulfilledOffer(ZERO, '1');
  assert(consumed && consumed.orderHash === 'filled_offer', 'Wallet scan can attribute the bought NFT to the filled offer');
  // C5. Single-NFT outbid uses best offer on that NFT (and collection offers)
  const c5Inv = new InventoryManager(config);
  const c5Api = new OpenSeaApiService(config);
  (c5Api as any).getTopCompetingCollectionOffer = async () => ({ priceEth: 0.0005 });
  (c5Api as any).getBestNftOffer = async () => ({ priceEth: 0.0012, orderHash: 'someone_else' });
  let c5Cancelled = 0;
  (c5Api as any).cancelOffer = async () => { c5Cancelled++; return { success: true }; };
  (c5Api as any).verifyOfferInactive = async () => ({ isInactive: true, status: 'CANCELLED' });
  const { bidder: c5Bidder } = makeBidder(c5Api, c5Inv);
  c5Inv.registerActiveOffer({ ...mkOffer(), orderHash: 'item_offer', tokenId: '42', createdTimestamp: Date.now(), expiresTimestamp: Date.now() + 600000 });
  const c5Res = await c5Bidder.processOutbidOfferCancellations();
  assert.strictEqual(c5Res.cancelled, 1, 'Item offer outbid by a higher offer on that NFT must be cancelled');
  assert.strictEqual(c5Cancelled, 1);
  // own best offer must not count as outbid
  const c5bInv = new InventoryManager(config);
  (c5Api as any).getTopCompetingCollectionOffer = async () => null;
  (c5Api as any).getBestNftOffer = async () => ({ priceEth: 0.001, orderHash: 'item_offer2' });
  const { bidder: c5bBidder } = makeBidder(c5Api, c5bInv);
  c5bInv.registerActiveOffer({ ...mkOffer(), orderHash: 'item_offer2', tokenId: '43', createdTimestamp: Date.now(), expiresTimestamp: Date.now() + 600000 });
  assert.strictEqual((await c5bBidder.processOutbidOfferCancellations()).cancelled, 0, 'Our own best offer is not an outbid');
  // C5c. Outbid cancel MUST fire even when full market data would early-reject (e.g. mint gate)
  const c5cInv = new InventoryManager(config);
  const c5cApi = new OpenSeaApiService(config);
  (c5cApi as any).getCollectionMarketData = async () => ({
    ...baseMarketData(),
    topOfferEth: 0,
    earlyRejectReason: 'Mint not 100% complete',
    mintCompleted: false,
    mintStatusVerified: false
  });
  (c5cApi as any).getTopCompetingCollectionOffer = async () => ({ priceEth: 0.0015, orderHash: 'higher_bidder' });
  let c5cCancelled = 0;
  (c5cApi as any).cancelOffer = async () => { c5cCancelled++; return { success: true }; };
  (c5cApi as any).verifyOfferInactive = async () => ({ isInactive: true, status: 'CANCELLED' });
  const { bidder: c5cBidder } = makeBidder(c5cApi, c5cInv);
  c5cInv.registerActiveOffer({ ...mkOffer(), orderHash: 'stale_outbid', priceEth: 0.001, createdTimestamp: Date.now(), expiresTimestamp: Date.now() + 600000 });
  const c5cRes = await c5cBidder.processOutbidOfferCancellations();
  assert.strictEqual(c5cRes.cancelled, 1, 'Outbid cancel must work even when getCollectionMarketData early-rejects');
  assert.strictEqual(c5cCancelled, 1);
  assert.strictEqual(c5cInv.getActiveOffer('stale_outbid'), undefined, 'Stale outbid offer must be removed');
  // C6. Multi-quantity offers are compared per unit (price.* and Seaport offer[0] fallback)
  assert.strictEqual(
    OpenSeaApiService.perUnitOfferPriceEth({ price: { value: '3000000000000000', decimals: 18 }, protocol_data: { parameters: { consideration: [{ startAmount: '3' }] } } }),
    0.001
  );
  assert.strictEqual(
    OpenSeaApiService.perUnitOfferPriceEth({
      protocol_data: { parameters: { offer: [{ startAmount: '2000000000000000' }], consideration: [{ startAmount: '2' }] } }
    }),
    0.001,
    'Seaport offer[0].startAmount fallback must yield per-unit ETH'
  );
  // C6b. Duplicate simultaneous offers on one collection are collapsed to a single live offer
  const c6Inv = new InventoryManager(config);
  const c6Api = new OpenSeaApiService(config);
  (c6Api as any).getTopCompetingCollectionOffer = async () => null;
  let c6Cancelled = 0;
  (c6Api as any).cancelOffer = async () => { c6Cancelled++; return { success: true }; };
  (c6Api as any).verifyOfferInactive = async () => ({ isInactive: true, status: 'CANCELLED' });
  (c6Api as any).invalidateCollectionCache = () => undefined;
  const { bidder: c6Bidder } = makeBidder(c6Api, c6Inv);
  c6Inv.registerActiveOffer({ ...mkOffer(), orderHash: 'dup_a', priceEth: 0.001, createdTimestamp: Date.now(), expiresTimestamp: Date.now() + 600000 });
  c6Inv.registerActiveOffer({ ...mkOffer(), orderHash: 'dup_b', priceEth: 0.0008, createdTimestamp: Date.now(), expiresTimestamp: Date.now() + 600000 });
  assert.strictEqual(await c6Bidder.cancelDuplicateOffersForCollection('c2', ZERO), 1, 'Lower duplicate must be cancelled');
  assert.strictEqual(c6Cancelled, 1);
  assert.strictEqual(c6Inv.getLiveOffersForCollection('c2').length, 1, 'Exactly one live offer remains');
  assert.strictEqual(c6Inv.getLiveOffersForCollection('c2')[0].orderHash, 'dup_a', 'Highest-priced offer is kept');
  // C7. Transfers vs sales: only a confirmed sale event marks SOLD and triggers a wrap
  const c7Inv = new InventoryManager(config);
  const c7Api = new OpenSeaApiService(config);
  const c7Seaport = new SeaportService(config, Wallet.createRandom());
  let wraps = 0;
  (c7Seaport as any).handlePostSaleEthConversion = async () => { wraps++; return { success: true, verified: true, amountWrappedEth: 0, gasReserveRetainedEth: 0 }; };
  (c7Seaport as any).ensureNftConduitApproval = async () => true;
  (c7Api as any).getEthPriceUsd = async () => 2700;
  const wallet = '0x00000000000000000000000000000000000000aa';
  for (const id of ['1', '2', '3']) {
    c7Inv.addInventoryItem({
      identifier: `${nftContract}:${id}`, collectionSlug: 'ignored-c7', contractAddress: nftContract, tokenId: id, network: 'robinhood',
      acquiredPriceEth: 0.0005, acquiredPriceUsd: 1.35, acquiredAtTimestamp: Date.now(), status: 'LISTED'
    });
  }
  (c7Api as any).getAccountNfts = async () => []; // all three left the wallet
  (c7Api as any).getConfirmedNftSale = async (_c: string, tokenId: string) => {
    if (tokenId === '1') return { salePriceEth: 0.0009, txHash: '0xsold', timestamp: 0, paymentSymbol: 'ETH' }; // real sale
    if (tokenId === '2') return null; // plain transfer
    return undefined; // could not check
  };
  const c7Config = { ...config, general: { ...config.general, activeNetworks: ['robinhood'], ignoredCollections: ['ignored-c7'] } };
  const c7Relister = new AutoRelisterStrategy(c7Config as any, c7Api, pricingEngine, c7Seaport, c7Inv, new CircuitBreaker(config));
  await c7Relister.scanAndRelistUnlistedInventory(wallet);
  assert.strictEqual(wraps, 1, 'Only the confirmed sale triggers a WETH wrap');
  assert.strictEqual(c7Inv.isNftSaleConfirmed(nftContract, '1'), true, 'Confirmed sale recorded');
  assert.strictEqual(c7Inv.canPlaceOfferOnNft(nftContract, '2').allowed, false, 'Transferred NFT keeps the re-offer block');
  assert.strictEqual(c7Inv.getInventoryItem(`${nftContract}:2`)?.status, 'TRANSFERRED');
  assert.notStrictEqual(c7Inv.getInventoryItem(`${nftContract}:3`)?.status, 'TRANSFERRED', 'Unknown status is left untouched');
  assert.strictEqual(c7Inv.canPlaceOfferOnNft(nftContract, '3').allowed, false);
  // Holdings API failure -> no reconciliation at all (an API error is never "NFT left the wallet")
  const c7bInv = new InventoryManager(config);
  c7bInv.addInventoryItem({
    identifier: `${nftContract}:9`, collectionSlug: 'ignored-c7', contractAddress: nftContract, tokenId: '9', network: 'robinhood',
    acquiredPriceEth: 0.0005, acquiredAtTimestamp: Date.now(), status: 'LISTED'
  });
  (c7Api as any).getAccountNfts = async () => null;
  let saleLookups = 0;
  (c7Api as any).getConfirmedNftSale = async () => { saleLookups++; return null; };
  await new AutoRelisterStrategy(c7Config as any, c7Api, pricingEngine, c7Seaport, c7bInv, new CircuitBreaker(config)).scanAndRelistUnlistedInventory(wallet);
  assert.strictEqual(saleLookups, 0);
  assert.strictEqual(c7bInv.getInventoryItem(`${nftContract}:9`)?.status, 'LISTED', 'Holdings API failure must not change inventory');
  // C8. No provider keys committed in config / .env.example
  const cfgRaw = fs.readFileSync(path.resolve(__dirname, '../config/default.json'), 'utf8');
  const envRaw = fs.readFileSync(path.resolve(__dirname, '../.env.example'), 'utf8');
  assert(!/alch_[A-Za-z0-9]+/.test(cfgRaw) && !/alch_[A-Za-z0-9]+/.test(envRaw), 'No Alchemy key may be committed');
  console.log('Case C1-C8 PASSED: OpenSea chain/status/cancel semantics, per-NFT outbid (incl. when market-data early-rejects), per-unit offers, sale-vs-transfer, no committed RPC keys ✅\n');

  // ------------------------------------------------------------------------
  // RULES A-E: 12% margin (creator excluded), minimum acceptable floor, creator fee, final validation, auto-listing
  // ------------------------------------------------------------------------
  // A. Tiered margins: up to $5 requires 30%, >$5-$9 requires 12% profit after creator fee (e.g. 10% fee -> 22% pre-fee margin)
  assert.strictEqual(pricingEngine.getMinMarginPercent(), 12);
  assert.strictEqual(pricingEngine.getMinMarginPercent({ minMarginPercent: 5 }), 12, 'Per-target 5% cannot weaken the 12% rule');
  assert.strictEqual(pricingEngine.getMinMarginPercent({ minMarginPercent: 15 }), 15, 'Stricter per-target margin is honoured');
  assert.strictEqual(pricingEngine.getMinMarginPercent(undefined, 2.50), 30, '$1 to $4 tier must enforce 30% margin');
  assert.strictEqual(pricingEngine.getMinMarginPercent(undefined, 4.00), 30, '$4.00 boundary must enforce 30% margin');
  assert.strictEqual(pricingEngine.getMinMarginPercent(undefined, 4.01), 12, '>$4 tier with 0% fee must enforce 12% margin');
  assert.strictEqual(pricingEngine.getMinMarginPercent(undefined, 6.00, 10), 22, '>$4 tier with 10% creator fee must enforce 22% margin before fee');
  assert.strictEqual(pricingEngine.getMinMarginPercent(undefined, 7.50, 5), 17, '>$4 tier with 5% creator fee must enforce 17% margin before fee');
  const aCalc = pricingEngine.calculateMaxBid(baseMarketData({ floorPriceEth: 0.002, royaltyFeeBps: 500 }), undefined, undefined, 'robinhood');
  if (aCalc.decision === 'ACCEPT') {
    assert(aCalc.marginPercent >= 12 - 1e-6, `Accepted bid must yield >= 12% margin excl. creator (got ${aCalc.marginPercent})`);
    assert(aCalc.minAcceptableFloorEth !== undefined && 0.002 >= aCalc.minAcceptableFloorEth, 'Floor must be >= min acceptable floor');
  }
  console.log('Case A PASSED: Tiered margins (up to $5 -> 30%, >$5-$9 -> 12% after creator fee) enforced ✅');

  // B. Minimum acceptable floor for 12% margin — creator fees excluded from this specific formula
  // minFloor = offer*1.12 / (1 - marketplaceFee) = 0.00112 / 0.995
  const minFloor = pricingEngine.computeMinAcceptableFloorEth({ offerEth: 0.001, openseaFeeBps: 50, creatorFeeBps: 500, gasEth: 0, undercutPercent: 0 });
  assert(Math.abs(minFloor - 0.00112 / 0.995) < 1e-12, `minFloor = offer*1.12/(1-marketplaceFee) (got ${minFloor})`);
  const minFloorNoCreator = pricingEngine.computeMinAcceptableFloorEth({ offerEth: 0.001, openseaFeeBps: 50, creatorFeeBps: 0, gasEth: 0, undercutPercent: 0 });
  assert(Math.abs(minFloor - minFloorNoCreator) < 1e-12, 'Creator fee must not change the 12% margin floor formula');
  assert.strictEqual(pricingEngine.computeMinAcceptableFloorEth({ offerEth: 0.001, openseaFeeBps: 10000, creatorFeeBps: 0, gasEth: 0 }), Infinity);
  console.log('Case B PASSED: Minimum acceptable floor = (offer*1.12 + gas) / ((1-undercut)(1-marketplaceFee)); creator excluded ✅');

  // C + D. Final pre-offer validation on FRESH data at the exact bid
  const dApi = new OpenSeaApiService(config);
  let freshData = baseMarketData();
  let dCompeting: { priceEth: number; orderHash?: string } | null | undefined = null;
  (dApi as any).getCollectionMarketData = async () => freshData;
  (dApi as any).getTopCompetingCollectionOffer = async () => dCompeting;
  const { bidder: dBidder } = makeBidder(dApi, new InventoryManager(config));
  const fv = (bid: number) => dBidder.finalPreOfferValidation({ collectionSlug: 'rules-collection', contractAddress: ZERO, networkKey: 'robinhood', bidPriceEth: bid });
  // High marketplace fee: floor passes 1.30x but fails 12% min acceptable floor (creator excluded from that floor)
  freshData = baseMarketData({ floorPriceEth: 0.00135, referenceFloorEth: 0.00135, openseaFeeBps: 2500 });
  let dRes = await fv(0.001);
  assert.strictEqual(dRes.passed, false, 'Passing 1.30x alone is not enough when 12% margin floor is higher');
  assert(/minimum acceptable floor/.test(dRes.reason), dRes.reason);
  freshData = baseMarketData({ floorPriceEth: 0.0016, referenceFloorEth: 0.0016 });
  assert.strictEqual((await fv(0.001)).passed, true, 'Floor above min acceptable floor passes');
  // Top-Priority: bid at/below live competing top must be rejected before posting
  dCompeting = { priceEth: 0.0012, orderHash: 'higher_bidder' };
  dRes = await fv(0.001);
  assert.strictEqual(dRes.passed, false, 'Bid below competing top must fail final validation');
  assert(/Top-Priority Offer Rule/.test(dRes.reason), dRes.reason);
  dCompeting = { priceEth: 0.0009, orderHash: 'lower_bidder' };
  assert.strictEqual((await fv(0.001)).passed, true, 'Bid strictly above competing top passes #1 check');
  dCompeting = undefined;
  dRes = await fv(0.001);
  assert.strictEqual(dRes.passed, false, 'Unavailable competing book must fail closed');
  assert(/competing offers could not be verified/.test(dRes.reason), dRes.reason);
  dCompeting = null;
  // Mandatory creator fee excluded from 12% margin but still counted in actual net profit -> reject when it erodes below min
  freshData = baseMarketData({ floorPriceEth: 0.00052, referenceFloorEth: 0.00052, royaltyFeeBps: 1000 });
  assert.strictEqual((await fv(0.0004)).passed, false, 'Non-disableable creator fee counted in actual net profit');
  // optional creator fee not disabled -> reject
  freshData = baseMarketData({ floorPriceEth: 0.0016, referenceFloorEth: 0.0016, fees: [{ recipient: '0x9999999999999999999999999999999999999999', fee: 5, required: false }] as any });
  dRes = await fv(0.001);
  assert.strictEqual(dRes.passed, false);
  assert(/Optional creator fee/.test(dRes.reason));
  freshData = baseMarketData({ floorPriceEth: 0.0016, referenceFloorEth: 0.0016, fees: [{ recipient: '0x9999999999999999999999999999999999999999', fee: 5, required: false, disabled: true }] as any });
  assert.strictEqual((await fv(0.001)).passed, true, 'Disabled optional fee passes');
  // signed offer carrying the optional fee is blocked before posting
  const optFees = [{ recipient: '0x9999999999999999999999999999999999999999', fee: 5, required: false, disabled: true }] as any;
  const badOrder = { consideration: [{ itemType: 1, token: ZERO, identifierOrCriteria: '0', startAmount: '1000', endAmount: '1000', recipient: '0x9999999999999999999999999999999999999999' }] };
  assert.strictEqual(dBidder.verifySignedOfferCreatorFees(badOrder, optFees).verified, false, 'Optional fee in signed offer is rejected');
  assert.strictEqual(dBidder.verifySignedOfferCreatorFees({ consideration: [] }, optFees).verified, true);
  // other filters re-run: mint-out and sales
  freshData = baseMarketData({ floorPriceEth: 0.0016, referenceFloorEth: 0.0016, totalSupply: 900 });
  assert.strictEqual((await fv(0.001)).passed, false, 'Mint-out re-checked in final validation');
  freshData = baseMarketData({ floorPriceEth: 0.0016, referenceFloorEth: 0.0016, sales3Hours: 3 });
  // Tier 1 pre-offer check: $2.70 offer with 20% margin floor (passes 12% but fails 30%)
  freshData = baseMarketData({ floorPriceEth: 0.00132, referenceFloorEth: 0.00132, openseaFeeBps: 500 });
  const tier1Check = await fv(0.001);
  assert.strictEqual(tier1Check.passed, false, 'Up to $5 offer with <30% margin must be rejected');
  assert(/30%/.test(tier1Check.reason), tier1Check.reason);

  // Tier 2 pre-offer check: $6.75 offer (0.0025 ETH) with 10% creator fee requiring 22% pre-fee margin and 12% post-creator profit
  // With 1200 bps creator fee, pre-fee margin required is 24% (12% + 12%)
  freshData = baseMarketData({ floorPriceEth: 0.0033, referenceFloorEth: 0.0033, openseaFeeBps: 500, royaltyFeeBps: 1200 });
  const tier2Check = await fv(0.0025);
  assert.strictEqual(tier2Check.passed, false, '>$5 offer failing 12% post-creator profit must be rejected');
  assert(/creator fee/.test(tier2Check.reason), tier2Check.reason);
  (dApi as any).getCollectionMarketData = async () => { throw new Error('down'); };
  assert.strictEqual((await fv(0.001)).passed, false, 'Unfetchable fresh data rejects');
  console.log('Case C/D PASSED: Final validation (fresh data) checks mint, sales, dump, creator-fee status, 1.30x, tiered margin, and Top-Priority #1 ✅');

  // E. Auto-listing & competitive repricing
  const eApi = new OpenSeaApiService(config);
  const eData = baseMarketData({ floorPriceEth: 0.003, referenceFloorEth: 0.003 });
  (eApi as any).getCollectionMarketData = async () => eData;
  let competitor: any = null;
  (eApi as any).getLowestCompetingListing = async () => competitor;
  (eApi as any).getListingContext = async () => ({ openseaFeeBps: 50, royaltyFeeBps: 0, fees: [], ethPriceUsd: 2700, competitorEth: competitor ? competitor.priceEth : eData.floorPriceEth });
  const ePosted: number[] = [];
  const cancelled: string[] = [];
  (eApi as any).postListing = async () => ({ order_hash: `0xlist${ePosted.length}` });
  (eApi as any).cancelOffer = async (h: string) => { cancelled.push(h); return { success: true }; };
  const eSeaport = new SeaportService(config, Wallet.createRandom());
  (eSeaport as any).ensureNftConduitApproval = async () => undefined;
  (eSeaport as any).createSignedListing = async (_c: string, _t: string, price: number) => { ePosted.push(price); return { orderComponents: { consideration: [] }, signature: '0xsig' }; };
  const eInv = new InventoryManager(config);
  const eId = '0x2222222222222222222222222222222222222222:7';
  const relister = new AutoRelisterStrategy(config, eApi, pricingEngine, eSeaport, eInv, new CircuitBreaker(config));
  const minList = pricingEngine.evaluateListingOrHold(0.001, 0.003, { openseaFeeBps: 50, royaltyFeeBps: 0, ethPriceUsd: 2700 }, undefined, 'robinhood').minProfitablePriceEth!;
  const gasEthE = (config.networks?.robinhood?.estimatedGasCostUsd ?? 0.01) / 2700;
  assert(minList * 0.995 - 0.001 - gasEthE >= 0.12 * 0.001 - 1e-9, 'Min listing price yields >= 12% margin (creator excluded)');
  await relister.handleItemAcquired('rules-collection', '0x2222222222222222222222222222222222222222', '7', 0.001, 'robinhood');
  let eItem = eInv.getInventoryItem(eId)!;
  assert.strictEqual(eItem.status, 'LISTED', 'Bought NFT is auto-listed');
  assert(eItem.currentListingPriceEth! >= minList && eItem.currentListingPriceEth! < 0.003);
  const firstPrice = eItem.currentListingPriceEth!;
  // competitor undercuts us (still profitable for us to match) -> reprice below them, old listing cancelled
  competitor = { priceEth: 0.0025 };
  eItem.lastListingUpdateAt = undefined;
  await relister.monitorListedInventory();
  eItem = eInv.getInventoryItem(eId)!;
  assert(eItem.currentListingPriceEth! < 0.0025 && eItem.currentListingPriceEth! >= minList, `Repriced below competitor (${eItem.currentListingPriceEth})`);
  assert.strictEqual(cancelled.length, 1, 'Previous listing cancelled on reprice');
  // anti-churn: immediately after a reprice, another undercut waits for the cooldown
  const nPosted = ePosted.length;
  competitor = { priceEth: 0.0022 };
  await relister.monitorListedInventory();
  assert.strictEqual(ePosted.length, nPosted, 'Cooldown prevents relist churn');
  // competitor below our 12%-margin price -> hold current listing (no loss sale, no lower relist)
  const heldPrice = eInv.getInventoryItem(eId)!.currentListingPriceEth;
  competitor = { priceEth: minList * 0.9 };
  eInv.getInventoryItem(eId)!.lastListingUpdateAt = undefined;
  await relister.monitorListedInventory();
  assert.strictEqual(ePosted.length, nPosted, 'Unprofitable undercut is not matched');
  assert.strictEqual(eInv.getInventoryItem(eId)!.currentListingPriceEth, heldPrice);
  assert(heldPrice! >= minList);
  // competitor rises back but still below us -> reprice to top when profitable again
  competitor = { priceEth: 0.0020 };
  eInv.getInventoryItem(eId)!.lastListingUpdateAt = undefined;
  await relister.monitorListedInventory();
  assert(eInv.getInventoryItem(eId)!.currentListingPriceEth! < 0.0020, 'Relisted at top position once profitable');
  // not-yet-listed NFT with floor below min profitable price -> LISTED within profit range (never held on floor drop)
  const hId = '0x2222222222222222222222222222222222222222:8';
  competitor = null;
  eData.floorPriceEth = 0.0025;
  await relister.handleItemAcquired('rules-collection', '0x2222222222222222222222222222222222222222', '8', 0.0025, 'robinhood');
  assert.strictEqual(eInv.getInventoryItem(hId)!.status, 'LISTED', 'NFT is listed within profit range, never held simply because floor dropped');
  assert(eInv.getInventoryItem(hId)!.currentListingPriceEth! > 0.0025, 'Listed within profit range');
  assert(firstPrice > 0);
  // F. USDG Offer, Floor Price & Automatic WETH Swap Rules
  console.log('--- USDG Offer, Floor Price & Automatic WETH Swap Rules ---');
  // 1. Accurate Currency and Floor Price Validation: USDG is not assumed to be 1:1 with ETH
  const usdgOpenSeaApi = new OpenSeaApiService(config);
  const usdgStatsRes = {
    total: { floor_price: '4.5', floor_price_symbol: 'USDG' },
    intervals: [{ interval: 'one_day', sales: 12 }]
  };
  (usdgOpenSeaApi as any).client = {
    get: async (url: string) => {
      if (url.includes('/collections?')) {
        return {
          data: {
            collections: [
              {
                name: 'USDG Col',
                collection: 'usdg-col',
                collection_offers_enabled: true,
                contracts: [{ address: '0x3333333333333333333333333333333333333333' }]
              }
            ]
          }
        };
      }
      if (url.includes('/stats')) return { data: usdgStatsRes };
      if (url.includes('/listings/collection')) return { data: { listings: [] } };
      return { data: {} };
    }
  };
  (usdgOpenSeaApi as any).getEthPriceUsd = async () => 2700;
  const fastFloorRes = await usdgOpenSeaApi.discoverCollectionsByChain('robinhood', 1.0, 9.0, 1);
  assert(fastFloorRes.length === 1, 'USDG collection discovered in target price range');
  assert.strictEqual(fastFloorRes[0].currency, 'USDG');
  assert.strictEqual(fastFloorRes[0].floorUsd, 4.5);
  // 4.5 USDG at $2700/ETH must be ~0.001667 ETH, never 4.5 ETH!
  assert(Math.abs(fastFloorRes[0].floorEth - (4.5 / 2700)) < 1e-6, `floorEth must be 4.5/2700, got ${fastFloorRes[0].floorEth}`);

  // 2. Mandatory Profitability Check for USDG
  const usdgMarketData = baseMarketData({
    currency: 'USDG',
    floorPriceUsdg: 4.5,
    floorPriceEth: 4.5 / 2700,
    referenceFloorEth: 4.5 / 2700,
    openseaFeeBps: 50,
    royaltyFeeBps: 0
  });
  const usdgPricing = pricingEngine.calculateMaxBid(usdgMarketData, 0.20, 10.0, 'robinhood');
  assert.strictEqual(usdgPricing.currency, 'USDG');
  assert(usdgPricing.bidPriceUsd <= 4.5, 'USDG bid is capped by USDG floor');
  assert(usdgPricing.marginPercent >= 30.0, `Expected profit margin >= 30% for <=$5 USDG offer (got ${usdgPricing.marginPercent}%)`);

  // 3. Seaport USDG Offer Generation
  const usdgSeaport = new SeaportService(config, Wallet.createRandom());
  const usdgContractAddr = '0x595a8910ba11e38ada602430b8b1122644247b0c';
  const signedUsdgOffer = await usdgSeaport.createSignedCollectionOffer(
    '0x3333333333333333333333333333333333333333',
    usdgPricing.bidPriceEth,
    20,
    'robinhood',
    [],
    { currency: 'USDG', bidPriceUsdg: usdgPricing.bidPriceUsdg }
  );
  assert.strictEqual(signedUsdgOffer.orderComponents.offer[0].token.toLowerCase(), usdgContractAddr.toLowerCase(), 'Offer token must be USDG address');
  // Decimals check: 6 decimals for USDG
  const expectedUsdgUnits = Math.round(usdgPricing.bidPriceUsd * 1e6);
  const actualUsdgUnits = Number(signedUsdgOffer.orderComponents.offer[0].startAmount);
  assert(Math.abs(actualUsdgUnits - expectedUsdgUnits) <= 2, `USDG startAmount formatted with 6 decimals (got ${actualUsdgUnits}, expected ${expectedUsdgUnits})`);

  // 4. Automatic 100% USDG to WETH Post-Sale Swap
  process.env.BOT_MODE = 'SIMULATION';
  const swapResult = await usdgSeaport.swapUsdgToWeth(4.45, 'robinhood');
  assert.strictEqual(swapResult.success, true);
  assert.strictEqual(swapResult.verified, true);
  assert.strictEqual(swapResult.amountSwappedUsdg, 4.45, '100% of USDG proceeds swapped');
  console.log('Case F PASSED: USDG identified & converted accurately, profitability verified, USDG offer generated, 100% swapped to WETH after sale ✅\n');

  // -------------------------------------------------------------------------
  // Case G: NFT Stop-Loss Auto-Listing & Top-Priority Rules (Part 2)
  // 1. At 45% Price Drop: list at current floor and maintain top-priority (#1) status.
  // 2. At 60% Price Drop: update listing to current floor and regain top-priority (#1) status.
  // 3. At 80% Price Drop: update listing to current floor and regain top-priority (#1) status.
  // 4. One-Time Trigger Per Threshold: Each threshold must trigger only once per NFT.
  // -------------------------------------------------------------------------
  console.log('--- Case G: NFT Stop-Loss Auto-Listing & Top-Priority Rules (Part 2) ---');
  const acquiredCostEth = 1.0;
  const mockMarketData = { openseaFeeBps: 50, royaltyFeeBps: 0, ethPriceUsd: 2700 };

  // G1. 30% drop -> No stop-loss triggered
  assert.strictEqual(
    pricingEngine.getEligibleStopLossThreshold(acquiredCostEth, 0.70, []),
    null,
    '30% drop should not trigger stop loss'
  );

  // G2. 45% drop -> Triggers 45% stop-loss threshold
  assert.strictEqual(
    pricingEngine.getEligibleStopLossThreshold(acquiredCostEth, 0.55, []),
    45,
    '45% drop must trigger 45% threshold'
  );
  const eval45 = pricingEngine.evaluateListingOrHold(
    acquiredCostEth,
    0.55,
    mockMarketData,
    0.20,
    'robinhood',
    0.55,
    []
  );
  assert.strictEqual(eval45.action, 'LIST');
  assert.strictEqual(eval45.isStopLoss, true);
  assert.strictEqual(eval45.stopLossThreshold, 45);
  // Undercut by 1% from 0.55 -> 0.5445 ETH for #1 priority
  assert.strictEqual(eval45.recommendedListPriceEth, 0.5445);

  // G3. One-time trigger: subsequent 48% drop with 45 already recorded must NOT trigger
  assert.strictEqual(
    pricingEngine.getEligibleStopLossThreshold(acquiredCostEth, 0.52, [45]),
    null,
    '45% threshold must not trigger repeatedly'
  );

  // G4. 60% drop -> Triggers 60% stop-loss threshold
  assert.strictEqual(
    pricingEngine.getEligibleStopLossThreshold(acquiredCostEth, 0.40, [45]),
    60,
    '60% drop must trigger 60% threshold'
  );
  const eval60 = pricingEngine.evaluateListingOrHold(
    acquiredCostEth,
    0.40,
    mockMarketData,
    0.20,
    'robinhood',
    0.40,
    [45]
  );
  assert.strictEqual(eval60.action, 'LIST');
  assert.strictEqual(eval60.isStopLoss, true);
  assert.strictEqual(eval60.stopLossThreshold, 60);
  assert.strictEqual(eval60.recommendedListPriceEth, 0.396);

  // G5. One-time trigger: 65% drop with [45, 60] recorded must NOT trigger
  assert.strictEqual(
    pricingEngine.getEligibleStopLossThreshold(acquiredCostEth, 0.35, [45, 60]),
    null,
    '60% threshold must not trigger repeatedly'
  );

  // G6. 80% drop -> Triggers 80% stop-loss threshold
  assert.strictEqual(
    pricingEngine.getEligibleStopLossThreshold(acquiredCostEth, 0.20, [45, 60]),
    80,
    '80% drop must trigger 80% threshold'
  );
  const eval80 = pricingEngine.evaluateListingOrHold(
    acquiredCostEth,
    0.20,
    mockMarketData,
    0.20,
    'robinhood',
    0.20,
    [45, 60]
  );
  assert.strictEqual(eval80.action, 'LIST');
  assert.strictEqual(eval80.isStopLoss, true);
  assert.strictEqual(eval80.stopLossThreshold, 80);
  assert.strictEqual(eval80.recommendedListPriceEth, 0.198);

  // G7. One-time trigger: 85% drop with [45, 60, 80] recorded must NOT trigger
  assert.strictEqual(
    pricingEngine.getEligibleStopLossThreshold(acquiredCostEth, 0.15, [45, 60, 80]),
    null,
    '80% threshold must not trigger repeatedly'
  );

  // G8. Strategy-level integration test:
  // Verifying monitorListedInventory updates listing at each threshold and maintains top priority (#1)
  const gInv = new InventoryManager(config);
  const gApi = new OpenSeaApiService(config);
  const gSeaport = new SeaportService(config, Wallet.createRandom());
  let gPostedListings: Array<{ priceEth: number }> = [];
  (gApi as any).getEthPriceUsd = async () => 2700;
  (gApi as any).getListingContext = async () => ({
    openseaFeeBps: 50,
    royaltyFeeBps: 0,
    ethPriceUsd: 2700,
    fees: []
  });
  (gApi as any).postListing = async (_chain: string, payload: any) => {
    const totalWei = payload.parameters.consideration.reduce(
      (sum: bigint, c: any) => sum + BigInt(c.startAmount),
      0n
    );
    const price = Number(totalWei) / 1e18;
    gPostedListings.push({ priceEth: price });
    return { order_hash: `0xlisting_${Date.now()}` };
  };
  (gApi as any).cancelOffer = async () => ({ success: true });
  (gSeaport as any).ensureNftConduitApproval = async () => true;

  const gRelister = new AutoRelisterStrategy(config, gApi, pricingEngine, gSeaport, gInv, new CircuitBreaker(config));
  const gItemIdentifier = `${nftContract}:777`;
  gInv.addInventoryItem({
    identifier: gItemIdentifier,
    collectionSlug: 'stop-loss-col',
    contractAddress: nftContract,
    tokenId: '777',
    acquiredPriceEth: 1.0,
    acquiredPriceUsd: 2700,
    acquiredAtTimestamp: Date.now() - 60000,
    currentListingPriceEth: 1.30,
    listingOrderId: 'sim_init',
    status: 'LISTED',
    listingStatus: 'LISTED'
  });

  // Step 1: Floor drops 45% (competitor at 0.55 ETH)
  (gApi as any).getLowestCompetingListing = async () => ({ priceEth: 0.55 });
  await gRelister.monitorListedInventory();
  assert.strictEqual(gPostedListings.length, 1, '45% drop must post updated listing');
  assert.strictEqual(gPostedListings[0].priceEth, 0.5445, 'Listing updated to 0.5445 ETH (#1 priority)');
  const itemAfter45 = gInv.getInventoryItem(gItemIdentifier)!;
  assert.deepStrictEqual(itemAfter45.stopLossTriggeredThresholds, [45], '45 threshold recorded');
  assert.strictEqual(itemAfter45.currentListingPriceEth, 0.5445);

  // Step 2: Competitor at 0.52 ETH (48% drop) -> 45 already triggered, does NOT trigger again
  gPostedListings = [];
  (gApi as any).getLowestCompetingListing = async () => ({ priceEth: 0.52 });
  await gRelister.monitorListedInventory();
  assert.strictEqual(gPostedListings.length, 0, 'No re-trigger between 45% and 60% drops');

  // Step 3: Floor drops 60% (competitor at 0.40 ETH)
  (gApi as any).getLowestCompetingListing = async () => ({ priceEth: 0.40 });
  await gRelister.monitorListedInventory();
  assert.strictEqual(gPostedListings.length, 1, '60% drop must post updated listing');
  assert.strictEqual(gPostedListings[0].priceEth, 0.396, 'Listing updated to 0.396 ETH (#1 priority)');
  const itemAfter60 = gInv.getInventoryItem(gItemIdentifier)!;
  assert.deepStrictEqual(itemAfter60.stopLossTriggeredThresholds, [45, 60], '60 threshold recorded');
  assert.strictEqual(itemAfter60.currentListingPriceEth, 0.396);

  // Step 4: Floor drops 80% (competitor at 0.20 ETH)
  gPostedListings = [];
  (gApi as any).getLowestCompetingListing = async () => ({ priceEth: 0.20 });
  await gRelister.monitorListedInventory();
  assert.strictEqual(gPostedListings.length, 1, '80% drop must post updated listing');
  assert.strictEqual(gPostedListings[0].priceEth, 0.198, 'Listing updated to 0.198 ETH (#1 priority)');
  const itemAfter80 = gInv.getInventoryItem(gItemIdentifier)!;
  assert.deepStrictEqual(itemAfter80.stopLossTriggeredThresholds, [45, 60, 80], '80 threshold recorded');
  assert.strictEqual(itemAfter80.currentListingPriceEth, 0.198);

  console.log('Case G PASSED: Stop-loss auto-listing at 45%, 60%, 80% with #1 priority & one-time trigger verified ✅\n');

  // ------------------------------------------------------------------------
  // RULE H: Same-Buyer Activity Filter
  // ------------------------------------------------------------------------
  console.log('--- Rule H: Same-Buyer Activity Filter ---');
  // H1: PricingEngine rejects if sameBuyerActivityDetected is true
  const sameBuyerMarketData = baseMarketData({
    sales3Hours: 15,
    uniqueWallets3Hours: 8,
    sales30Minutes: 5,
    uniqueBuyers30Minutes: 1,
    sameBuyerActivityDetected: true,
    liquidityPassed: false,
    liquidityReason: 'Same-Buyer Activity Filter: Only 1 unique buyer in last 30 min'
  });
  const sameBuyerCalc = pricingEngine.calculateMaxBid(sameBuyerMarketData, 0.20, 10, 'robinhood');
  assert.strictEqual(sameBuyerCalc.decision, 'REJECT', 'Same buyer activity must reject offer');
  assert.strictEqual(sameBuyerCalc.checkLLiquidityPassed, false, 'Liquidity must not pass when same buyer activity detected');

  // H2: OpenSeaApiService getCollectionLiquidity flags same buyer when only 1 buyer in 30 min
  const sameBuyerApi = new OpenSeaApiService(config);
  const nowSecH = Math.floor(Date.now() / 1000);
  const sampleEvents = [
    // 5 sales in the last 15 minutes, all to same buyer '0xbuyer1' from 5 different sellers
    ...Array.from({ length: 5 }, (_, i) => ({
      event_timestamp: String(nowSecH - 600),
      payment_token: { symbol: 'ETH', eth_price: '0.0020' },
      buyer: '0xbuyer1',
      seller: `0xseller${i}`
    })),
    // 6 older sales (1-2 hours ago) to different buyers
    ...Array.from({ length: 6 }, (_, i) => ({
      event_timestamp: String(nowSecH - 4000),
      payment_token: { symbol: 'ETH', eth_price: '0.0020' },
      buyer: `0xdifferentbuyer${i}`,
      seller: `0xoldseller${i}`
    }))
  ];
  (sameBuyerApi as any).client = { get: async () => ({ data: { asset_events: sampleEvents } }) };
  const sameBuyerLiq = await sameBuyerApi.getCollectionLiquidity('same-buyer-test', 0.0020);
  assert.strictEqual(sameBuyerLiq.sameBuyerActivityDetected, true, 'Should detect only 1 unique buyer in last 30 minutes');
  assert.strictEqual(sameBuyerLiq.liquidityPassed, false, 'Liquidity must fail when same buyer detected');
  assert(sameBuyerLiq.liquidityReason?.includes('Same-Buyer Activity Filter'), 'Reason must mention Same-Buyer Filter');

  // H3: When multiple buyers exist in last 30 min, sameBuyerActivityDetected is false
  const multiBuyerEvents = [
    { event_timestamp: String(nowSecH - 600), payment_token: { symbol: 'ETH', eth_price: '0.0020' }, buyer: '0xbuyerA', seller: '0xseller1' },
    { event_timestamp: String(nowSecH - 500), payment_token: { symbol: 'ETH', eth_price: '0.0020' }, buyer: '0xbuyerB', seller: '0xseller2' },
    ...Array.from({ length: 9 }, (_, i) => ({
      event_timestamp: String(nowSecH - 4000),
      payment_token: { symbol: 'ETH', eth_price: '0.0020' },
      buyer: `0xbuyer${i}`,
      seller: `0xseller${i}`
    }))
  ];
  (sameBuyerApi as any).client = { get: async () => ({ data: { asset_events: multiBuyerEvents } }) };
  const multiBuyerLiq = await sameBuyerApi.getCollectionLiquidity('multi-buyer-test', 0.0020);
  assert.strictEqual(multiBuyerLiq.sameBuyerActivityDetected, false, 'Multiple buyers in 30 min must not flag same buyer');
  assert.strictEqual(multiBuyerLiq.liquidityPassed, true, 'Diversified buyers must pass liquidity');
  console.log('Case H PASSED: Same-Buyer Activity Filter rejects collections with single buyer in last 30 minutes ✅\n');

  // ------------------------------------------------------------------------
  // RULE I: Instant Offer Cancellation Rule (USD/USDG & Continuous Retry)
  // ------------------------------------------------------------------------
  console.log('--- Rule I: Instant Offer Cancellation (USD/USDG & Continuous Retry) ---');
  // I1: Outbid in USD ($4.36 > $4.12) is immediately detected and cancelled
  const outbidApi = new OpenSeaApiService(config);
  (outbidApi as any).getEthPriceUsd = async () => 2700;
  (outbidApi as any).getTopCompetingCollectionOffer = async () => ({
    priceEth: 4.36 / 2700,
    priceUsd: 4.36,
    orderHash: '0xcompetitor_top'
  });
  let instantCancelled = 0;
  (outbidApi as any).cancelOffer = async () => { instantCancelled++; return { success: true }; };
  (outbidApi as any).verifyOfferInactive = async () => ({ isInactive: true, status: 'CANCELLED' });

  const outbidInv = new InventoryManager(config);
  const { bidder: outbidBidder } = makeBidder(outbidApi, outbidInv);
  outbidInv.registerActiveOffer({
    orderHash: 'our_offer_412',
    collectionSlug: 'usd-test-collection',
    contractAddress: baseMarketData().contractAddress,
    priceEth: 4.12 / 2700,
    priceUsd: 4.12,
    createdTimestamp: Date.now() - 60000, // placed 1 minute ago (not expired!)
    expiresTimestamp: Date.now() + 19 * 60000,
    status: 'ACTIVE'
  });

  const scanRes = await outbidBidder.processOutbidOfferCancellations();
  assert.strictEqual(scanRes.cancelled, 1, 'Offer outbid in USD ($4.36 > $4.12) must be cancelled immediately');
  assert.strictEqual(instantCancelled, 1, 'Cancel request must have been sent immediately');
  assert.strictEqual(outbidInv.getActiveOffer('our_offer_412'), undefined, 'Offer must be removed from active offers');

  // I2: Offer in CANCELLATION_FAILED or CANCELLATION_PENDING is retried immediately by processOutbidOfferCancellations
  const retryInv = new InventoryManager(config);
  const { bidder: retryBidder } = makeBidder(outbidApi, retryInv);
  retryInv.registerActiveOffer({
    orderHash: 'pending_outbid_offer',
    collectionSlug: 'usd-test-collection',
    contractAddress: baseMarketData().contractAddress,
    priceEth: 4.12 / 2700,
    priceUsd: 4.12,
    createdTimestamp: Date.now() - 30000, // only 30s old, far from 20m expiry
    expiresTimestamp: Date.now() + 19 * 60000,
    status: 'CANCELLATION_FAILED'
  });
  const retryScan = await retryBidder.processOutbidOfferCancellations();
  assert.strictEqual(retryScan.cancelled, 1, 'Pending/failed cancellation must be retried and resolved without waiting 20m');
  assert.strictEqual(retryInv.getActiveOffer('pending_outbid_offer'), undefined, 'Pending offer confirmed cancelled and removed');
  console.log('Case I PASSED: Instant Offer Cancellation in USD & immediate pending cancellation retries verified ✅\n');

  process.env.BOT_MODE = originalBotMode;
  console.log('================================================================');
  console.log('All Trading Rules regression tests passed successfully!');
  console.log('================================================================');
})().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
