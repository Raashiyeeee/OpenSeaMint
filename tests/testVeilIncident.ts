import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Wallet } from 'ethers';
import { PricingEngine } from '../src/services/PricingEngine';
import { InventoryManager } from '../src/services/InventoryManager';
import { OpenSeaApiService } from '../src/services/OpenSeaApiService';
import { OpenSeaStreamService } from '../src/services/OpenSeaStreamService';
import { SeaportService } from '../src/services/SeaportService';
import { CircuitBreaker } from '../src/security/CircuitBreaker';
import { CollectionBidderStrategy } from '../src/strategies/CollectionBidderStrategy';
import { AutoRelisterStrategy } from '../src/strategies/AutoRelisterStrategy';
import { loadConfig } from '../src/config/schema';

/**
 * Regression for the live Veil incident (wallet 007-AA, IST):
 *  11:59 collection offer on Veil at $2.76 -> bought #991 one minute later
 *  12:04 #991 listed at $4.03 (~3 min after buy, not within 10s)
 *  12:07 NEW collection offer on Veil at $2.00 -> bought #924 -> never listed
 * All network access is stubbed; nothing touches live markets.
 */
const config = loadConfig();
const pricing = new PricingEngine(config);
const ETH_USD = 2700;
const usd = (x: number) => x / ETH_USD;
const VEIL = 'veil';
const VEIL_CONTRACT = '0x7e11000000000000000000000000000000000991';
const OS_FEE = { recipient: '0x0000a26b00c1f0df003000390027140000faa719', fee: 1, required: true };

(async () => {
  console.log('================================================================');
  console.log('Running Veil Incident Regression Tests');
  console.log('================================================================\n');
  const prevMode = process.env.BOT_MODE;
  delete process.env.BOT_MODE;

  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'veil-')), 'state.json');
  const inv = new InventoryManager(config, statePath);
  const wallet = Wallet.createRandom();
  const ours = wallet.address.toLowerCase();

  const api = new OpenSeaApiService(config);
  (api as any).getEthPriceUsd = async () => ETH_USD;
  let competitorEth: number | null = usd(4.07);
  (api as any).getListingContext = async () => ({ openseaFeeBps: 100, royaltyFeeBps: 0, fees: [OS_FEE], ethPriceUsd: ETH_USD, competitorEth });
  const cancelled: string[] = [];
  (api as any).cancelOffer = async (h: string) => { cancelled.push(h); return { success: true }; };
  (api as any).getTopCompetingCollectionOffer = async () => null;
  (api as any).invalidateCollectionCache = () => undefined;
  const orderStatus: Record<string, string> = {};
  (api as any).verifyOfferInactive = async (h: string) => {
    const st = orderStatus[h] || (cancelled.includes(h) ? 'CANCELLED' : 'ACTIVE');
    return { isInactive: st !== 'ACTIVE', status: st };
  };
  const listed: Array<{ tokenId: string; priceEth: number }> = [];
  (api as any).postListing = async () => ({ order_hash: `0xlisting${listed.length}` });
  let walletNfts: any[] = [];
  (api as any).getAccountNfts = async () => walletNfts;

  const seaport = new SeaportService(config, wallet);
  (seaport as any).ensureNftConduitApproval = async () => undefined;
  (seaport as any).createSignedListing = async (_c: string, tokenId: string, priceEth: number) => {
    listed.push({ tokenId, priceEth });
    return { orderComponents: { consideration: [] }, signature: '0xsig' };
  };
  let offersSigned = 0;
  (seaport as any).getWethBalance = async () => 1;
  (seaport as any).createSignedCollectionOffer = async () => { offersSigned++; return { orderComponents: {}, signature: '0x' }; };
  (seaport as any).isOrderCancelledOnChain = async () => false;

  const bidder = new CollectionBidderStrategy(config, api, pricing, seaport, inv, new CircuitBreaker(config));
  const relister = new AutoRelisterStrategy(config, api, pricing, seaport, inv, new CircuitBreaker(config));
  relister.setCollectionFillHandler(async (slug, contract) => { await bidder.cancelAllOffersForCollection(slug, contract); });

  // 11:59 — collection offer at $2.76, plus a second live offer of ours on Veil
  const mkOffer = (orderHash: string, priceUsd: number, tokenId?: string) => ({
    orderHash, collectionSlug: VEIL, contractAddress: VEIL_CONTRACT, network: 'robinhood', tokenId,
    priceEth: usd(priceUsd), priceUsd, createdTimestamp: Date.now(), expiresTimestamp: Date.now() + 20 * 60_000, status: 'ACTIVE' as const
  });
  inv.registerActiveOffer(mkOffer('0xoffer276', 2.76));
  inv.registerActiveOffer(mkOffer('0xoffer_item', 2.5, '17'));

  // Active offers survive a restart (an orphaned live offer can still fill)
  assert.strictEqual(new InventoryManager(config, statePath).getAllActiveOffers().length, 2, 'Active offers persisted');
  console.log('Case V0 PASSED: live offers persisted across restart ✅');

  // 12:00 — #991 bought. Stream item_sold has maker = us (accepted BID: maker is the buyer)
  const stream = new OpenSeaStreamService(config, wallet.address);
  let tradeEvents = 0;
  stream.on('nft_trade', () => tradeEvents++);
  stream.handleMessage({ event: 'item_sold', payload: { payload: { maker: { address: wallet.address }, taker: { address: '0xseller' }, item: { nft_id: `robinhood/${VEIL_CONTRACT}/991` } } } });
  assert.strictEqual(tradeEvents, 1, 'Purchase via accepted bid is detected on the stream (maker = us)');

  const t0 = Date.now();
  const r991 = await relister.onPurchaseDetected({ collectionSlug: VEIL, contractAddress: VEIL_CONTRACT, tokenId: '991', network: 'robinhood', orderHash: '0xoffer276', source: 'stream:item_sold' });
  const elapsed = Date.now() - t0;
  const item991 = inv.getInventoryItem(`${VEIL_CONTRACT}:991`)!;
  assert.strictEqual(r991.outcome, 'LISTED', `#991 listed immediately (${r991.reason})`);
  assert.strictEqual(item991.status, 'LISTED');
  assert(elapsed < 10_000, `Listed within 10s (took ${elapsed}ms)`);
  assert(Math.abs(item991.acquiredPriceEth - usd(2.76)) < 1e-12, 'Cost basis = our accepted offer price');
  const min991 = pricing.evaluateListingOrHold(usd(2.76), 0, { openseaFeeBps: 100, royaltyFeeBps: 0, ethPriceUsd: ETH_USD }, undefined, 'robinhood').minProfitablePriceEth!;
  assert(item991.currentListingPriceEth! >= min991 && item991.currentListingPriceEth! < usd(4.07), 'Top competitive price that keeps 40% margin');
  assert(cancelled.includes('0xoffer_item'), 'Every other live offer on Veil cancelled when one filled');
  assert.strictEqual(inv.getLiveOffersForCollection(VEIL, VEIL_CONTRACT).length, 0, 'No live Veil offers remain');
  console.log(`Case V1 PASSED: #991 listed in ${elapsed}ms at ${item991.currentListingPriceEth} ETH (min ${min991}); other Veil offers cancelled+verified ✅`);

  // 12:07 — the bot must NOT place a new collection offer on Veil while #991 is unsold
  const block = inv.canOfferOnCollection(VEIL, VEIL_CONTRACT);
  assert.strictEqual(block.allowed, false);
  const fv = await bidder.finalPreOfferValidation({ collectionSlug: VEIL, contractAddress: VEIL_CONTRACT, networkKey: 'robinhood', bidPriceEth: usd(2.0) });
  assert.strictEqual(fv.passed, false, 'Final validation blocks offers on a collection we hold');
  (api as any).getCollectionMarketData = async () => { throw new Error('must not even fetch market data'); };
  await (bidder as any).processCollectionBid({ slug: VEIL, contractAddress: VEIL_CONTRACT, enabled: true, maxInventory: 5 }, 'robinhood');
  assert.strictEqual(offersSigned, 0, 'No $2.00 offer is signed');
  assert.strictEqual(new InventoryManager(config, statePath).canOfferOnCollection(VEIL, VEIL_CONTRACT).allowed, false, 'Block persists across restart');
  console.log('Case V2 PASSED: no new Veil offer while #991 is unsold (persisted) ✅');

  // Reproduce #924 anyway (e.g. an offer that was already live): bought at $2.00 while the market fell below the
  // 40%-margin price -> HOLD with an explicit reason and a FAST retry, then listed as soon as profitable.
  inv.registerActiveOffer(mkOffer('0xoffer200', 2.0));
  competitorEth = usd(2.40); // min 40% price for $2.00 cost is ~$2.83
  orderStatus['0xoffer200'] = 'FULFILLED';
  walletNfts = [{ contract: VEIL_CONTRACT, identifier: '924', collection: VEIL }, { contract: VEIL_CONTRACT, identifier: '991', collection: VEIL }];
  let fills = 0;
  await bidder.checkOffersForFills(async (offer) => {
    fills++;
    await relister.detectNewHoldings(wallet.address, offer.collectionSlug, 'robinhood', 'order:FULFILLED');
  });
  assert.strictEqual(fills, 1, 'FULFILLED order status detected without the stream');
  const item924 = inv.getInventoryItem(`${VEIL_CONTRACT}:924`)!;
  assert(item924, '#924 tracked from order-status + wallet lookup');
  assert(Math.abs(item924.acquiredPriceEth - usd(2.0)) < 1e-12, 'Cost basis = the $2.00 offer');
  assert.strictEqual(item924.status, 'HOLDING');
  assert(/market below profitable price/.test(item924.holdReason || ''), `Hold reason is explicit: ${item924.holdReason}`);
  assert(item924.nextListingAttemptAt! - Date.now() <= AutoRelisterStrategy.HOLD_RETRY_MS, 'Quick retry scheduled');
  const nListed = listed.length;
  await relister.processPendingListings(Date.now());
  assert.strictEqual(listed.length, nListed, 'Not retried before its retry time');
  competitorEth = usd(3.20);
  await relister.processPendingListings(item924.nextListingAttemptAt! + 1);
  assert.strictEqual(inv.getInventoryItem(`${VEIL_CONTRACT}:924`)!.status, 'LISTED', '#924 listed as soon as a profitable price exists');
  console.log('Case V3 PASSED: #924 detected via order FULFILLED, held with explicit reason, relisted on fast retry ✅');

  // Unknown cost basis: never guessed (old code used 0.0004 ETH / floor*0.85) -> HOLD with reason
  const r555 = await relister.onPurchaseDetected({ collectionSlug: 'other', contractAddress: '0x5550000000000000000000000000000000000555', tokenId: '1', source: 'wallet-scan' });
  assert.strictEqual(r555.outcome, 'HOLD');
  assert(/cost basis\) unknown/.test(r555.reason));
  // Generic OpenSea "Validation error" is retried, not a permanent ERROR
  (api as any).postListing = async () => { throw new Error('Validation error: something'); };
  const r777 = await relister.onPurchaseDetected({ collectionSlug: 'other2', contractAddress: '0x7770000000000000000000000000000000000777', tokenId: '2', eventPriceEth: usd(1), source: 'stream:item_transferred' });
  assert.strictEqual(r777.outcome, 'ERROR');
  assert.notStrictEqual(inv.getInventoryItem('0x7770000000000000000000000000000000000777:2')!.status, 'ERROR', 'Not permanently excluded');
  console.log('Case V4 PASSED: unknown cost -> HOLD (no guessed price); validation error -> fast retry, not permanent ✅');

  // Floor: our own listing ($4.03) must never be the floor that justifies the next offer
  const fapi = new OpenSeaApiService(config);
  fapi.setOwnWalletAddress(wallet.address);
  (fapi as any).getEthPriceUsd = async () => ETH_USD;
  (fapi as any).getDropSupply = async () => ({ totalSupply: 1000, maxSupply: 1000, isMinting: false });
  (fapi as any).readOnChainSupply = async () => ({});
  let bestListings: any[] = [];
  let sales: any[] = [];
  const now = Math.floor(Date.now() / 1000);
  const listing = (maker: string, eth: number) => ({ order_hash: `0x${maker.slice(2, 6)}${eth}`, price: { current: { value: String(Math.round(eth * 1e18)), decimals: 18 } }, protocol_data: { parameters: { offerer: maker, offer: [{ startAmount: '1' }] } } });
  (fapi as any).client = {
    get: async (url: string) => {
      if (url.endsWith('/stats')) return { data: { total: { floor_price: usd(4.03), floor_price_symbol: 'ETH' } } };
      if (url.startsWith('/collections/')) return { data: { total_supply: 1000, fees: [OS_FEE] } };
      if (url.startsWith('/listings/collection/')) return { data: { listings: bestListings } };
      if (url.startsWith('/offers/')) return { data: { offers: [] } };
      if (url.startsWith('/events/')) return { data: { asset_events: sales } };
      return { data: {} };
    }
  };
  bestListings = [listing(ours, usd(4.03)), listing('0x00000000000000000000000000000000000000aa', usd(2.40))];
  sales = Array.from({ length: 12 }, (_, i) => ({
    event_type: 'sale', event_timestamp: now - 120 * (i + 1), payment: { symbol: 'ETH', quantity: String(Math.round(usd(2.2) * 1e18)), decimals: 18, token_address: '0x0000000000000000000000000000000000000000' },
    buyer: `0xb${i}`, seller: `0xs${i}`
  }));
  const md = await fapi.getCollectionMarketData(VEIL, VEIL_CONTRACT, 'robinhood');
  assert.strictEqual(md.statsFloorEth, usd(4.03), 'Stats floor = our own listing');
  assert(Math.abs(md.listingFloorEth! - usd(2.40)) < 1e-12, 'Competing floor excludes our listing');
  assert(Math.abs(md.floorPriceEth - usd(2.2)) < 1e-9, 'Expected sale price capped at median recent sale');
  const calc = pricing.calculateMaxBid(md, undefined, undefined, 'robinhood');
  assert(calc.bidPriceEth * ETH_USD < 2.0, `A $2.00 offer is no longer justified (max bid $${(calc.bidPriceEth * ETH_USD).toFixed(2)})`);
  bestListings = [listing(ours, usd(4.03))];
  fapi.clearCaches();
  const onlyOurs = await fapi.getCollectionMarketData(VEIL, VEIL_CONTRACT, 'robinhood');
  assert(onlyOurs.earlyRejectReason && /our own listing/.test(onlyOurs.earlyRejectReason), 'Only-our-listing floor rejects');
  console.log(`Case V5 PASSED: own listing excluded from floor; expected sale capped by recent sales; max bid $${(calc.bidPriceEth * ETH_USD).toFixed(2)} ✅`);

  // After BOTH Veil NFTs are confirmed sold, collection offers may resume (if all criteria pass)
  for (const id of ['991', '924']) inv.markItemSold(`${VEIL_CONTRACT}:${id}`, usd(4), ETH_USD, 100, 0.01, `0xsale${id}`);
  assert.strictEqual(inv.canOfferOnCollection(VEIL, VEIL_CONTRACT).allowed, true, 'Block lifted only after confirmed sales');
  console.log('Case V6 PASSED: collection block lifted after confirmed sale ✅\n');

  process.env.BOT_MODE = prevMode;
  console.log('================================================================');
  console.log('All Veil incident regression tests passed successfully!');
  console.log('================================================================');
})().catch((e) => {
  console.error('Test Failed:', e);
  process.exit(1);
});
