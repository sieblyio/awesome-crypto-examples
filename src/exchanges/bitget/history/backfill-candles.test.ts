/**
 * Fixture-backed checks for paging, overlap dedupe, retries, and gaps.
 *
 *   npx ts-node src/exchanges/bitget/history/backfill-candles.test.ts
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  backfillRange,
  Candle,
  CandleSource,
  fetchPageWithRetry,
  findGaps,
  isRetryableError,
  MAX_WINDOW_MS,
  mergeCandles,
  parseCandleRow,
  RequestRateLimiter,
  splitWindows,
} from './backfill-core';

const fixtureDir = path.join(__dirname, 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function candlesFromFixture(name: string): Candle[] {
  const body = loadFixture(name) as { data: unknown[] };
  return body.data.map(parseCandleRow);
}

class ScriptedSource implements CandleSource {
  public calls: Array<{ startTime: number; endTime: number }> = [];
  constructor(private readonly pages: Array<Candle[] | Error>) {}

  fetchPage(request: {
    startTime: number;
    endTime: number;
  }): Promise<Candle[]> {
    this.calls.push({ startTime: request.startTime, endTime: request.endTime });
    const next = this.pages.shift();
    if (!next) {
      const empty: Candle[] = [];
      return Promise.resolve(empty);
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  }
}

function rateLimitError(): Error {
  const body = loadFixture('rate-limit-error.json') as {
    code: number;
    message: string;
  };
  const err = new Error(body.message);
  (err as { code?: number }).code = body.code;
  return err;
}

async function run(): Promise<void> {
  const page1 = candlesFromFixture('page-1.json');
  const page2 = candlesFromFixture('page-2-overlap.json');

  // Windowing respects the 90-day API bound.
  const start = Date.parse('2024-01-01T00:00:00Z');
  const end = Date.parse('2024-07-01T00:00:00Z');
  const windows = splitWindows(start, end);
  assert.strictEqual(windows.length, 3);
  assert.ok(windows.every((w) => w.endTime - w.startTime <= MAX_WINDOW_MS));
  assert.strictEqual(windows[0].startTime, start);
  assert.strictEqual(windows[windows.length - 1].endTime, end);

  // Overlapping pages keep one row per timestamp, sorted.
  const merged = mergeCandles(page1, page2);
  assert.strictEqual(merged.duplicatesDropped, 1);
  assert.strictEqual(merged.candles.length, 5);
  assert.deepStrictEqual(
    merged.candles.map((c) => c.ts),
    [...merged.candles.map((c) => c.ts)].sort((a, b) => a - b),
  );

  // Rate-limit payload is retryable; a 400 is not.
  assert.strictEqual(isRetryableError(rateLimitError()), true);
  const bad = new Error('invalid symbol');
  (bad as { code?: number }).code = 400;
  assert.strictEqual(isRetryableError(bad), false);

  // fetchPageWithRetry recovers after a 429.
  const retrySource = new ScriptedSource([rateLimitError(), page1]);
  const retried = await fetchPageWithRetry(
    retrySource,
    {
      symbol: 'BTCUSDT',
      productType: 'USDT-FUTURES',
      interval: '1H',
      startTime: start,
      endTime: start + 3_600_000,
      limit: 100,
    },
    {
      maxRetries: 3,
      limiter: new RequestRateLimiter(0),
      sleepFn: () => Promise.resolve(),
      random: () => 0,
    },
  );
  assert.strictEqual(retried.retries, 1);
  assert.strictEqual(retried.candles.length, 3);

  // Full-page responses continue paging newest-first; overlap is dropped.
  const hour = 3_600_000;
  const rangeStart = 1_704_067_200_000;
  const rangeEnd = rangeStart + hour * 6;
  const fullPageSource = new ScriptedSource([page2, page1, []]);
  const result = await backfillRange({
    config: {
      symbol: 'BTCUSDT',
      productType: 'USDT-FUTURES',
      interval: '1H',
      startTime: rangeStart,
      endTime: rangeEnd,
      limit: 3,
      minRequestIntervalMs: 0,
      maxRetries: 2,
    },
    source: fullPageSource,
  });

  assert.ok(fullPageSource.calls.length >= 2);
  assert.strictEqual(result.stats.duplicatesDropped, 1);
  assert.strictEqual(result.candles.length, 5);
  const gaps = findGaps(result.candles, rangeStart, rangeEnd, hour);
  assert.ok(gaps.some((g) => g.missingIntervals >= 1));

  console.log('backfill-candles fixture checks passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
