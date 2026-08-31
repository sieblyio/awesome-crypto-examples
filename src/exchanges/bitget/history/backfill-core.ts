/**
 * Educational helpers for a Bitget historical-candle backfill.
 *
 * Bitget's public history-candle endpoints limit each query to a 90-day
 * window, return a small page of rows, and apply a per-IP request budget.
 * These functions demonstrate windowing, paging, dedupe, gap reports,
 * throttling, and bounded retries. They are a demonstration, not a
 * recommended production ingestion framework.
 */

export const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_PAGE_LIMIT = 100;
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 150;
export const DEFAULT_MAX_RETRIES = 6;

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1H': 3_600_000,
  '2H': 7_200_000,
  '4H': 14_400_000,
  '6H': 21_600_000,
  '12H': 43_200_000,
  '1D': 86_400_000,
  '3D': 259_200_000,
  '1W': 604_800_000,
};

export interface Candle {
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume: string;
  quoteVolume: string;
}

export interface TimeWindow {
  startTime: number;
  endTime: number;
}

export interface CandlePageRequest {
  symbol: string;
  productType: string;
  interval: string;
  startTime: number;
  endTime: number;
  limit: number;
}

export interface CandleSource {
  fetchPage(request: CandlePageRequest): Promise<Candle[]>;
}

export interface BackfillConfig {
  symbol: string;
  productType: string;
  interval: string;
  startTime: number;
  endTime: number;
  limit: number;
  minRequestIntervalMs: number;
  maxRetries: number;
}

export interface Gap {
  from: number;
  to: number;
  missingIntervals: number;
}

export interface BackfillStats {
  requests: number;
  retries: number;
  records: number;
  duplicatesDropped: number;
  gaps: Gap[];
}

export function intervalToMs(interval: string): number {
  const ms = INTERVAL_MS[interval];
  if (!ms) {
    throw new Error(
      `Unsupported interval "${interval}". Expected one of: ${Object.keys(
        INTERVAL_MS,
      ).join(', ')}`,
    );
  }
  return ms;
}

export function parseTime(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Could not parse time: ${value}`);
  }
  return parsed;
}

export function splitWindows(
  startTime: number,
  endTime: number,
  maxWindowMs = MAX_WINDOW_MS,
): TimeWindow[] {
  if (!(endTime > startTime)) {
    throw new Error('endTime must be greater than startTime');
  }
  const windows: TimeWindow[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const windowEnd = Math.min(cursor + maxWindowMs, endTime);
    windows.push({ startTime: cursor, endTime: windowEnd });
    cursor = windowEnd;
  }
  return windows;
}

export function parseCandleRow(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 7) {
    throw new Error(
      'Candle row must be [ts, open, high, low, close, volume, turnover]',
    );
  }
  const ts = Number(row[0]);
  if (!Number.isFinite(ts)) {
    throw new Error(`Invalid candle timestamp: ${String(row[0])}`);
  }
  return {
    ts,
    open: String(row[1]),
    high: String(row[2]),
    low: String(row[3]),
    close: String(row[4]),
    baseVolume: String(row[5]),
    quoteVolume: String(row[6]),
  };
}

export function mergeCandles(
  existing: Candle[],
  incoming: Candle[],
): { candles: Candle[]; duplicatesDropped: number } {
  const byTs = new Map<number, Candle>();
  for (const candle of existing) {
    byTs.set(candle.ts, candle);
  }
  let duplicatesDropped = 0;
  for (const candle of incoming) {
    if (byTs.has(candle.ts)) {
      duplicatesDropped += 1;
      continue;
    }
    byTs.set(candle.ts, candle);
  }
  const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return { candles, duplicatesDropped };
}

export function findGaps(
  candles: Candle[],
  startTime: number,
  endTime: number,
  intervalMs: number,
): Gap[] {
  const present = new Set(candles.map((c) => c.ts));
  const gaps: Gap[] = [];
  let missingStart: number | null = null;
  let missingCount = 0;

  const firstSlot = startTime - (startTime % intervalMs);
  for (let ts = firstSlot; ts < endTime; ts += intervalMs) {
    if (ts < startTime) {
      continue;
    }
    if (present.has(ts)) {
      if (missingStart !== null) {
        gaps.push({
          from: missingStart,
          to: ts - intervalMs,
          missingIntervals: missingCount,
        });
        missingStart = null;
        missingCount = 0;
      }
      continue;
    }
    if (missingStart === null) {
      missingStart = ts;
    }
    missingCount += 1;
  }
  if (missingStart !== null) {
    gaps.push({
      from: missingStart,
      to: endTime - intervalMs,
      missingIntervals: missingCount,
    });
  }
  return gaps;
}

export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const rec = err as {
    code?: unknown;
    message?: unknown;
    body?: { code?: unknown };
  };
  const code = rec.code ?? rec.body?.code;
  const numeric = Number(code);
  if (
    numeric === 429 ||
    numeric === 500 ||
    numeric === 502 ||
    numeric === 503 ||
    numeric === 504
  ) {
    return true;
  }
  const asString = String(code ?? '');
  if (asString === '429' || asString === '40018') {
    return true;
  }
  const message = String(rec.message ?? '');
  return /too many requests|rate limit|timeout|econnreset|etimedout/i.test(
    message,
  );
}

export function retryDelayMs(
  attempt: number,
  random = Math.random,
  baseMs = 500,
  capMs = 15_000,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = 0.5 + random() * 0.5;
  return Math.floor(exp * jitter);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RequestRateLimiter {
  private nextAllowedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(
    now = Date.now(),
    waitFn: (ms: number) => Promise<void> = sleep,
  ): Promise<void> {
    const delay = this.nextAllowedAt - now;
    if (delay > 0) {
      await waitFn(delay);
    }
    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }
}

export async function fetchPageWithRetry(
  source: CandleSource,
  request: CandlePageRequest,
  options: {
    maxRetries: number;
    limiter: RequestRateLimiter;
    sleepFn?: (ms: number) => Promise<void>;
    random?: () => number;
    onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  },
): Promise<{ candles: Candle[]; retries: number }> {
  const sleepFn = options.sleepFn ?? sleep;
  const random = options.random ?? Math.random;
  let retries = 0;
  let attempt = 0;
  for (;;) {
    await options.limiter.wait(Date.now(), sleepFn);
    try {
      const candles = await source.fetchPage(request);
      return { candles, retries };
    } catch (err) {
      if (!isRetryableError(err) || attempt >= options.maxRetries) {
        throw err;
      }
      const delayMs = retryDelayMs(attempt, random);
      options.onRetry?.(attempt, err, delayMs);
      retries += 1;
      attempt += 1;
      await sleepFn(delayMs);
    }
  }
}

/**
 * Walk each 90-day window from newest to oldest, paging while a full
 * page is returned. Bitget typically answers newest-first; we always
 * sort locally and continue from the oldest timestamp minus 1ms.
 */
export async function backfillRange(options: {
  config: BackfillConfig;
  source: CandleSource;
  existing?: Candle[];
  nextEndTime?: number;
  onPage?: (page: {
    window: TimeWindow;
    candles: Candle[];
    nextEndTime: number;
    stats: BackfillStats;
  }) => Promise<void> | void;
}): Promise<{ candles: Candle[]; stats: BackfillStats; nextEndTime: number }> {
  const { config, source } = options;
  const intervalMs = intervalToMs(config.interval);
  const limiter = new RequestRateLimiter(config.minRequestIntervalMs);
  let merged = options.existing ? [...options.existing] : [];
  let duplicatesDropped = 0;
  let requests = 0;
  let retries = 0;

  const windows = splitWindows(config.startTime, config.endTime).reverse();
  let cursorEnd = options.nextEndTime ?? config.endTime;

  for (const window of windows) {
    if (cursorEnd <= window.startTime) {
      continue;
    }
    const windowEnd = Math.min(cursorEnd, window.endTime);
    let pageEnd = windowEnd;

    while (pageEnd > window.startTime) {
      const fetched = await fetchPageWithRetry(
        source,
        {
          symbol: config.symbol,
          productType: config.productType,
          interval: config.interval,
          startTime: window.startTime,
          endTime: pageEnd,
          limit: config.limit,
        },
        { maxRetries: config.maxRetries, limiter },
      );
      requests += 1;
      retries += fetched.retries;

      const inRange = fetched.candles.filter(
        (c) => c.ts >= config.startTime && c.ts < config.endTime,
      );
      const result = mergeCandles(merged, inRange);
      duplicatesDropped += result.duplicatesDropped;
      merged = result.candles;

      const oldest =
        inRange.length === 0
          ? undefined
          : inRange.reduce(
              (min, c) => (c.ts < min ? c.ts : min),
              inRange[0].ts,
            );

      if (
        inRange.length === 0 ||
        inRange.length < config.limit ||
        oldest === undefined
      ) {
        cursorEnd = window.startTime;
        await options.onPage?.({
          window,
          candles: merged,
          nextEndTime: cursorEnd,
          stats: pendingStats(),
        });
        break;
      }

      cursorEnd = oldest - 1;
      pageEnd = cursorEnd;
      await options.onPage?.({
        window,
        candles: merged,
        nextEndTime: cursorEnd,
        stats: pendingStats(),
      });
    }
  }

  function pendingStats(): BackfillStats {
    return {
      requests,
      retries,
      records: merged.length,
      duplicatesDropped,
      gaps: findGaps(merged, config.startTime, config.endTime, intervalMs),
    };
  }

  return {
    candles: merged,
    stats: pendingStats(),
    nextEndTime: cursorEnd,
  };
}
