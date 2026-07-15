# AGENTS.md

## What this repo is

`detections-agent` is a small Node.js (ESM) service that crawls a live Shopify storefront
(home page, PDP, cart page, cart drawer) and asks Claude to discover 8 theme-native CSS
selectors — the add-to-cart form, critical-view-block containers for home/product/cart,
the cart icon, and the discount-code slots for cart page and cart drawer. The result lets
Monk Commerce's upsell widget inject UI into any Shopify theme without hardcoding
per-theme selectors. Output is written to `output.js` in the exact 8-key format consumed
downstream.

## Before editing code

Read `docs/index.md` first — it lists the other docs in the right order and gives a
one-line responsibility for every file in the repo. Then read `docs/architecture.md` for
the pipeline shape, and `docs/agent-llm.md` before touching `lib/agent-llm.mjs` (it is
2711 lines and does almost all of the work).

## `detections-context-agent.md` is not documentation

`detections-context-agent.md` (repo root) is a **runtime LLM system prompt** — it is sent
to Claude verbatim on every discovery run (see `buildSystemPrompt()` in
`lib/agent-llm.mjs`). It is edited by humans directly *and* rewritten programmatically by
`lib/agent-learn.mjs` when a request includes `feedback`. Do not treat it as a README and
do not casually reformat it — its exact structure (the 8 key names, `## Hard rules`,
`## Keys`) is checked by `agent-learn.mjs`'s `validateDoc()` before any automated rewrite
is allowed to land. See `docs/gotchas.md` for the specific coupling points.

## Dev commands

```bash
npm run serve                              # starts scripts/server.mjs (dashboard + POST /api/discover)
node scripts/eval.mjs                      # DOM-based eval against hardcoded real stores (needs the server running)
node scripts/eval.mjs --store <host>       # single store
node scripts/eval.mjs --concurrency 2      # parallel stores
ANTHROPIC_API_KEY=sk-ant-... node scripts/eval-batch.mjs   # same eval, via Anthropic Message Batches API (cheaper, no server needed)
```

See `docs/eval-and-dev.md` for env vars and the fuller picture.
