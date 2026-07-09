/**
 * Batch Eval — run the detections agent eval using the Anthropic Message Batches API.
 *
 * Instead of calling the agent one store at a time, this script:
 *   1. Crawls all stores in parallel (plain HTTP, no LLM)
 *   2. Packages every initial discover request into a single Anthropic batch (50% cheaper)
 *   3. Polls until the batch completes, then scores each result
 *   4. Optionally runs a second batch for stores that need correction passes
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/eval-batch.mjs
 *   node scripts/eval-batch.mjs --store moroccantan --no-corrections
 *   node scripts/eval-batch.mjs --resume batch_abc123   # score an already-completed batch
 *
 * Environment:
 *   ANTHROPIC_API_KEY   required
 *   ANTHROPIC_BASE_URL  optional (default: https://api.anthropic.com)
 */

import { parseHTML } from "linkedom";
import { crawlStorefront } from "../lib/agent-crawl.mjs";
import {
  buildSystemPrompt,
  buildFocusHtml,
  parseLlmJson,
  SELECTOR_KEYS,
} from "../lib/agent-llm.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const MODEL = "claude-sonnet-4-6";   // batches don't support streaming; Sonnet is cost-effective
const MAX_TOKENS = 4096;
const POLL_INTERVAL_MS = 15_000;     // 15s polling interval

if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY environment variable.");
  process.exit(1);
}

// ─── Stores (same as eval.mjs) ────────────────────────────────────────────────

const STORES = [
  {
    url: "johnbarbersons.myshopify.com",
    schema_name: "Prestige",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
      "home-page-cvb": "main .shopify-section:first-of-type .slideshow",
      "product-page-cvb": ".product",
      "cart-drawer-cvb": "cart-drawer .cart-drawer__items",
      "cart-page-discount-code": ".cart-recap .h-stack",
      "cart-page-cvb": "form.cart-page .order-summary",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code": ".cart-drawer__footer .button-group",
    },
  },
  {
    url: "wrne13-mp.myshopify.com",
    schema_name: "Horizon",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
      "home-page-cvb": ".container-background-image",
      "product-page-cvb": ".product-information",
      "cart-drawer-cvb": "cart-drawer-component .cart-items__wrapper",
      "cart-page-discount-code": ".cart-page__summary .cart__summary-totals",
      "cart-page-cvb": ".cart-page__items",
      "cart-icon": "cart-icon",
      "cart-drawer-discount-code": "cart-drawer-component .cart-drawer__summary > :first-child",
    },
  },
  {
    url: "street-cartel-official.myshopify.com",
    schema_name: "Lorenza",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
      "home-page-cvb": "main .shopify-section:first-of-type .slideshow",
      "product-page-cvb": 'section[data-section-type="product"]',
      "cart-drawer-cvb": "[data-cart-drawer] .quick-cart__items",
      "cart-page-discount-code": ".cart-template__footer-info",
      "cart-page-cvb": ".cart-template__items",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code": ".quick-cart__footer .quick-cart__subtotal",
    },
  },
  {
    url: "hw0cvu-jr.myshopify.com",
    schema_name: "Wonder",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
      "home-page-cvb": ".wt-brands__container",
      "product-page-cvb": ".wt-product__wrapper",
      "cart-drawer-cvb": "cart-drawer cart-drawer-items",
      "cart-page-discount-code": "#main-cart-footer .wt-cart__subtotal",
      "cart-page-cvb": ".wt-cart__list",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code": "cart-drawer .wt-cart__subtotal",
    },
  },
  {
    url: "bys-store-3019840-669106.myshopify.com",
    schema_name: "Savor",
    selectors: {
      "product-form-selector": "form.shopify-product-form",
      "home-page-cvb": "section.animated-banner",
      "product-page-cvb": "section.custom-product-page",
      "cart-drawer-cvb": "",
      "cart-page-discount-code": ".cart-summary .total-row",
      "cart-page-cvb": ".cart-left",
      "cart-icon": "a.s1-icon.cart-wrap",
      "cart-drawer-discount-code": "",
    },
  },
  {
    url: "remorehair.myshopify.com",
    schema_name: "Yuva",
    selectors: {
      "product-form-selector": '.product-section form[action*="/cart/add"]',
      "home-page-cvb": ".banner-section",
      "product-page-cvb": ".product-section",
      "cart-drawer-cvb": "",
      "cart-page-discount-code": ".cart-total-item[data-cart-total]",
      "cart-page-cvb": "form.yv-cart-content",
      "cart-icon": "a.cart-icon",
      "cart-drawer-discount-code": "",
    },
  },
  {
    url: "the-coffee-ride-coffee-roasting-co.myshopify.com",
    schema_name: "Brooklyn",
    selectors: {
      "product-form-selector": 'form[action*="/cart/add"]:not([id*="installment"])',
      "home-page-cvb": ".hero",
      "product-page-cvb": '[data-section-type="product-template"]',
      "cart-drawer-cvb": "#CartContainer .ajaxcart__inner",
      "cart-page-discount-code": "form.cart:not(.ajaxcart) .grid__item.large--five-twelfths .cart__row--table",
      "cart-page-cvb": "form.cart:not(.ajaxcart)",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code": "#CartContainer .ajaxcart__footer > .grid--full",
    },
  },
  {
    url: "yaluum.myshopify.com",
    schema_name: "Prestige",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
      "home-page-cvb": ".slideshow",
      "product-page-cvb": ".product",
      "cart-drawer-cvb": "cart-drawer .cart-drawer__items",
      "cart-page-discount-code": ".cart-recap .h-stack",
      "cart-page-cvb": "form.cart-page .order-summary",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code": ".cart-drawer__footer .yl-row.yl-total",
    },
  },
  {
    url: "vorsteinerwheels.myshopify.com",
    schema_name: "Impact",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
      "home-page-cvb": ".slideshow",
      "product-page-cvb": ".product",
      "cart-drawer-cvb": "cart-drawer .cart-drawer__line-items",
      "cart-page-discount-code": ".cart-form .cart-form__totals",
      "cart-page-cvb": ".order-summary",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code": 'cart-drawer [slot="footer"] > div:first-child',
    },
  },
  {
    url: "moroccantan.myshopify.com",
    schema_name: "Dawn",
    selectors: {
      "product-form-selector": 'product-form.product-form form[action*="/cart/add"]',
      "home-page-cvb": ".slideshow",
      "product-page-cvb": ".product.product--medium",
      "cart-drawer-cvb": "cart-drawer cart-drawer-items",
      "cart-page-discount-code": "#main-cart-footer .totals",
      "cart-page-cvb": ".cart__items",
      "cart-icon": 'header a[href="/cart"]',
      "cart-drawer-discount-code": "cart-drawer .cart-drawer__footer .totals",
    },
  },
  {
    url: "memorablxs.myshopify.com",
    schema_name: "Pebble",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
      "home-page-cvb": "#MainContent > .section:first-child",
      "product-page-cvb": ".product-information",
      "cart-drawer-cvb": "cart-drawer-component .cart-items__wrapper",
      "cart-page-discount-code": ".cart-page__summary .cart-summary__total",
      "cart-page-cvb": ".cart-page__items",
      "cart-icon": '.header__icons .header__buttons a[href$="/cart"]',
      "cart-drawer-discount-code": ".cart-drawer__summary .cart-summary__total",
    },
  },
];

const KEYS = [
  "product-form-selector",
  "home-page-cvb",
  "product-page-cvb",
  "cart-drawer-cvb",
  "cart-page-discount-code",
  "cart-page-cvb",
  "cart-icon",
  "cart-drawer-discount-code",
];

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const storeIdx = args.indexOf("--store");
const storeFilter = storeIdx !== -1 ? args[storeIdx + 1] : null;
const noCorrections = args.includes("--no-corrections");
const resumeIdx = args.indexOf("--resume");
const resumeBatchId = resumeIdx !== -1 ? args[resumeIdx + 1] : null;

// ─── Anthropic Batches API helpers ────────────────────────────────────────────

const BATCH_HEADERS = {
  "x-api-key": API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "message-batches-2024-09-24,prompt-caching-2024-07-31",
  "content-type": "application/json",
};

async function createBatch(requests) {
  const res = await fetch(`${BASE_URL}/v1/messages/batches`, {
    method: "POST",
    headers: BATCH_HEADERS,
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Batch create failed (${res.status}): ${err?.error?.message || JSON.stringify(err)}`);
  }
  return res.json();
}

async function getBatch(batchId) {
  const res = await fetch(`${BASE_URL}/v1/messages/batches/${batchId}`, {
    headers: BATCH_HEADERS,
  });
  if (!res.ok) throw new Error(`Batch get failed (${res.status})`);
  return res.json();
}

async function getBatchResults(batchId) {
  const res = await fetch(`${BASE_URL}/v1/messages/batches/${batchId}/results`, {
    headers: BATCH_HEADERS,
  });
  if (!res.ok) throw new Error(`Batch results failed (${res.status})`);
  // Results are JSONL — one JSON object per line
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Poll until batch processing_status === "ended" */
async function waitForBatch(batchId) {
  process.stdout.write(`  Polling batch ${batchId}...\n`);
  while (true) {
    const batch = await getBatch(batchId);
    const { processing_status, request_counts } = batch;
    const { processing, succeeded, errored, expired, canceled } = request_counts || {};
    process.stdout.write(
      `  [${new Date().toISOString()}] status=${processing_status}  processing=${processing} succeeded=${succeeded} errored=${errored}\n`,
    );
    if (processing_status === "ended") return batch;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ─── Build prompt for one store ───────────────────────────────────────────────

const SYSTEM = buildSystemPrompt();

function buildDiscoverRequest(customId, crawl) {
  const host = new URL(crawl.base).host;
  const lines = [
    "Find selectors for this store per detections-context-agent.md.",
    "",
    `Store: ${host}`,
    `Base: ${crawl.base}`,
    `PDP: /products/${crawl.handle}`,
    `Has cart drawer: ${crawl.hasDrawer ? "YES" : "NO"}`,
    "",
    buildFocusHtml(crawl),
    "",
    "Return per-key reasoning, then end with ```json block (all 8 keys). Required keys MUST be non-empty theme-native selectors — never return \"\" except cart-drawer keys when Has cart drawer is NO.",
  ];
  const userText = lines.join("\n");

  return {
    custom_id: customId,
    params: {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // System prompt cached — same across all stores
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      // User message (focus HTML) also cached per request
      messages: [{
        role: "user",
        content: [{ type: "text", text: userText, cache_control: { type: "ephemeral" } }],
      }],
    },
  };
}

// ─── Scoring (reused from eval.mjs logic) ────────────────────────────────────

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return { html, doc: parseHTML(html).document };
  } catch { return null; }
}

async function fetchStoreDocs(storeUrl) {
  const [homeResult, cartResult] = await Promise.all([
    fetchPage(`https://${storeUrl}/`),
    fetchPage(`https://${storeUrl}/cart`),
  ]);

  const docs = { home: homeResult?.doc ?? null, pdp: null, cart: cartResult?.doc ?? null };

  // Find first product from home
  if (docs.home) {
    const links = [...docs.home.querySelectorAll('a[href*="/products/"]')];
    for (const link of links.slice(0, 5)) {
      const href = link.getAttribute("href") || "";
      if (!href || href.includes("?") || href.endsWith("/products/")) continue;
      const pdpUrl = href.startsWith("http") ? href : `https://${storeUrl}${href}`;
      const r = await fetchPage(pdpUrl);
      if (r?.doc) { docs.pdp = r.doc; break; }
    }
  }

  return docs;
}

const KEY_DOC = {
  "product-form-selector": "pdp",
  "home-page-cvb": "home",
  "product-page-cvb": "pdp",
  "cart-drawer-cvb": "home",
  "cart-page-discount-code": "cart",
  "cart-page-cvb": "cart",
  "cart-icon": "home",
  "cart-drawer-discount-code": "home",
};

function domEquivalent(doc, got, expected) {
  if (!doc) return { pass: got === expected, reason: "doc unavailable — string fallback", domChecked: false };

  let gotEl = null, expEl = null;
  try { gotEl = doc.querySelector(got || "__nomatch__"); } catch { /* invalid selector */ }
  try { expEl = doc.querySelector(expected || "__nomatch__"); } catch { /* invalid selector */ }

  if (!gotEl && !expEl) {
    const exactMatch = got === expected;
    return { pass: true, reason: exactMatch ? "both match nothing — string match" : "both match nothing — unverifiable (soft pass)", domChecked: false, softPass: !exactMatch };
  }
  if (!gotEl || !expEl) return { pass: false, reason: gotEl ? "got matches but expected doesn't" : "expected matches but got doesn't", domChecked: true };

  const same = gotEl.isSameNode(expEl);
  return { pass: same, reason: same ? "same DOM element ✓" : "different DOM elements", domChecked: true };
}

function scoreSelectors(got, expected, docs) {
  const results = {};
  for (const key of KEYS) {
    const g = (got?.[key] ?? "").trim();
    const e = (expected[key] ?? "").trim();
    if (!g && !e) { results[key] = { got: g, expected: e, pass: true, reason: "both empty" }; continue; }
    if (g === e)  { results[key] = { got: g, expected: e, pass: true, reason: "exact match" }; continue; }
    if (!g || !e) { results[key] = { got: g, expected: e, pass: false, reason: "one empty" }; continue; }
    const docKey = KEY_DOC[key];
    const { pass, reason, domChecked, softPass } = domEquivalent(docs?.[docKey] ?? null, g, e);
    results[key] = { got: g, expected: e, pass, reason, domChecked, softPass };
  }
  return results;
}

function pad(str, n) { return String(str).padEnd(n); }

function printStoreResult(storeUrl, comparison) {
  const passed = Object.values(comparison).filter((r) => r.pass).length;
  const total = KEYS.length;
  console.log(`\n  Results: ${passed}/${total} keys match`);
  console.log(`  ${pad("Key", 30)} Pass   Got vs Expected`);
  console.log(`  ${"─".repeat(80)}`);
  for (const key of KEYS) {
    const { got: g, expected: e, pass, reason, domChecked, softPass } = comparison[key];
    const icon = pass ? "✓" : "✗";
    const tag = domChecked === true ? " [dom]" : softPass ? " [str?]" : domChecked === false ? " [str]" : "";
    console.log(`  ${icon} ${pad(key, 30)}${tag}`);
    if (!pass) {
      console.log(`      got:      ${g || "(empty)"}`);
      console.log(`      expected: ${e || "(empty)"}`);
      if (reason) console.log(`      reason:   ${reason}`);
    }
  }
  return { passed, total };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const filtered = storeFilter
  ? STORES.filter((s) => s.url.includes(storeFilter))
  : STORES;

if (filtered.length === 0) {
  console.error(`No stores match filter: ${storeFilter}`);
  process.exit(1);
}

console.log(`\nDetections Agent — Batch Eval`);
console.log(`Stores: ${filtered.length}  Model: ${MODEL}  Corrections: ${noCorrections ? "off" : "on (1 pass)"}`);
console.log(`${"═".repeat(70)}`);

// ── Phase 1: Crawl all stores in parallel ─────────────────────────────────────

let crawls; // Map<storeUrl, crawlResult>

if (!resumeBatchId) {
  console.log(`\n[Phase 1] Crawling ${filtered.length} stores in parallel...`);
  const crawlResults = await Promise.allSettled(
    filtered.map(async (store) => {
      const crawl = await crawlStorefront(store.url, "", null);
      return { url: store.url, crawl };
    }),
  );

  crawls = new Map();
  for (let i = 0; i < filtered.length; i++) {
    const r = crawlResults[i];
    const store = filtered[i];
    if (r.status === "fulfilled") {
      crawls.set(store.url, r.value.crawl);
      console.log(`  ✓ ${store.url}`);
    } else {
      console.log(`  ✗ ${store.url} — crawl failed: ${r.reason?.message}`);
    }
  }

  // ── Phase 2: Submit batch ───────────────────────────────────────────────────

  const requests = [];
  for (const store of filtered) {
    const crawl = crawls.get(store.url);
    if (!crawl) continue;
    requests.push(buildDiscoverRequest(store.url, crawl));
  }

  if (requests.length === 0) {
    console.error("No stores crawled successfully — nothing to batch.");
    process.exit(1);
  }

  console.log(`\n[Phase 2] Submitting batch of ${requests.length} requests...`);
  const batch = await createBatch(requests);
  console.log(`  Batch ID: ${batch.id}`);
  console.log(`  To resume later: node scripts/eval-batch.mjs --resume ${batch.id}`);

  await waitForBatch(batch.id);

  // ── Phase 3: Fetch results ──────────────────────────────────────────────────

  console.log(`\n[Phase 3] Fetching results...`);
  const rawResults = await getBatchResults(batch.id);

  // ── Phase 4: Score and print ────────────────────────────────────────────────

  console.log(`\n[Phase 4] Scoring results...`);

  const storeResults = [];
  const needsCorrection = []; // stores where ≥1 key failed

  // Fetch DOM pages for all stores in parallel for scoring
  console.log(`  Fetching DOM pages for comparison...`);
  const docsMap = new Map(
    await Promise.all(
      filtered.map(async (s) => [s.url, await fetchStoreDocs(s.url)])
    )
  );

  for (const row of rawResults) {
    const storeUrl = row.custom_id;
    const store = filtered.find((s) => s.url === storeUrl);
    if (!store) continue;

    console.log(`\n${"─".repeat(70)}`);
    console.log(`Store: ${storeUrl}`);

    if (row.result?.type === "error") {
      console.log(`  ❌ API error: ${row.result.error?.message}`);
      storeResults.push({ url: storeUrl, status: "error", reason: row.result.error?.message });
      continue;
    }

    const text = (row.result?.message?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const usage = row.result?.message?.usage || {};
    console.log(`  Tokens: in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`);

    const selectors = parseLlmJson(text);
    if (!selectors) {
      console.log(`  ❌ Could not parse JSON from response`);
      storeResults.push({ url: storeUrl, status: "error", reason: "parse failed" });
      continue;
    }

    const docs = docsMap.get(storeUrl);
    const comparison = scoreSelectors(selectors, store.selectors, docs);
    const { passed, total } = printStoreResult(storeUrl, comparison);

    const allPassed = passed === total;
    storeResults.push({ url: storeUrl, status: allPassed ? "pass" : "fail", passed, total, comparison, selectors });
    if (!allPassed) needsCorrection.push({ store, crawl: crawls?.get(storeUrl), firstPassSelectors: selectors });
  }

  // ── Phase 5 (optional): Correction batch ─────────────────────────────────────

  if (!noCorrections && needsCorrection.length > 0 && crawls) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`[Phase 5] Correction pass for ${needsCorrection.length} store(s)...`);

    const correctionRequests = needsCorrection
      .filter((n) => n.crawl)
      .map(({ store, crawl, firstPassSelectors }) => {
        const failedKeys = KEYS.filter((k) => {
          const r = storeResults.find((s) => s.url === store.url)?.comparison?.[k];
          return r && !r.pass;
        });

        const correctionText = [
          `Previous attempt failed on: ${failedKeys.join(", ")}.`,
          `Previous selectors:`,
          JSON.stringify(firstPassSelectors, null, 2),
          ``,
          `Re-examine the HTML carefully and fix the failing keys.`,
          ``,
          buildFocusHtml(crawl),
          ``,
          `Return corrected reasoning then end with \`\`\`json block (all 8 keys).`,
        ].join("\n");

        return {
          custom_id: `correction::${store.url}`,
          params: {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: correctionText, cache_control: { type: "ephemeral" } }],
              },
            ],
          },
        };
      });

    if (correctionRequests.length > 0) {
      const corrBatch = await createBatch(correctionRequests);
      console.log(`  Correction batch ID: ${corrBatch.id}`);
      await waitForBatch(corrBatch.id);
      const corrResults = await getBatchResults(corrBatch.id);

      console.log(`\n  Correction results:`);
      for (const row of corrResults) {
        const storeUrl = row.custom_id.replace("correction::", "");
        const store = filtered.find((s) => s.url === storeUrl);
        if (!store) continue;

        console.log(`\n${"─".repeat(70)}`);
        console.log(`Store: ${storeUrl} (correction)`);

        if (row.result?.type === "error") {
          console.log(`  ❌ ${row.result.error?.message}`);
          continue;
        }

        const text = (row.result?.message?.content || [])
          .filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

        const selectors = parseLlmJson(text);
        if (!selectors) { console.log(`  ❌ Could not parse JSON`); continue; }

        const docs = docsMap.get(storeUrl);
        const comparison = scoreSelectors(selectors, store.selectors, docs);
        const { passed, total } = printStoreResult(storeUrl, comparison);

        // Update result
        const prev = storeResults.find((r) => r.url === storeUrl);
        if (prev) {
          prev.status = passed === total ? "pass" : "fail";
          prev.passed = passed;
          prev.total = total;
          prev.comparison = comparison;
          prev.corrected = true;
        }
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  const ran = storeResults.filter((r) => r.status !== "skipped");
  const passed = storeResults.filter((r) => r.status === "pass");
  const failed = storeResults.filter((r) => r.status === "fail" || r.status === "error");

  console.log(`\n${"═".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Total:   ${storeResults.length}`);
  console.log(`Pass:    ${passed.length}/${ran.length} stores (all 8 keys correct)`);

  if (ran.length) {
    const totalKeys = ran.reduce((s, r) => s + (r.total || 0), 0);
    const passedKeys = ran.reduce((s, r) => s + (r.passed || 0), 0);
    console.log(`Keys:    ${passedKeys}/${totalKeys} (${Math.round((passedKeys / totalKeys) * 100)}%)`);
  }

  if (failed.length) {
    console.log(`\nFailed stores:`);
    for (const r of failed) {
      const pct = r.total ? `${r.passed}/${r.total}` : "error";
      console.log(`  ✗ ${r.url} — ${pct}${r.corrected ? " (after correction)" : ""}`);
    }

    const keyFailCounts = {};
    for (const key of KEYS) keyFailCounts[key] = 0;
    for (const r of ran) {
      if (!r.comparison) continue;
      for (const key of KEYS) {
        if (!r.comparison[key]?.pass) keyFailCounts[key]++;
      }
    }
    console.log(`\nKey failure counts (out of ${ran.length} stores):`);
    for (const key of KEYS) {
      const n = keyFailCounts[key];
      if (n > 0) console.log(`  ${pad(key, 32)} ${n} failure(s)`);
    }
  }

  console.log();
} else {
  // ── Resume mode: just fetch results from an existing batch ID ────────────────
  console.log(`\n[Resume] Fetching results for batch ${resumeBatchId}...`);
  const batch = await getBatch(resumeBatchId);
  if (batch.processing_status !== "ended") {
    console.log(`Batch is not complete yet (status: ${batch.processing_status}). Waiting...`);
    await waitForBatch(resumeBatchId);
  }

  const rawResults = await getBatchResults(resumeBatchId);
  console.log(`Got ${rawResults.length} result(s). Re-run without --resume to get full scoring with DOM comparison.`);

  for (const row of rawResults) {
    const storeUrl = row.custom_id;
    console.log(`\n${"─".repeat(70)}`);
    console.log(`Store: ${storeUrl}`);
    if (row.result?.type === "error") {
      console.log(`  ❌ ${row.result.error?.message}`);
      continue;
    }
    const usage = row.result?.message?.usage || {};
    console.log(`  Tokens: in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0}`);

    const text = (row.result?.message?.content || [])
      .filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const selectors = parseLlmJson(text);
    if (!selectors) { console.log(`  ❌ Could not parse JSON`); continue; }

    const store = filtered.find((s) => s.url === storeUrl);
    if (!store) { console.log(`  ⚠️  Store not found in eval set`); continue; }

    const docs = await fetchStoreDocs(storeUrl);
    const comparison = scoreSelectors(selectors, store.selectors, docs);
    printStoreResult(storeUrl, comparison);
  }
}
