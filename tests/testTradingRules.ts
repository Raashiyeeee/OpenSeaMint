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
  (seaport as any).isOrderCancelledOnChain = async () => false; // never touch a live RPC in tests
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
  const noMax = await mintApi.getCollectionMarketData('rules-collection', ZERO, 'robinhood');
  assert.strictEqual(noMax.mintStatusVerified, false, 'Only total_supply known -> unverifiable');
  assert.strictEqual(noMax.mintCompleted, false, 'Unverifiable must not be treated as minted out');
  dropStub = { totalSupply: 500, maxSupply: 500, isMinting: false };
  const viaDrop = await mintApi.getCollectionMarketData('rules-collection', ZERO, 'robinhood');
  assert.strictEqual(viaDrop.mintStatusVerified, true, 'Drops API total == max must verify');
  assert.strictEqual(viaDrop.mintCompleted, true);
  dropStub = {};
  chainStub = { totalSupply: 500, maxSupply: 500 };
  const viaChain = await mintApi.getCollectionMarketData('rules-collection', ZERO, 'robinhood');
  assert.strictEqual(viaChain.mintCompleted, true, 'On-chain totalSupply == maxSupply must verify');
  chainStub = { totalSupply: 480, maxSupply: 500 };
  const chainIncomplete = await mintApi.getCollectionMarketData('rules-collection', ZERO, 'robinhood');
  assert.strictEqual(chainIncomplete.mintCompleted, false, 'On-chain 480/500 must reject even if API total says 500');
  dropStub = { totalSupply: 500, maxSupply: 500, isMinting: true };
  chainStub = {};
  assert.strictEqual((await mintApi.getCollectionMarketData('rules-collection', ZERO, 'robinhood')).mintCompleted, false, 'Active drop mint must reject');
  // Pure decision rules
  assert.strictEqual(OpenSeaApiService.evaluateMintSupply({ dropMaxSupply: 0, dropTotalSupply: 100 }).verified, false, 'max_supply 0 (open edition/unknown) is unverifiable');
  assert.strictEqual(OpenSeaApiService.evaluateMintSupply({ onChainMaxSupply: 1000, onChainTotalSupply: 1000, collectionTotalSupply: 990 }).completed, false, 'Any source below max -> reject');
  console.log('Case R1e PASSED: Mint-out verified from Drops API / on-chain supply; conflicts or unknown max reject ✅');

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
  const fakeProvider: any = { getBalance: async () => parseEther('1') };
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
  console.log('Case R6a-c PASSED: 90% wrapped / 10% kept as gas; wrap verified by receipt + WETH balance delta ✅\n');

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
  (c5Api as any).getCollectionMarketData = async () => baseMarketData({ topOfferEth: 0.0005 });
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
  (c5Api as any).getBestNftOffer = async () => ({ priceEth: 0.001, orderHash: 'item_offer2' });
  const { bidder: c5bBidder } = makeBidder(c5Api, c5bInv);
  c5bInv.registerActiveOffer({ ...mkOffer(), orderHash: 'item_offer2', tokenId: '43', createdTimestamp: Date.now(), expiresTimestamp: Date.now() + 600000 });
  assert.strictEqual((await c5bBidder.processOutbidOfferCancellations()).cancelled, 0, 'Our own best offer is not an outbid');
  // C6. Multi-quantity offers are compared per unit
  assert.strictEqual(
    OpenSeaApiService.perUnitOfferPriceEth({ price: { value: '3000000000000000', decimals: 18 }, protocol_data: { parameters: { consideration: [{ startAmount: '3' }] } } }),
    0.001
  );
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
  console.log('Case C1-C8 PASSED: OpenSea chain/status/cancel semantics, per-NFT outbid, per-unit offers, sale-vs-transfer, no committed RPC keys ✅\n');

  process.env.BOT_MODE = originalBotMode;
  console.log('================================================================');
  console.log('All Trading Rules regression tests passed successfully!');
  console.log('================================================================');
})().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
