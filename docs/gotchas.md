# docs/gotchas.md

Only items verified by reading the actual source. No speculation.

## `detections-context-agent.md` sync is enforced loosely, not structurally

- `lib/agent-llm.mjs`'s `SELECTOR_KEYS` array (line 70) is the real source of truth for
  the 8 key names/order used everywhere in code (`formatOutputJs`, `verify`,
  `mandatoryKeys`, etc.).
- `detections-context-agent.md` documents the same 8 keys in prose/markdown, but nothing
  in code cross-checks the doc's key names against `SELECTOR_KEYS`.
- The only automated guard is `lib/agent-learn.mjs`'s `validateDoc()` (lines 25-33), which
  runs **only** when `agent-learn.mjs` rewrites the file from user feedback. It checks:
  the new doc is ≥400 chars, contains the literal string `product-form-selector`,
  contains `Hard rules` or `## Keys`, and isn't <45% of the previous doc's length. This
  catches a truncated/corrupted LLM rewrite but **cannot catch** a rewrite (or a manual
  human edit) that silently drops one of the other 7 key names, renames a key, or
  contradicts a hard rule the DOM `verify()` logic depends on (e.g. Hard Rule 3 — never
  emit the outer wrapper for discount-code keys — is separately hard-coded as
  `isOuterDiscountContainer()` in `agent-llm.mjs`; editing the doc's wording does not
  change that JS logic, and vice versa).
- **Practical implication**: if you rename a key in `SELECTOR_KEYS`, you must manually
  update `detections-context-agent.md`'s Output block and the `## Keys` section — there
  is no test or runtime check that will fail if you forget.

## `detections-context-agent.md` is cached in-process

`loadContextDoc()` (`lib/agent-llm.mjs:58-68`) reads the file once and caches it in a
module-level variable (`cachedContextDoc`). The cache is only invalidated by
`invalidateContextDocCache()`, which is called exactly once, right after a
feedback-triggered `learnFromFeedback()` call succeeds (`runLlmAgent`, line 2402). If you
hand-edit `detections-context-agent.md` while `npm run serve` is already running (no
feedback in the request), the running server keeps serving the **old** cached doc until
it restarts or until some request happens to include `feedback`.

## `RETRY_DELAY_MS` is dead code

`lib/agent-llm.mjs:35` defines `const RETRY_DELAY_MS = 12_000;` but it is never
referenced anywhere else in the file. The actual rate-limit backoff in `callClaude()`
(lines 373-383) computes its own delay from the response's `Retry-After` header
(`Number(res.headers.get("retry-after")) || 60`), ignoring this constant entirely. Safe
to remove, or worth wiring in if the intent was a fixed minimum backoff — as written it
does nothing.

## Every discovery run performs a real add-to-cart against the live store

`crawlStorefront()` (`lib/agent-crawl.mjs`, "cart-add" step, lines 453-486) issues a real
`POST /cart/add.js` against whatever store URL is passed in, with up to 3 retry attempts
per candidate product handle, trying every discovered handle until one succeeds. This is
necessary to populate cart/drawer HTML for verification, but it is a genuine side effect
on the target store (session-scoped cart line item, not just a read) — not something to
run against a store you don't have permission to probe, and not idempotent/side-effect-free
if you're re-running discovery repeatedly against the same store in a short loop.

## `output.js` write failures are swallowed silently

`scripts/server.mjs`'s `emitWithWrite` wrapper (lines 191-200) does
`writeFileSync(OUTPUT_JS_PATH, event.outputJs, "utf8")` inside a try/catch whose catch
block is empty except for a comment: `// non-fatal — UI still gets the result`. If the
disk write fails (permissions, disk full, path issue), the NDJSON stream still reports
success to the UI/caller with no indication that `output.js` was not actually updated.

## `scripts/eval-batch.mjs`'s `STORES` array is a hand-copied duplicate of `scripts/eval.mjs`'s

Both files independently define a `STORES` array of the same real stores/theme
names/expected selectors (verified: `eval-batch.mjs` does not import it from
`eval.mjs`, or vice versa — each has its own top-level `const STORES = [...]`). Updating
one list (e.g. after a theme changes on a probed store, or adding a new store) does not
update the other; they will silently drift apart over time unless kept in sync by hand.

## Cart-drawer detection is a large, regex/heuristic-driven surface

Whether a theme "has a drawer" (`crawl.hasDrawer`) — which determines whether 2 of the 8
keys are even required — is decided by `themeUsesCartDrawer()` and `scanDocForDrawerRoots()`
in `lib/agent-crawl.mjs` (lines 190-226, 371-384), a long chain of specific
tag/class/attribute/regex checks accumulated per-theme over time (Alpine `x-show`
patterns, `#sidebar-cart`, `#CartContainer`, `slidecarthq`, etc.). There's no fallback
"unknown/uncertain" state — it's a hard boolean, and adding support for a new theme's
drawer pattern means adding another special case to this function (and, in parallel, to
`DRAWER_ROOTS_QUERY`, `verify()`'s per-key drawer branches, and often
`buildVerifiedCandidateHints()`'s selector pools) rather than one central place.

## Not a gotcha, but worth knowing

- `fixtures/` (7 HTML snapshots) is genuinely unreferenced anywhere in `lib/`, `scripts/`,
  or `public/` — confirmed by grep, not just inferred. It's manual-inspection-only.
- No automated tests exist in this repo (no `test/` dir, no test runner in
  `package.json`). "Testing" this codebase means running `scripts/eval.mjs` or
  `scripts/eval-batch.mjs` against real live Shopify stores — there is no offline/mocked
  test suite.
