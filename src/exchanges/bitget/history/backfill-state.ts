import { promises as fs } from 'fs';
import * as path from 'path';
import { Candle } from './backfill-core';

export interface Checkpoint {
  symbol: string;
  productType: string;
  interval: string;
  rangeStart: number;
  rangeEnd: number;
  /** Next `endTime` to request when walking the range backwards. */
  nextEndTime: number;
  outputPath: string;
  records: number;
  updatedAt: string;
}

export async function readCheckpoint(
  checkpointPath: string,
): Promise<Checkpoint | null> {
  try {
    const raw = await fs.readFile(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as Checkpoint;
    if (
      typeof parsed.nextEndTime !== 'number' ||
      typeof parsed.rangeStart !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function writeCheckpoint(
  checkpointPath: string,
  checkpoint: Checkpoint,
): Promise<void> {
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.writeFile(
    checkpointPath,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    'utf8',
  );
}

export async function readExistingCandles(
  outputPath: string,
  format: 'jsonl' | 'csv',
): Promise<Candle[]> {
  try {
    const raw = await fs.readFile(outputPath, 'utf8');
    if (!raw.trim()) {
      return [];
    }
    if (format === 'jsonl') {
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Candle);
    }
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const header = lines[0];
    if (!header || !header.startsWith('ts,')) {
      return [];
    }
    return lines.slice(1).map((line) => {
      const [ts, open, high, low, close, baseVolume, quoteVolume] =
        line.split(',');
      return {
        ts: Number(ts),
        open,
        high,
        low,
        close,
        baseVolume,
        quoteVolume,
      };
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export function formatCandles(
  candles: Candle[],
  format: 'jsonl' | 'csv',
): string {
  if (format === 'csv') {
    const header = 'ts,open,high,low,close,baseVolume,quoteVolume';
    const rows = candles.map(
      (c) =>
        `${c.ts},${c.open},${c.high},${c.low},${c.close},${c.baseVolume},${c.quoteVolume}`,
    );
    return [header, ...rows].join('\n') + '\n';
  }
  return (
    candles.map((c) => JSON.stringify(c)).join('\n') +
    (candles.length ? '\n' : '')
  );
}

export async function writeOutput(
  outputPath: string,
  candles: Candle[],
  format: 'jsonl' | 'csv',
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath) || '.', { recursive: true });
  await fs.writeFile(outputPath, formatCandles(candles, format), 'utf8');
}
