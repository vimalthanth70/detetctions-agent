# docs/architecture.md

## The 8 selector keys

In canonical output order (from `SELECTOR_KEYS` in `lib/agent-llm.mjs:70-79`, matching
`detections-context-agent.md`'s Output section):

| # | Key | Always required? |
|---|---|---|
| 1 | `product-form-selector` | yes |
| 2 | `home-page-cvb` | yes |
| 3 | `product-page-cvb` | yes |
| 4 | `cart-drawer-cvb` | only when the theme has a cart drawer/mini-cart |
| 5 | `cart-page-discount-code` | yes |
| 6 | `cart-page-cvb` | yes |
| 7 | `cart-icon` | yes |
| 8 | `cart-drawer-discount-code` | only when the theme has a cart drawer/mini-cart |

`mandatoryKeys(hasDrawer)` (`lib/agent-llm.mjs:42-45`) computes the required subset per
run; `emptyAllowed(key, hasDrawer)` (`:47-49`) says which keys may legitimately be `''`.

## Pipeline

```
runLlmAgent(storeUrl, password, onEvent, opts)      lib/agent-llm.mjs:2345
  │
  ├─ 1. learnFromFeedback()                          lib/agent-learn.mjs
  │      (only if opts.feedback is set) — asks Claude to rewrite
  │      detections-context-agent.md with generalized rules from the
  │      feedback, validates the rewrite, invalidates the cached doc.
  │
  ├─ 2. crawlStorefront(storeUrl, password, emit, opts)   lib/agent-crawl.mjs:407
  │      - openStoreHome() / loginStore() for password-gated stores  (store-session.mjs)
  │      - discover a product handle from home (or /collections/all fallback)
  │      - fetch PDP, POST /cart/add.js (probe add-to-cart), fetch /cart
  │      - resolve cart-drawer markup: scans home/PDP HTML, Alpine <template
  │        data-should-teleport>, Section Rendering API probes
  │        (/?sections=<key>), theme-specific synthetic builders
  │        (Impulse/Archetype AJAX shell, Kalles/t4s mini-cart, SlideCartHQ
  │        /cart.js) — scores candidates by line-item density and picks the best
  │      - detects Cloudflare challenge pages (isCloudflareChallenge)
  │      → returns { base, handle, productUrl, homeHtml/pdpHtml/cartHtml/drawerHtml,
  │                  homeDoc/pdpDoc/cartDoc/drawerDoc, hasDrawer, homeIsBlocked, ... }
  │
  ├─ 3. Compact HTML for the model                    lib/agent-llm.mjs:97-263
  │      compactNode/compactDocHtml strip <script>/<style>/<svg>/comments,
  │      shorten long img src/srcset, truncate long text nodes.
  │      buildFocusHtml() assembles 4-5 labeled sections (HOME hero, HEADER,
  │      PDP product+form, /cart items+totals, CART DRAWER) each capped at
  │      FOCUS_MAX_BYTES=8000 (DRAWER_MAX_BYTES=12000).
  │
  ├─ 4. Build prompt
  │      buildSystemPrompt()  — detections-context-agent.md verbatim + short
  │                             preamble, cached via cache_control: ephemeral
  │      buildUserMessage()   — store/base/PDP/hasDrawer facts, previousSelectors
  │                             (if re-running), user feedback, buildDomProbeHints()
  │                             (heuristic DOM warnings), buildVerifiedCandidateHints()
  │                             (a pool of known-good selectors per theme family,
  │                             pre-verified against this crawl), buildFocusHtml()
  │
  ├─ 5. callClaude()                                  lib/agent-llm.mjs:331
  │      POST {baseUrl}/v1/messages, model=ANTHROPIC_MODEL (default
  │      claude-sonnet-4-6), max_tokens=4096, retries on 429 (up to 3, honors
  │      Retry-After header)
  │
  ├─ 6. parseLlmJson() — last ```json fence in the reply, falls back to
  │      outermost {...} in the whole response
  │
  ├─ 7. applyAndVerify() — for each of the 8 keys, run verify(selector, key, crawl)
  │      (DOM querySelectorAll counts + per-key structural rules, see docs/agent-llm.md)
  │
  ├─ 8. Correction loop (MAX_CORRECTION_TURNS = 2)     lib/agent-llm.mjs:2528-2568
  │      While any mandatory key is still unverified: buildCorrectionMessage()
  │      lists the failing keys + reasons, re-sends to Claude, merges any newly
  │      passing keys into the running `selectors` map. User-supplied selector
  │      overrides (from feedback text or the `selectorOverrides` request field)
  │      are re-applied after every turn and always win if they DOM-verify.
  │
  ├─ 9. Inspection pass (one extra turn, not counted in MAX_CORRECTION_TURNS)
  │      lib/agent-llm.mjs:2570-2642 — for keys still failing after the
  │      correction loop, buildInspectionHints() runs targeted DOM introspection
  │      (inspectProductForms / inspectHomeSections / inspectCartIconLinks /
  │      inspectCartTotals / inspectDrawerContent) and hands Claude concrete
  │      counts/parent-chains instead of raw HTML, then re-verifies.
  │
  ├─ 10. Best-effort fallback if keys are still missing — buildBestEffortSelectors()
  │       emits '❌ CF blocked' for keys whose dependent page was Cloudflare-blocked,
  │       '' for allowed-empty drawer keys, else '' (never surfaces an unverified guess).
  │       Throws (after emitting a partial `result` event) if any mandatory key
  │       is still unverified.
  │
  └─ 11. buildOutputPayload() → formatOutputJs() (lib/format-output.mjs) writes
         `/** host */\nexport default {...}\n` — scripts/server.mjs persists this
         to output.js on every `result` NDJSON event.
```

## Where each stage lives

| Stage | Function | File |
|---|---|---|
| Learn from feedback | `learnFromFeedback()` | `lib/agent-learn.mjs` |
| Crawl | `crawlStorefront()` | `lib/agent-crawl.mjs:407` |
| Compact HTML | `compactDocHtml()`, `buildFocusHtml()` | `lib/agent-llm.mjs:134`, `:252` |
| Build prompts | `buildSystemPrompt()`, `buildUserMessage()` | `lib/agent-llm.mjs:167`, `:265` |
| Call Claude | `callClaude()` | `lib/agent-llm.mjs:331` |
| Parse JSON | `parseLlmJson()` | `lib/agent-llm.mjs:436` |
| DOM verify | `verify()` | `lib/agent-llm.mjs:1215` |
| Apply + track | `applyAndVerify()` | `lib/agent-llm.mjs:1723` |
| Correction retry | inline loop in `runLlmAgent()` | `lib/agent-llm.mjs:2528` |
| Inspection pass | `buildInspectionHints()` + inline block | `lib/agent-llm.mjs:2317`, `:2570` |
| Format output | `formatOutputJs()` | `lib/format-output.mjs` |
| HTTP surface | `handleDiscover()` | `scripts/server.mjs:124` |

## Entry points

- **HTTP**: `npm run serve` → `scripts/server.mjs` → `POST /api/discover` streams NDJSON
  progress events (`step`, `log`, `llm-request`, `llm-response`, `agent-reply`,
  `selector`, `context-updated`, `result`, `error`, `agent-start`, `agent-done`) straight
  from `runLlmAgent`'s `emit` calls; `scripts/server.mjs` also writes `output.js` to disk
  whenever a `result` event carries `outputJs`.
- **Eval**: `scripts/eval.mjs` calls the same `/api/discover` HTTP endpoint (so the server
  must be running) against a hardcoded list of real stores and scores selectors with a
  local, LLM-free DOM-equivalence check. `scripts/eval-batch.mjs` instead calls
  `crawlStorefront`/`buildSystemPrompt`/`buildFocusHtml`/`parseLlmJson` directly and
  submits every store's first discover turn as one Anthropic Message Batches API job.
