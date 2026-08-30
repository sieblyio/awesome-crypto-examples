/**
 * Resumable Bitget historical candle backfill.
 *
 * Uses the public V2 mix history-candles endpoint through the repository's
 * current `bitget-api` RestClientV2. No API keys are required.
 *
 * Example:
 *   npx ts-node src/exchanges/bitget/history/backfill-candles.ts \
 *     --symbol BTCUSDT \
 *     --productType USDT-FUTURES \
 *     --interval 1H \
 *     --start 2024-01-01T00:00:00Z \
 *     --end 2024-01-08T00:00:00Z \
 *     --output ./btc-1h.jsonl
 *
 * Demonstration only — not a general ingestion framework.
 */

import { RestClientV2 } from 'bitget-api';
import * as path from 'path';
import {
  BackfillConfig,
  backfillRange,
  Candle,
  CandleSource,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_PAGE_LIMIT,
  parseCandleRow,
  parseTime,
} from './backfill-core';
import {
  Checkpoint,
  readCheckpoint,
  readExistingCandles,
  writeCheckpoint,
  writeOutput,
} from './backfill-state';

class BitgetHistoricCandleSource implements CandleSource {
  constructor(private readonly client: RestClientV2) {}

  async fetchPage(request: {
    symbol: string;
    productType: string;
    interval: string;
    startTime: number;
    endTime: number;
    limit: number;
  }): Promise<Candle[]> {
    const response = await this.client.getFuturesHistoricCandles({
      symbol: request.symbol,
      productType: request.productType as
        | 'USDT-FUTURES'
        | 'COIN-FUTURES'
        | 'USDC-FUTURES'
        | 'SUSDT-FUTURES'
        | 'SCOIN-FUTURES'
        | 'SUSDC-FUTURES',
      granularity: request.interval as
        | '1m'
        | '3m'
        | '5m'
        | '15m'
        | '30m'
        | '1H'
        | '2H'
        | '4H'
        | '6H'
        | '12H'
        | '1D'
        | '3D'
        | '1W'
        | '1M',
      startTime: String(request.startTime),
      endTime: String(request.endTime),
      limit: String(request.limit),
    });

    if (response.code !== '00000') {
      const err = new Error(response.msg || 'Bitget history-candles error');
      (err as { code?: string }).code = response.code;
      throw err;
    }

    const rows = (response.data ?? []) as unknown[];
    return rows.map(parseCandleRow);
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (
    idx >= 0 &&
    process.argv[idx + 1] &&
    !process.argv[idx + 1].startsWith('--')
  ) {
    return process.argv[idx + 1];
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing required argument --${name}`);
}

function printUsage(): void {
  console.log(`Usage:
  npx ts-node src/exchanges/bitget/history/backfill-candles.ts \\
    --symbol BTCUSDT \\
    --productType USDT-FUTURES \\
    --interval 1H \\
    --start 2024-01-01T00:00:00Z \\
    --end 2024-01-08T00:00:00Z \\
    --output ./btc-1h.jsonl

Options:
  --format jsonl|csv     Output format (default jsonl)
  --checkpoint PATH      Checkpoint file (default <output>.checkpoint.json)
  --limit N              Rows per request (default ${DEFAULT_PAGE_LIMIT}, max 100)
  --help
`);
}

export async function runCli(argv = process.argv): Promise<void> {
  if (argv.includes('--help')) {
    printUsage();
    return;
  }

  const outputPath = path.resolve(arg('output'));
  const format = arg('format', 'jsonl');
  if (format !== 'jsonl' && format !== 'csv') {
    throw new Error('--format must be jsonl or csv');
  }
  const checkpointPath = path.resolve(
    arg('checkpoint', `${outputPath}.checkpoint.json`),
  );

  const config: BackfillConfig = {
    symbol: arg('symbol'),
    productType: arg('productType', 'USDT-FUTURES'),
    interval: arg('interval', '1H'),
    startTime: parseTime(arg('start')),
    endTime: parseTime(arg('end')),
    limit: Math.min(
      DEFAULT_PAGE_LIMIT,
      Number(arg('limit', String(DEFAULT_PAGE_LIMIT))),
    ),
    minRequestIntervalMs: DEFAULT_MIN_REQUEST_INTERVAL_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
  };

  const previous = await readCheckpoint(checkpointPath);
  const resume =
    previous &&
    previous.symbol === config.symbol &&
    previous.productType === config.productType &&
    previous.interval === config.interval &&
    previous.rangeStart === config.startTime &&
    previous.rangeEnd === config.endTime
      ? previous
      : null;

  if (previous && !resume) {
    console.warn(
      'Ignoring checkpoint because the request identity does not match.',
    );
  }

  const existing = await readExistingCandles(outputPath, format);
  const source = new BitgetHistoricCandleSource(new RestClientV2());

  console.log(
    resume
      ? `Resuming from checkpoint nextEndTime=${new Date(
          resume.nextEndTime,
        ).toISOString()}`
      : `Starting backfill ${config.symbol} ${config.interval} ${new Date(
          config.startTime,
        ).toISOString()} -> ${new Date(config.endTime).toISOString()}`,
  );

  const { candles, stats, nextEndTime } = await backfillRange({
    config,
    source,
    existing,
    nextEndTime: resume?.nextEndTime,
    onPage: async ({
      nextEndTime: cursor,
      candles: soFar,
      stats: pageStats,
    }) => {
      const checkpoint: Checkpoint = {
        symbol: config.symbol,
        productType: config.productType,
        interval: config.interval,
        rangeStart: config.startTime,
        rangeEnd: config.endTime,
        nextEndTime: cursor,
        outputPath,
        records: soFar.length,
        updatedAt: new Date().toISOString(),
      };
      await writeCheckpoint(checkpointPath, checkpoint);
      await writeOutput(outputPath, soFar, format);
      console.log(
        `checkpoint records=${pageStats.records} requests=${
          pageStats.requests
        } retries=${pageStats.retries} nextEnd=${new Date(
          cursor,
        ).toISOString()}`,
      );
    },
  });

  await writeOutput(outputPath, candles, format);
  const done: Checkpoint = {
    symbol: config.symbol,
    productType: config.productType,
    interval: config.interval,
    rangeStart: config.startTime,
    rangeEnd: config.endTime,
    nextEndTime,
    outputPath,
    records: candles.length,
    updatedAt: new Date().toISOString(),
  };
  await writeCheckpoint(checkpointPath, done);

  console.log(
    JSON.stringify(
      {
        output: outputPath,
        records: stats.records,
        requests: stats.requests,
        retries: stats.retries,
        duplicatesDropped: stats.duplicatesDropped,
        gaps: stats.gaps,
        complete: nextEndTime <= config.startTime,
      },
      null,
      2,
    ),
  );
}

if (flag('help')) {
  printUsage();
} else {
  runCli().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
