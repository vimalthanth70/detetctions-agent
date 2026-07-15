# docs/agent-llm.md — `lib/agent-llm.mjs` deep dive

2711 lines, does almost everything: prompt building, the Anthropic API call, JSON
parsing, DOM verification, correction/inspection retry orchestration, and output
formatting glue. Read this before editing the file.

## Constants (top of file, lines 32-40)

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_MODEL` | `"claude-sonnet-4-6"` | fallback if `ANTHROPIC_MODEL` env/opt is unset |
| `DEFAULT_BASE_URL` | `"https://api.anthropic.com"` | fallback if `ANTHROPIC_BASE_URL` is unset |
| `MAX_CORRECTION_TURNS` | `2` | how many correction round-trips to Claude after the initial discover turn |
| `RETRY_DELAY_MS` | `12_000` | **defined but never referenced anywhere else in the file** — see `docs/gotchas.md` |
| `FOCUS_MAX_BYTES` | `8000` | per-section cap (home hero, header, PDP, cart) when compacting HTML for the prompt |
| `DRAWER_MAX_BYTES` | `12000` | cap for the cart-drawer section specifically (drawers tend to be deeper/nested) |
| `SELECTOR_KEYS` | 8-entry array | canonical key list + order, line 70 |
| `DRAWER_KEYS` | `Set(["cart-drawer-cvb","cart-drawer-discount-code"])` | the only two keys allowed to be `''` |

Also note: `setDefaultResultOrder("ipv4first")` is called at module load (line 26) to
force IPv4-first DNS — a deliberate fix for `EHOSTUNREACH` on networks where
`api.anthropic.com`'s AAAA record is unreachable. This is a global Node DNS setting, not
scoped to this module.

## Function map

### Context doc loading

| Function | Purpose |
|---|---|
| `loadContextDoc()` | reads `detections-context-agent.md` from disk, cached in module-level `cachedContextDoc` |
| `invalidateContextDocCache()` (exported) | clears the cache — called after `learnFromFeedback()` rewrites the file, so the very next prompt build re-reads it |

### HTML compaction (lines 86-263)

| Function | Purpose |
|---|---|
| `compactNode(node, opts)` | recursively strips `<script>/<style>/<link>/<noscript>/<svg>/<template>/<meta>/<iframe>`, comment nodes, `style="..."` attrs; shortens long `img`/`source`/`picture` src/srcset (>80 chars → `<…>`); truncates text nodes over `opts.maxText` (default 120) |
| `compactDocHtml(doc, opts)` | picks the first matching `scopeSelectors` element (falls back to `body`/`documentElement`), clones it, runs `compactNode`, truncates to `opts.maxBytes` |
| `compactHomeHero`, `compactHeader`, `compactPdpProduct`, `compactCartMain`, `compactDrawer` | per-surface wrappers around `compactDocHtml` with theme-aware scope-selector lists tried in order (e.g. home hero tries `slide-show`, `slideshow-component`, `full-width-slider`, `#MainContent`, `#main`, `main`) |
| `buildFocusHtml(crawl)` (exported) | concatenates all five sections into the labeled block sent to the model |

### Prompt building

| Function | Purpose |
|---|---|
| `buildSystemPrompt()` (exported) | wraps `detections-context-agent.md` verbatim between banner comments, with a 4-line preamble telling Claude it's reading compacted HTML and must end with one ` ```json ` block |
| `buildUserMessage(crawl, {correction, feedback, previousSelectors})` | builds the first user turn: store/base/PDP facts, `Has cart drawer`, `Home page status` (flags Cloudflare-block fallbacks), `previousSelectors` block (for re-runs), `USER FEEDBACK` block, `buildDomProbeHints()`, `buildVerifiedCandidateHints()`, a Horizon-specific nudge, then `buildFocusHtml()` |
| `buildDomProbeHints(crawl)` | ~15 independent heuristic checks against the live DOM (e.g. multiple cart/add forms, JS-driven ATC with no form, header cart-icon web component detected, Aurora/HaloTheme/Timber/Venue/Impulse theme-specific fingerprints) — each becomes one warning line fed to the model |
| `buildVerifiedCandidateHints(crawl)` | for each key, walks an ordered pool of known-good selector patterns (`pools` object, ~340 lines) and DOM-verifies each one against this crawl with `verify()`; the first one that passes is surfaced as `"<key>: DOM-verified candidate → <selector>"` — this is the single largest source of "the model just picks the right answer immediately" behavior |
| `effectiveHomeDoc(crawl)` | when the home page was Cloudflare-blocked, falls back to `homeAfterAddDoc`, then `drawerDoc` (only if genuinely different from `homeDoc`), then the blocked doc itself as last resort |

### Anthropic API call

| Function | Purpose |
|---|---|
| `callClaude({apiKey, model, baseUrl, system, messages, emit, maxRetries=3})` (exported) | POSTs to `{baseUrl}/v1/messages`; wraps the system string in `[{type:"text", text, cache_control:{type:"ephemeral"}}]` for prompt caching; sends header `anthropic-beta: prompt-caching-2024-07-31`; retries on HTTP 429 (or a message matching `/rate limit/i`) up to `maxRetries`, sleeping `Number(retry-after header) \|\| 60` seconds between attempts; throws with `.statusCode`/`.payload` set on other failures |
| `stripTrailingJsonBlock(text)` | removes the last ` ```json ` fence so the reasoning prose can be logged separately from the structured answer |
| `chunkReasoningForLog(text, maxParas=8)` | splits reasoning into paragraph chunks (splits on blank lines) for the NDJSON `log` stream, capping at 8 paragraphs with a "+N more" tail |
| `parseLlmJson(text)` (exported) | prefers the **last** ` ```json ... ``` ` fence containing `{`; falls back to the outermost `{...}` in the fence, then the outermost `{...}` in the whole reply; returns `null` if nothing parses |

### DOM verification (the bulk of the file, ~1200 lines)

| Function | Purpose |
|---|---|
| `selectorSurfaceCheck(selector)` | rejects selectors matching `DYNAMIC_SECTION_RE` (`shopify-section-template--\d+__`), `DYNAMIC_ID_IN_SELECTOR_RE` (dynamic numeric ids), or `APP_INJECTED_RE` (`mr-div-embedded`, `shopify-block-Aa*upsell_monk*`) before any DOM check runs |
| `countOf(doc, sel)` / `safeQuery(doc, sel)` | `querySelectorAll`/`querySelector` wrapped in try/catch, return `-1`/`null` on invalid selectors instead of throwing |
| `countOutsideDrawer`, `queryDrawerElements`, `resolveDrawerElements`, `countOutsideDrawerContext` | drawer-scoped counting — a selector for a drawer key must match exactly once **inside** `DRAWER_ROOTS_QUERY` (from `agent-crawl.mjs`) and zero times outside it, across home/PDP/cart |
| `isTotalsWrapper`, `isCartMainContent`, `isSiteFooter`, `hasCheckoutControl`, `isOuterDiscountContainer`, `isCartRecapForm`, `isDrawerDiscountSlot`, `looksLikeLineItemsContainer`, `isCartIconTrigger`, `validateCartIconMatches` | structural predicates used inside `verify()`'s per-key branches — e.g. `isOuterDiscountContainer` rejects known outer-wrapper classes (`.cart-recap`, `.cart-page__summary`, `.mini-cart__recap`, ...) so a discount-code key can't be satisfied by the container root instead of the inner totals row (Hard Rule 3 in the context doc) |
| **`verify(selector, key, crawl)`** (exported, line 1215) | the actual pass/fail gate, one `switch (key)` branch per selector key. Always short-circuits `''` to `{ok:true}` and checks `selectorSurfaceCheck` first. Guards against verifying on Cloudflare-blocked pages (`pdpIsBlocked`/`homeIsBlocked`/`cartIsBlocked`, each mapped to the 2 keys that depend on that page). See per-key rules below. |

**Per-key `verify()` rules** (this is the ground truth for "what does 'pass' mean"):

- `product-form-selector`: PDP count must be exactly 1, home/effective-home count must be 0; must be a `<form action*="cart/add">`, or (when the PDP has no standard form at all / only app-injected quick-buy forms) a button/link/input whose class/id/text looks like an add-to-cart control.
- `home-page-cvb`: home count 1 and PDP count 0; OR home=1/pdp=1 if the element sits inside `.shopify-section-group-header-group` (global header-group hero reused across pages is still accepted).
- `product-page-cvb`: home 0, PDP 1; must contain `form[action*="cart/add"]`, or (JS-driven ATC theme) contain a recognizable ATC button.
- `cart-drawer-cvb` / `cart-drawer-discount-code`: if `!hasDrawer`, only `''` passes. Otherwise: exactly 1 match **inside** the drawer root and 0 outside it (`resolveDrawerElements` searches `drawerDoc → homeAfterAddDoc → homeDoc → pdpDoc` in that order for the first doc with any match); several theme-specific overrides accept a selector as valid even at count 0 when the content is AJAX-populated (`#CartContainer .ajaxcart__inner` for Timber, `#sidebar-cart .Cart__ItemList` for Archetype/Atlantic) or explicitly reject `#CartDrawerForm`-rooted selectors as "AJAX shell, not real DOM" when a `cart-drawer`/`#CartContainer` element is present; must look like a line-items container (`looksLikeLineItemsContainer`) or a drawer totals slot (`isDrawerDiscountSlot`), never the bare `<footer>` element.
- `cart-page-discount-code` / `cart-page-cvb`: cart count 1, home count 0, PDP count 0; must be inside cart main content (not the site footer, not a drawer overlay unless the same selector genuinely never matches home/PDP); discount-code additionally must not be an `isOuterDiscountContainer` and must be `isTotalsWrapper`; cvb additionally must not be `isCartRecapForm` and must be `looksLikeLineItemsContainer` (with an empty-cart fallback heuristic when the cart was crawled empty).
- `cart-icon`: home count and PDP count must be equal and be 1 or 2 (2 = desktop+mobile is fine); rejects hrefs containing `/cart/add`; rejects drawer-internal matches unless they're a recognized cart-icon trigger element.

### Correction / retry mechanics

| Function | Purpose |
|---|---|
| `mandatoryKeys(hasDrawer)` / `emptyAllowed(key, hasDrawer)` | which keys must be non-empty this run |
| `trimSelector(val)` / `parseFeedbackSelectors(feedback)` (exported) | extracts explicit `key: 'selector'`-style hints out of free-text feedback via a battery of regexes (`key should be '...'`, `use '...' for key`, a fenced ` ```json ` block, etc.) |
| `verifiedUserHints(userHints, crawl)` | re-runs `verify()` on every user-supplied hint; only hints that pass become "locked" — locked keys always win over whatever the LLM says |
| `keysNeedingWork(selectors, crawl, userHints)` | a key needs another turn if it's still empty, or if a locked user hint disagrees with the current value |
| `mergeSelectorHints(...sources)` | merges `parseFeedbackSelectors()` output with the request's `selectorOverrides` field |
| `applyUserSelectorOverrides(selectors, details, crawl, overrides, emit, source)` | re-verifies and applies overrides after each turn, emitting `selector`/`log` events tagged with the override's `source` (`"feedback"`, `"feedback-final"`, etc.) |
| `applyAndVerify(parsed, crawl, emit, {lockedKeys})` (exported) | the main "take LLM JSON → verify each key → build the `selectors`/`details` maps" step; locked keys bypass the LLM's value entirely |
| `buildCorrectionMessage(crawl, selectors, details, {userHints})` | lists every still-failing mandatory key with its rejection reason, plus any verified-but-not-yet-applied user hints, for the next Claude turn |
| **Correction loop** (inline in `runLlmAgent`, lines 2528-2568) | runs up to `MAX_CORRECTION_TURNS=2` times; each turn re-sends `buildCorrectionMessage()` + `buildFocusHtml()` as a new user message, re-verifies, and merges any newly-passing keys into the running result (never overwrites an already-passing key with a worse one) |
| **Inspection pass** (inline, lines 2570-2642) | one additional turn, separate from the correction-turn budget, triggered only if mandatory keys are still missing after the correction loop; calls `buildInspectionHints()` for targeted per-key DOM analysis and includes a template-drawer bypass (see below) |

### Inspection-pass helpers (lines 1877-2333)

| Function | Purpose |
|---|---|
| `isTemplateDrawer(crawl)` / `extractTemplateDrawerContent(rawHtml)` | detects drawer markup hidden inside `<template data-cart-drawer-template>` (invisible to `querySelectorAll`) and pulls its inner HTML out as a string for the model to read directly |
| `getParentChain(el, depth=6)` / `elDesc(el)` | pretty-print an element and its ancestor chain (tag/id/classes, first few `data-*`/`action`/`name` attrs) for inclusion in inspection prompts |
| `inspectProductForms(crawl)` | lists every `form[action*="/cart/add"]` on the PDP (flagging `[INSTALLMENT]`/`[UPSELL]` forms), and if exactly one "main" form remains, walks its ancestor chain trying candidate selectors until one is unique to the PDP (`home=0`) |
| `inspectHomeSections(crawl)` | walks the first ~12 sections under `#MainContent`/`main`, checking each section's own classes and inner descendant classes for one that is home-only or scopeable via `:first-child`, flagging header-group sections specially |
| `inspectCartIconLinks(crawl)` | lists every `a[href$="/cart"]` plus non-standard JS-driven cart triggers (`[data-cart-pc]`, `[data-cart-toggle]`, etc.), with parent chain and in-header/in-drawer flags |
| `inspectCartTotals(crawl)` | dumps children of common totals containers (`.cart__recap`, `#main-cart-footer`, `.totals`, ...) and flags duplicate-totals-widget situations (Aurora double discount-code, sticky-header mini-cart subtotal duplication), walking ancestor chains to suggest a scoping selector that reduces the match count to exactly 1 |
| `extractDrawerFooterChunk(rawHtml, maxBytes=3000)` | keyword-anchored (`subtotal`, `checkout`, `cart-footer`, ...) window plus the raw HTML tail, since drawer footers are usually near the end of the markup |
| `inspectDrawerContent(crawl, key)` | routes to the template-drawer extraction or `extractDrawerFooterChunk`/raw-prefix depending on whether the key is the discount-code (footer-focused) or cvb (top-of-drawer-focused) key |
| `buildInspectionHints(failedKeys, crawl)` (line 2317) | dispatch table mapping each failing key to its inspector function, joined with `---` separators |
| Template-drawer bypass (inline, lines 2623-2638) | if the theme is a template-drawer theme, the inspection pass accepts the LLM's raw `cart-drawer-cvb`/`cart-drawer-discount-code` values **without** DOM verification (since `querySelectorAll` structurally cannot see inside `<template>`) |

### Fallback / output

| Function | Purpose |
|---|---|
| `buildCfBlockedKeys(crawl)` | maps Cloudflare-blocked pages to the keys that depend on them (PDP→form/cvb keys, home→hero/icon keys, cart→discount/cvb keys) |
| `buildBestEffortSelectors(crawl, verified, details, lastParsed)` (exported) | final safety net: verified value if present, `''` if the key is allowed-empty, `'❌ CF blocked'` if its page was blocked, else always `''` — **an unverified LLM guess is never surfaced**, even as a partial result |
| `buildOutputPayload(storeUrl, crawl, selectors, {partial, missingKeys, elapsedMs})` | wraps selectors + `formatOutputJs()` output + metadata into the payload shape emitted on the `result` NDJSON event |

## Public entry point

`runLlmAgent(storeUrl, password, onEvent, opts)` (exported, line 2345) — see
`docs/architecture.md` for the full stage-by-stage walkthrough. Key `opts` fields:
`apiKey`, `model`, `baseUrl`, `feedback`/`agentMessage`, `previousSelectors`,
`selectorOverrides`, `learnFromFeedback` (bool, default true whenever `feedback` is set),
`productHandle`, `allowCustomDomain`. Throws (after emitting a partial `result` event
first) if any mandatory key is still unverified after the correction + inspection passes.

## Also exported (line 2698)

`SELECTOR_KEYS`, `mandatoryKeys`, `emptyAllowed`, `verify`, `parseLlmJson`, `callClaude`,
`buildSystemPrompt`, `buildFocusHtml`, `buildDomProbeHints`, `applyAndVerify`,
`buildOutputPayload`, `buildBestEffortSelectors` — this is the surface `scripts/eval-batch.mjs`
imports directly (bypassing the HTTP server) to build its own batched Claude requests.
