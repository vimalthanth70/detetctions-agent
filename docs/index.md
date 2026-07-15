# docs/index.md

## Purpose

This repo crawls a live Shopify storefront and uses Claude to discover 8 theme-native CSS
selectors describing where the add-to-cart form, hero/critical-view-block containers,
cart icon, and discount-code slots live in that theme's DOM. It DOM-verifies every
selector Claude proposes against the actual crawled pages before accepting it, retries
failed keys with Claude for up to 2 correction turns plus one further targeted
"inspection" turn, and writes the final 8 selectors to `output.js`. Monk Commerce's
upsell widget product uses this output to inject UI into arbitrary Shopify themes
without per-theme hardcoding.

The whole thing is driven by one long orchestration function,
`runLlmAgent()` in `lib/agent-llm.mjs`, fronted by a small HTTP server
(`scripts/server.mjs`) that streams progress as NDJSON to `public/index.html`.

## Read order

1. **`docs/index.md`** (this file) — orientation and file map.
2. **`docs/architecture.md`** — the real pipeline, stage by stage, with file:function pointers.
3. **`docs/agent-llm.md`** — deep dive on `lib/agent-llm.mjs` (2711 lines, does most of the work). Read before editing it.
4. **`docs/eval-and-dev.md`** — how to run the server and the two eval harnesses.
5. **`docs/gotchas.md`** — verified fragile areas, coupling points, and known dead code.

## File responsibility table

| File | Responsibility |
|---|---|
| `lib/agent-llm.mjs` | Core agent: builds the prompt from `detections-context-agent.md`, compacts scraped HTML, calls Claude, parses/validates JSON, runs correction + inspection turns, DOM-verifies every selector, formats output. |
| `lib/agent-crawl.mjs` | Shared crawler: cookie-jar session, fetches home/PDP/cart/drawer pages, adds an item to cart, resolves drawer markup (including sections-API/AJAX/template variants), detects Cloudflare challenges. |
| `lib/agent-learn.mjs` | Feedback loop: asks Claude to rewrite `detections-context-agent.md` with generalized rules from user feedback; validates the rewrite isn't truncated/corrupted before saving. |
| `lib/store-session.mjs` | Cookie-jar helpers (`applySetCookies`), Shopify storefront password-gate detection and login. |
| `lib/store-url.mjs` | Validates/normalizes the input store URL (`*.myshopify.com`, optionally a custom domain), resolves the effective base URL after redirects. |
| `lib/format-output.mjs` | Formats the 8 selectors into `output.js`'s exact single-quoted string format. |
| `scripts/server.mjs` | HTTP server/CLI entrypoint: serves `public/index.html`, `GET /api/config`, `POST /api/discover` (NDJSON progress stream). `npm run serve` starts this. |
| `scripts/eval.mjs` | Per-store eval harness against a hardcoded `STORES` array; calls the running server's `/api/discover` and scores selectors by DOM equivalence. |
| `scripts/eval-batch.mjs` | Same eval, but packages every store's initial discover request into one Anthropic Message Batches API call (cheaper, no server required, no streaming). |
| `detections-context-agent.md` | **Runtime LLM system prompt** (not documentation) — the rulebook Claude follows; also the file `agent-learn.mjs` rewrites from feedback. |
| `output.js` | Generated artifact — the last run's 8 selectors. Not hand-written. |
| `public/index.html` | Dashboard UI: form to kick off a discovery run, live NDJSON progress log, selector results. |
| `fixtures/` | Saved real-store HTML snapshots for manual local inspection. Not wired into `eval.mjs`/`eval-batch.mjs` or any other script — verified by grep, no references exist. |
