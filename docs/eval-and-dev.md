# docs/eval-and-dev.md

## Running the dev server

```bash
npm run serve            # node scripts/server.mjs — listens on 0.0.0.0:${PORT:-3002}
PORT=4000 npm run serve   # override the port
```

`scripts/server.mjs` loads `.env` itself (a tiny hand-rolled parser, `loadEnvFile()`) —
values already set in the real environment win over `.env`. Required/known env vars
(from `.env.example`):

| Var | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | — | server returns HTTP 503 on `/api/discover` if unset |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-6` | passed straight to the Messages API |
| `PORT` | no | `3002` | |

Routes: `GET /` and `GET /public/*` serve `public/index.html` and static assets; `GET
/api/config` returns `{hasApiKey, model}` (no secrets); `POST /api/discover` takes
`{storeUrl, password?, productHandle?, feedback?/agentMessage?/message?,
previousSelectors?, selectorOverrides?, learnFromFeedback?, allowCustomDomain?}` and
streams NDJSON progress events, ending in a `result` (with `outputJs`, written to
`output.js` on disk by the server itself) or an `agent-error` event.

## Running the evals

### `scripts/eval.mjs` — DOM-based, needs the server running

```bash
npm run serve &                       # eval.mjs calls http://localhost:${PORT:-3002}/api/discover
node scripts/eval.mjs
node scripts/eval.mjs --store wrne13-mp.myshopify.com
node scripts/eval.mjs --concurrency 2
```

It holds a hardcoded `STORES` array (real store hostnames + `schema_name` + expected
8-selector map). For each store it first re-fetches the home page and checks
`Shopify.theme.schema_name` still matches the recorded value — if the store's theme was
swapped since the fixture was recorded, that store is **skipped** rather than scored as a
failure. It then calls the live `/api/discover` endpoint (real Claude calls, real crawl)
and compares the returned selectors to the expected ones with `domEquivalent()` — a
DOM-based check (do `got` and `expected` resolve to the same node on a freshly-fetched
page?) that falls back to plain string equality only when neither selector matches
anything, so cosmetic-but-equivalent selector differences don't count as failures.

### `scripts/eval-batch.mjs` — Anthropic Message Batches API, no server required

```bash
ANTHROPIC_API_KEY=sk-ant-... node scripts/eval-batch.mjs
node scripts/eval-batch.mjs --store moroccantan --no-corrections
node scripts/eval-batch.mjs --resume batch_abc123     # score an already-completed batch
```

Same `STORES` list (duplicated in this file, not imported from `eval.mjs`). Instead of
one HTTP round-trip per store, it: (1) crawls every store in parallel with
`crawlStorefront()` directly (no LLM calls), (2) packages every store's **initial**
discover turn into a single Anthropic batch job via `POST /v1/messages/batches` (uses
`anthropic-beta: message-batches-2024-09-24,prompt-caching-2024-07-31` and reuses
`buildSystemPrompt`/`buildFocusHtml`/`parseLlmJson` imported straight from
`lib/agent-llm.mjs`), (3) polls every 15s (`POLL_INTERVAL_MS`) until the batch completes,
(4) optionally runs a second batch for stores whose keys still need a correction pass
(skippable with `--no-corrections`). The comment at the top of the file states the
tradeoff directly: batches are **50% cheaper** than the per-store streaming calls
`eval.mjs` makes, at the cost of losing live progress/streaming and needing to poll for
completion rather than getting an answer inline.

Use `eval.mjs` for a quick single-store check or when you need to watch the live
NDJSON stream; use `eval-batch.mjs` for a full-suite regression run where cost matters
more than turnaround time.

## `fixtures/`

Contains 7 saved real-store HTML snapshots (`boxo-home.html`, `boxo-product.html`,
`cactus-pdp.html`, `pdp-snapshot.html`, `shapeshifter-home.html`, `shapeshifter-pdp.html`,
`shapeshifter-cvb-tried.txt`). **Verified by grep: nothing in `lib/`, `scripts/`, or
`public/` references this directory.** It exists purely for manual local
inspection/debugging (e.g. opening a snapshot in an editor to reason about a theme's DOM
structure) — it is not loaded by either eval script or by the server.

## `output.js`

Generated artifact, not hand-written. `scripts/server.mjs`'s `handleDiscover()` writes it
to disk every time a `result` NDJSON event carries `outputJs` (see
`emitWithWrite` in `scripts/server.mjs:191-200`). Format is fixed by
`lib/format-output.mjs`'s `formatOutputJs()`: a `/** host */` comment line followed by
`export default { 'key': 'selector', ... };` with single-quoted keys/values in the
canonical `SELECTOR_KEYS` order. Do not hand-edit it — the next successful run overwrites
it unconditionally.
