# Bitget historical candle backfill

Educational example for issue
[#2](https://github.com/sieblyio/awesome-crypto-examples/issues/2):
page through public Bitget history candles, stay inside the 90-day query
window, throttle requests, retry `429` / transient failures, checkpoint
progress, and write ordered JSONL or CSV.

This is a demonstration, not a recommended production ingestion stack.
It uses the repository's current `bitget-api` `RestClientV2` and the
public V2 mix `history-candles` endpoint. No API keys are required.

## Run

```bash
npx ts-node src/exchanges/bitget/history/backfill-candles.ts \
  --symbol BTCUSDT \
  --productType USDT-FUTURES \
  --interval 1H \
  --start 2024-01-01T00:00:00Z \
  --end 2024-01-08T00:00:00Z \
  --output ./btc-1h.jsonl
```

Optional flags:

- `--format jsonl|csv` (default `jsonl`)
- `--checkpoint PATH` (default `<output>.checkpoint.json`)
- `--limit N` (default 100)

Re-running the same command resumes from the checkpoint: overlapping
timestamps are dropped, and the final file is rewritten in chronological
order.

When the run finishes it prints request counts, retries, duplicate
drops, and missing intervals.

## Fixture checks

These do not call Bitget. They replay recorded pages, including an
overlap and a 429 payload:

```bash
npx ts-node src/exchanges/bitget/history/backfill-candles.test.ts
```

## Notes

- Each request stays inside a 90-day window.
- The limiter waits 150ms between requests (well under the 20/sec IP budget).
- `429`, `5xx`, and timeout-like errors retry with bounded exponential
  backoff and jitter.
- Interrupted runs can resume because each successful page writes the
  last `nextEndTime` and the candles collected so far.
- Spot history is omitted here because this SDK version signs the spot
  history helper; the mix history endpoint is public.
