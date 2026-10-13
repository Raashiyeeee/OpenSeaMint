import assert from 'assert';
import { Wallet } from 'ethers';
import {
  OpenSeaRateLimiter,
  scheduleWithRetry,
  parseRetryAfterMs,
  backoffDelayMs,
  isRetryableError,
  getGlobalOpenSeaLimiter,
  TtlCache
} from '../src/utils/OpenSeaRateLimiter';
import { OpenSeaApiService } from '../src/services/OpenSeaApiService';
import { PricingEngine } from '../src/services/PricingEngine';
import { InventoryManager } from '../src/services/InventoryManager';
import { SeaportService } from '../src/services/SeaportService';
import { CircuitBreaker } from '../src/security/CircuitBreaker';
import { CollectionBidderStrategy } from '../src/strategies/CollectionBidderStrategy';
import { loadConfig } from '../src/config/schema';

/**
 * OpenSea rate limiting, retry/backoff, caching, staged fetching and "data unavailable" handling.
 * All network access is stubbed. Nothing touches live markets.
 */
const baseConfig = loadConfig();
const ZERO = '0x0000000000000000000000000000000000000000';
const err = (status: number, headers: any = {}) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers } });

(async () => {
  console.log('================================================================');
  console.log('Running OpenSea Rate Limit / Retry / Cache Tests');
  console.log('================================================================\n');

  // L1. Defaults are conservative
  assert.strictEqual(baseConfig.opensea?.requestsPerSecond, 3);
  assert.strictEqual(baseConfig.opensea?.maxConcurrent, 2);
  assert(baseConfig.opensea!.maxRetries! > 0 && baseConfig.opensea!.maxRetries! <= 10);
  console.log('Case L1 PASSED: default 3 req/s, 2 concurrent, capped retries ✅');

  // L2. Rate spacing + concurrency cap
  const limiter = new OpenSeaRateLimiter({ requestsPerSecond: 20, maxConcurrent: 2 });
  let inFlight = 0;
  let maxInFlight = 0;
  const starts: number[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limiter.schedule(async () => {
        starts.push(Date.now());
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 120));
        inFlight--;
      })
    )
  );
  assert(maxInFlight <= 2, `Concurrency cap exceeded (${maxInFlight})`);
  starts.sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) assert(starts[i] - starts[i - 1] >= 45, `Requests must be spaced ~50ms apart at 20 rps (got ${starts[i] - starts[i - 1]})`);
  assert(Date.now() - t0 >= 250);
  console.log('Case L2 PASSED: request starts spaced by 1/rate, in-flight capped ✅');

  // L3. Retry-After parsing, backoff with jitter, retryable classification
  assert.strictEqual(parseRetryAfterMs('3'), 3000);
  assert.strictEqual(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.strictEqual(parseRetryAfterMs(undefined), undefined);
  const opts = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000 };
  assert.strictEqual(backoffDelayMs(0, opts, () => 0), 500);
  assert.strictEqual(backoffDelayMs(2, opts, () => 1), 4000);
  assert.strictEqual(backoffDelayMs(10, opts, () => 1), 8000, 'Backoff capped at maxDelayMs');
  assert(isRetryableError(err(429)) && isRetryableError(err(503)) && !isRetryableError(err(404)) && !isRetryableError(err(400)));
  console.log('Case L3 PASSED: Retry-After (seconds & HTTP date), exponential backoff + jitter, 429/5xx retryable, 4xx not ✅');

  // L4. scheduleWithRetry honours Retry-After, retries 429 then succeeds; caps attempts; no retry on 404
  const fast = new OpenSeaRateLimiter({ requestsPerSecond: 1000, maxConcurrent: 2 });
  const slept: number[] = [];
  const fakeSleep = async (ms: number) => { slept.push(ms); };
  let calls = 0;
  const ok = await scheduleWithRetry(fast, async () => { calls++; if (calls <= 2) throw err(429, { 'retry-after': '2' }); return 'ok'; }, opts, 't', fakeSleep, () => 0);
  assert.strictEqual(ok, 'ok');
  assert.strictEqual(calls, 3);
  assert(slept.every((d) => d >= 2000), `Retry-After 2s honoured (${slept})`);
  calls = 0;
  await assert.rejects(scheduleWithRetry(fast, async () => { calls++; throw err(502); }, opts, 't', async () => undefined, () => 0));
  assert.strictEqual(calls, opts.maxRetries + 1, 'Retries capped at maxRetries');
  calls = 0;
  await assert.rejects(scheduleWithRetry(fast, async () => { calls++; throw err(404); }, opts, 't', async () => undefined));
  assert.strictEqual(calls, 1, '404 is not retried');
  // A 429 pauses the shared limiter for every caller
  const pausing = new OpenSeaRateLimiter({ requestsPerSecond: 1000, maxConcurrent: 2 });
  pausing.pauseUntil(Date.now() + 150);
  const p0 = Date.now();
  await pausing.schedule(async () => undefined);
  assert(Date.now() - p0 >= 130, 'Paused limiter delays other requests');
  console.log('Case L4 PASSED: 429 retried with Retry-After, retries capped, 404 not retried, 429 pauses all callers ✅');

  // L5. Every OpenSea call goes through ONE shared limiter and sends x-api-key
  const prevKey = process.env.OPENSEA_API_KEY;
  process.env.OPENSEA_API_KEY = 'test-key-123';
  const cfg: any = { ...baseConfig, opensea: { ...baseConfig.opensea, requestsPerSecond: 1000, maxRetries: 2, baseRetryDelayMs: 5, maxRetryDelayMs: 20 } };
  const a1 = new OpenSeaApiService(cfg);
  const a2 = new OpenSeaApiService(cfg);
  assert.strictEqual((a1 as any).limiter, (a2 as any).limiter, 'Limiter is shared across service instances');
  assert.strictEqual((a1 as any).limiter, getGlobalOpenSeaLimiter());
  const seenHeaders: any[] = [];
  let httpCalls = 0;
  (a1 as any).http = {
    get: async (_url: string, c: any) => { httpCalls++; seenHeaders.push(c?.headers); if (httpCalls === 1) throw err(429, { 'retry-after': '0' }); return { data: { ok: true } }; },
    post: async (_url: string, _d: any, c: any) => { seenHeaders.push(c?.headers); return { data: {} }; }
  };
  const r = await a1.client.get('/collections/x');
  assert.deepStrictEqual(r.data, { ok: true });
  assert.strictEqual(httpCalls, 2, 'Service client retries a 429');
  await a1.client.post('/offers', {});
  await a1.client.get('/x', { headers: { 'Cache-Control': 'no-cache' } });
  assert(seenHeaders.length === 4 && seenHeaders.every((h) => h?.['x-api-key'] === 'test-key-123'), 'x-api-key sent on every GET/POST incl. retries');
  assert.strictEqual(seenHeaders[3]['Cache-Control'], 'no-cache', 'Per-call headers preserved');
  process.env.OPENSEA_API_KEY = prevKey;
  if (prevKey === undefined) delete process.env.OPENSEA_API_KEY;
  console.log('Case L5 PASSED: shared global limiter, retry inside service client, x-api-key on every call ✅');

  // L6. Staged fetching + caching + data unavailable
  const requests: string[] = [];
  let collection: any = { total_supply: 1000, fees: [{ recipient: '0x0000a26b00c1f0df003000390027140000faa719', fee: 1, required: true }] };
  let eventsFail = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const sale = (i: number) => ({
    event_type: 'sale', event_timestamp: nowSec - 60 * i, payment: { symbol: 'ETH', quantity: '2000000000000000', decimals: 18, token_address: ZERO },
    buyer: `0xb${i}`, seller: `0xs${i}`
  });
  const api = new OpenSeaApiService(cfg);
  (api as any).getEthPriceUsd = async () => 2700;
  (api as any).getDropSupply = async () => ({ totalSupply: 1000, maxSupply: 1000, isMinting: false });
  (api as any).readOnChainSupply = async () => ({});
  (api as any).client = {
    get: async (url: string) => {
      requests.push(url);
      if (url.startsWith('/collections/') && url.endsWith('/stats')) return { data: { total: { floor_price: 0.002, floor_price_symbol: 'ETH' } } };
      if (url.startsWith('/collections/')) return { data: collection };
      if (url.startsWith('/offers/')) return { data: { offers: [] } };
      if (url.startsWith('/events/')) { if (eventsFail) throw err(429); return { data: { asset_events: Array.from({ length: 12 }, (_, i) => sale(i + 1)) } }; }
      return { data: {} };
    }
  };
  const count = (p: string) => requests.filter((u) => u.startsWith(p)).length;
  const md1 = await api.getCollectionMarketData('stage-col', ZERO, 'robinhood');
  assert.strictEqual(md1.dataUnavailable, undefined);
  assert.strictEqual(md1.sales3Hours, 12);
  assert.strictEqual(md1.mintCompleted, true);
  const before = requests.length;
  const md2 = await api.getCollectionMarketData('stage-col', ZERO, 'robinhood');
  assert.strictEqual(md2.sales3Hours, 12);
  assert.strictEqual(requests.length, before, 'Second cycle within TTLs makes zero OpenSea requests');
  console.log('Case L6a PASSED: collection/fees, stats, offers and sales events cached between cycles ✅');

  // Mint incomplete -> rejected before stats/offers/events are fetched
  const api2 = new OpenSeaApiService(cfg);
  (api2 as any).getEthPriceUsd = async () => 2700;
  (api2 as any).getDropSupply = async () => ({ totalSupply: 500, maxSupply: 1000, isMinting: true });
  (api2 as any).readOnChainSupply = async () => ({});
  (api2 as any).client = (api as any).client;
  requests.length = 0;
  const mdMint = await api2.getCollectionMarketData('minting-col', ZERO, 'robinhood');
  assert.strictEqual(mdMint.mintCompleted, false);
  assert(mdMint.earlyRejectReason, 'Early rejection reason set');
  assert.strictEqual(count('/events/') + count('/offers/') + requests.filter((u) => u.endsWith('/stats')).length, 0, 'No stats/offers/events fetched for unminted collection');
  // Drops API rate limited and on-chain unknown -> SKIPPED, not a rejection
  (api2 as any).getDropSupply = async () => ({ unavailable: true });
  api2.clearCaches();
  const mdDrop = await api2.getCollectionMarketData('minting-col', ZERO, 'robinhood');
  assert.strictEqual(mdDrop.dataUnavailable, true);
  assert.strictEqual(mdDrop.mintDemandPassed, false);
  // Mandatory creator fee over ceiling -> rejected before events
  const api3 = new OpenSeaApiService(cfg);
  (api3 as any).getEthPriceUsd = async () => 2700;
  (api3 as any).getDropSupply = async () => ({ totalSupply: 1000, maxSupply: 1000, isMinting: false });
  (api3 as any).readOnChainSupply = async () => ({});
  (api3 as any).client = (api as any).client;
  collection = { total_supply: 1000, fees: [{ recipient: '0x1234567890123456789012345678901234567890', fee: 50, required: true }] };
  requests.length = 0;
  const mdFee = await api3.getCollectionMarketData('fee-col', ZERO, 'robinhood');
  assert(mdFee.earlyRejectReason && /creator fee/.test(mdFee.earlyRejectReason));
  assert.strictEqual(count('/events/'), 0, 'No events fetched when creator fee already rejects');
  console.log('Case L6b PASSED: cheap checks (mint-out, creator fee) run before expensive sales fetch ✅');

  // Events 429 after retries -> SKIPPED (data unavailable), never 0/10
  collection = { total_supply: 1000, fees: [{ recipient: '0x0000a26b00c1f0df003000390027140000faa719', fee: 1, required: true }] };
  eventsFail = true;
  api.clearCaches();
  const mdFail = await api.getCollectionMarketData('stage-col', ZERO, 'robinhood');
  assert.strictEqual(mdFail.dataUnavailable, true);
  assert(/SKIPPED \(data unavailable, will retry\)/.test(mdFail.dataUnavailableReason!));
  assert(!/0\/10/.test(mdFail.liquidityReason || ''), 'No 0/10 rejection message');
  assert.strictEqual(mdFail.liquidityPassed, false, 'Still never passes liquidity');
  // failure is not cached: next cycle refetches events
  eventsFail = false;
  const evBefore = count('/events/');
  const mdRecovered = await api.getCollectionMarketData('stage-col', ZERO, 'robinhood');
  assert.strictEqual(mdRecovered.sales3Hours, 12);
  assert(count('/events/') > evBefore, 'Failed fetch not cached');
  // Stats 429 -> SKIPPED (no fake fallback floor)
  const api4 = new OpenSeaApiService(cfg);
  (api4 as any).getEthPriceUsd = async () => 2700;
  (api4 as any).getDropSupply = async () => ({ totalSupply: 1000, maxSupply: 1000 });
  (api4 as any).readOnChainSupply = async () => ({});
  (api4 as any).client = { get: async (url: string) => { if (url.endsWith('/stats')) throw err(429); return (api as any).client.get(url); } };
  const mdStats = await api4.getCollectionMarketData('stage-col', ZERO, 'robinhood');
  assert.strictEqual(mdStats.dataUnavailable, true);
  assert.strictEqual(mdStats.floorPriceEth, 0, 'No fabricated fallback floor');
  console.log('Case L6c PASSED: 429 on sales/stats -> SKIPPED (data unavailable, will retry), not cached, never offers ✅');

  // L7. Strategy: SKIPPED collections never offer
  const pe = new PricingEngine(cfg);
  const inv = new InventoryManager(cfg);
  const seaport = new SeaportService(cfg, Wallet.createRandom());
  (seaport as any).getWethBalance = async () => 1.0;
  let signed = 0;
  (seaport as any).createSignedCollectionOffer = async () => { signed++; return { orderComponents: {}, signature: '0x' }; };
  const sApi = new OpenSeaApiService(cfg);
  let posted = 0;
  (sApi as any).postCollectionOffer = async () => { posted++; return {}; };
  (sApi as any).getCollectionMarketData = async () => mdFail;
  const bidder = new CollectionBidderStrategy(cfg, sApi, pe, seaport, inv, new CircuitBreaker(cfg));
  assert.strictEqual(bidder.skipOrEarlyReject(mdFail, 'stage-col', 'robinhood'), true);
  await (bidder as any).processCollectionBid({ slug: 'stage-col', contractAddress: ZERO, enabled: true, maxInventory: 5 }, 'robinhood');
  const fv = await bidder.finalPreOfferValidation({ collectionSlug: 'stage-col', contractAddress: ZERO, networkKey: 'robinhood', bidPriceEth: 0.001 });
  assert.strictEqual(fv.passed, false);
  assert(/SKIPPED/.test(fv.reason));
  assert.strictEqual(signed + posted, 0, 'No offer signed or posted when data is unavailable');
  console.log('Case L7 PASSED: strategy logs SKIPPED and never signs/posts an offer on unavailable data ✅');

  // L8. TTL cache expiry
  let now = 0;
  const cache = new TtlCache<number>(() => now);
  cache.set('k', 1, 100);
  assert.strictEqual(cache.get('k'), 1);
  now = 100;
  assert.strictEqual(cache.get('k'), undefined);
  console.log('Case L8 PASSED: TTL cache expiry ✅\n');

  console.log('================================================================');
  console.log('All OpenSea rate limit tests passed successfully!');
  console.log('================================================================');
})().catch((e) => {
  console.error('Test Failed:', e);
  process.exit(1);
});
