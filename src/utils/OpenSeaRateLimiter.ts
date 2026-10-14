import { AsyncLocalStorage } from 'async_hooks';
import { logger } from './logger';

/** Requests made inside runHighPriority() jump ahead of queued normal-priority requests (e.g. instant listing). */
const priorityContext = new AsyncLocalStorage<boolean>();
export function runHighPriority<T>(fn: () => Promise<T>): Promise<T> {
  return priorityContext.run(true, fn);
}
export function isHighPriority(): boolean {
  return priorityContext.getStore() === true;
}

export interface RateLimiterOptions {
  requestsPerSecond: number;
  maxConcurrent: number;
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Global OpenSea request limiter: spaces request STARTS at >= 1000/rps ms apart and caps in-flight requests.
 * A 429 Retry-After pauses the whole limiter (every caller), not just the request that got it.
 */
export class OpenSeaRateLimiter {
  private nextStartAt = 0;
  private pausedUntil = 0;
  private active = 0;
  private waiters: Array<() => void> = [];
  private priorityWaiters: Array<() => void> = [];

  constructor(public options: RateLimiterOptions, private sleep: SleepFn = defaultSleep, private now: () => number = Date.now) {}

  public configure(options: Partial<RateLimiterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  public get inFlight(): number {
    return this.active;
  }

  /** Pause all requests until `untilMs` (used for Retry-After). */
  public pauseUntil(untilMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, untilMs);
  }

  private async acquireSlot(): Promise<void> {
    while (this.active >= Math.max(1, this.options.maxConcurrent)) {
      const high = isHighPriority();
      await new Promise<void>((resolve) => (high ? this.priorityWaiters : this.waiters).push(resolve));
    }
    this.active++;
    const interval = 1000 / Math.max(0.01, this.options.requestsPerSecond);
    const start = Math.max(this.now(), this.nextStartAt, this.pausedUntil);
    this.nextStartAt = start + interval;
    const wait = start - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private release(): void {
    this.active--;
    const next = this.priorityWaiters.shift() || this.waiters.shift();
    if (next) next();
  }

  public async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Parses Retry-After (delta-seconds or HTTP-date) into milliseconds; undefined when absent/invalid. */
export function parseRetryAfterMs(value: any, now: number = Date.now()): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(String(value));
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export function isRetryableError(err: any): boolean {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  // Network-level failures (timeout / reset) without an HTTP response
  return !err?.response && ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_NETWORK'].includes(err?.code);
}

/** Exponential backoff with full jitter: random in [delay/2, delay], delay = min(max, base * 2^attempt). */
export function backoffDelayMs(attempt: number, opts: RetryOptions, random: () => number = Math.random): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(2, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * Runs `fn` through the limiter; on 429/5xx/network errors retries up to maxRetries with exponential backoff + jitter,
 * honouring Retry-After (which also pauses the shared limiter). Non-retryable errors (e.g. 404) throw immediately.
 */
export async function scheduleWithRetry<T>(
  limiter: OpenSeaRateLimiter,
  fn: () => Promise<T>,
  opts: RetryOptions,
  label: string = 'opensea',
  sleep: SleepFn = defaultSleep,
  random: () => number = Math.random
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await limiter.schedule(fn);
    } catch (err: any) {
      if (!isRetryableError(err) || attempt >= opts.maxRetries) throw err;
      const retryAfter = parseRetryAfterMs(err?.response?.headers?.['retry-after']);
      const delay = Math.min(opts.maxDelayMs, Math.max(retryAfter ?? 0, backoffDelayMs(attempt, opts, random)));
      if (err?.response?.status === 429) limiter.pauseUntil(Date.now() + delay);
      logger.debug({ label, status: err?.response?.status, attempt: attempt + 1, delayMs: delay }, 'OpenSea request retry scheduled');
      await sleep(delay);
    }
  }
}

let globalLimiter: OpenSeaRateLimiter | undefined;

/** Process-wide shared limiter (all OpenSeaApiService instances share it). */
export function getGlobalOpenSeaLimiter(options?: Partial<RateLimiterOptions>): OpenSeaRateLimiter {
  if (!globalLimiter) {
    globalLimiter = new OpenSeaRateLimiter({ requestsPerSecond: 3, maxConcurrent: 2, ...options });
  } else if (options) {
    globalLimiter.configure(options);
  }
  return globalLimiter;
}

/** Simple TTL cache (successful results only). */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();
  constructor(private now: () => number = Date.now) {}
  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs > 0) this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  delete(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}
