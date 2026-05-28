/**
 * LLM agent.
 *
 * Pipeline:
 *   1. Crawl the storefront (lib/agent-crawl.mjs) — fresh on every call.
 *   2. Compact each surface's HTML so it fits in the model context.
 *   3. Send a single request to Anthropic Claude with:
 *        - the rules from detections-context-agent.md (system prompt)
 *        - the compacted scraped HTML (user message)
 *      and ask it to return a JSON object with the 8 selectors.
 *   4. Verifier agent fixes failed keys one-by-one until all pass DOM verify.
 *   5. Emit progress events (scrape steps, discover, verifier, per-key verify).
 *
 * Configuration (env or per-request override):
 *   ANTHROPIC_API_KEY       — required
 *   ANTHROPIC_MODEL         — model slug (defaults to "claude-opus-4-6")
 *   ANTHROPIC_BASE_URL      — defaults to "https://api.anthropic.com"
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crawlStorefront, DRAWER_ROOTS_QUERY } from "./agent-crawl.mjs";
import { formatOutputJs } from "./format-output.mjs";
import { learnFromFeedback } from "./agent-learn.mjs";

const DEFAULT_MODEL = "claude-opus-4-6";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const MAX_LLM_ATTEMPTS = 1;
const VERIFIER_ENABLED = true;
const RETRY_DELAY_MS = 12_000;
const FOCUS_MAX_BYTES = 8000;
const DRAWER_MAX_BYTES = 12000;

const DRAWER_KEYS = new Set(["cart-drawer-cvb", "cart-drawer-discount-code"]);

/** Keys that MUST be non-empty in the final output for this crawl. */
function mandatoryKeys(hasDrawer) {
  if (hasDrawer) return [...SELECTOR_KEYS];
  return SELECTOR_KEYS.filter((k) => !DRAWER_KEYS.has(k));
}

function emptyAllowed(key, hasDrawer) {
  return !hasDrawer && DRAWER_KEYS.has(key);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_DOC_PATH = resolve(__dirname, "..", "detections-context-agent.md");

let cachedContextDoc = null;
export function invalidateContextDocCache() {
  cachedContextDoc = null;
}
function loadContextDoc() {
  if (cachedContextDoc != null) return cachedContextDoc;
  try {
    cachedContextDoc = readFileSync(CONTEXT_DOC_PATH, "utf8");
  } catch (e) {
    throw new Error(
      `Could not read ${CONTEXT_DOC_PATH}. The LLM agent runs the same procedure I do — it needs this doc as its system prompt.`,
    );
  }
  return cachedContextDoc;
}

const SELECTOR_KEYS = [
  "product-form-selector",
  "home-page-cvb",
  "product-page-cvb",
  "cart-drawer-cvb",
  "cart-page-discount-code",
  "cart-page-cvb",
  "cart-icon",
  "cart-drawer-discount-code",
];

/* ============================================================================
 * HTML compaction — strip CSS/JS/SVG/comments, truncate long text + image
 * srcs so the model sees only structural markup.
 * ========================================================================= */

const STRIP_TAGS = new Set([
  "script",
  "style",
  "link",
  "noscript",
  "svg",
  "template",
  "meta",
  "iframe",
]);

function compactNode(node, opts) {
  if (!node) return;
  const removed = [];
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8 /* COMMENT */) {
      removed.push(child);
      continue;
    }
    if (child.nodeType === 1 /* ELEMENT */) {
      const tag = (child.tagName || "").toLowerCase();
      if (STRIP_TAGS.has(tag)) {
        removed.push(child);
        continue;
      }
      // Shorten long src/srcset on media tags (long CDN urls eat tokens)
      if (tag === "img" || tag === "source" || tag === "picture") {
        for (const a of ["src", "srcset", "data-src", "data-srcset"]) {
          const v = child.getAttribute?.(a);
          if (v && v.length > 80) child.setAttribute(a, "<…>");
        }
      }
      // Strip inline style="..." (always large, never useful for selector picking)
      if (child.getAttribute?.("style")) child.removeAttribute("style");
      compactNode(child, opts);
    } else if (child.nodeType === 3 /* TEXT */) {
      const text = (child.textContent || "").trim();
      if (text.length > opts.maxText) {
        child.textContent = text.slice(0, opts.maxText) + "…";
      } else if (text.length === 0) {
        // collapse whitespace-only text nodes (keeps output tidy)
        if (child.textContent.length > 1) child.textContent = "";
      }
    }
  }
  for (const r of removed) r.remove();
}

function compactDocHtml(doc, { maxText = 120, maxBytes = 90000, scopeSelectors = [] } = {}) {
  if (!doc) return "";
  // pick a scope to clone (full document or specific element)
  let root = null;
  for (const sel of scopeSelectors) {
    try {
      root = doc.querySelector(sel);
      if (root) break;
    } catch {
      /* ignore */
    }
  }
  if (!root) root = doc.body || doc.documentElement;
  if (!root) return "";
  const clone = root.cloneNode(true);
  compactNode(clone, { maxText });
  let html = clone.outerHTML || "";
  if (html.length > maxBytes) {
    html = html.slice(0, maxBytes) + `\n<!-- truncated, original ${html.length} bytes -->`;
  }
  return html;
}

/* ============================================================================
 * Prompt building
 * ========================================================================= */

/**
 * The system prompt is the ACTUAL detections-context-agent.md doc verbatim,
 * with a short preamble explaining the environment (LLM agent reading scraped
 * HTML, can't run shell). This is the exact same procedure a human / Cursor
 * agent follows when asked "find selectors for <store>".
 */
function buildSystemPrompt() {
  const doc = loadContextDoc();
  return [
    "You are the detections-agent. Follow detections-context-agent.md (below) exactly.",
    "The host crawled the store and sends compacted HTML excerpts. Pick theme-native CSS selectors for all 8 keys.",
    "Host verifies each selector on live DOM; failed keys trigger one retry with failure reasons.",
    "End with a single ```json block — 8 keys, canonical order, double quotes inside CSS attribute values.",
    "",
    "================ BEGIN detections-context-agent.md ================",
    doc,
    "================ END detections-context-agent.md ================",
  ].join("\n");
}

function compactHomeHero(crawl) {
  return compactDocHtml(crawl.homeDoc, {
    scopeSelectors: ["slide-show", "slideshow-component", "full-width-slider", "#main", "div#main", "main"],
    maxBytes: FOCUS_MAX_BYTES,
  });
}

function compactHeader(crawl) {
  return compactDocHtml(crawl.homeDoc, {
    scopeSelectors: ["header", "store-header", "header-component", ".header", ".header__inner"],
    maxBytes: FOCUS_MAX_BYTES,
  });
}

function compactPdpProduct(crawl) {
  return compactDocHtml(crawl.pdpDoc, {
    scopeSelectors: [
      ".product",
      '[data-section-type="main-product"]',
      "product-info",
      "#main",
      "div#main",
      "main",
    ],
    maxBytes: FOCUS_MAX_BYTES,
  });
}

function compactCartMain(crawl) {
  return compactDocHtml(crawl.cartDoc, {
    scopeSelectors: [
      "main#MainContent",
      "main",
      "body.template-cart",
      'form[action="/cart"]',
      "form#cart",
    ],
    maxBytes: FOCUS_MAX_BYTES,
  });
}

function compactDrawer(crawl) {
  if (!crawl.hasDrawer) return "";
  return compactDocHtml(crawl.drawerDoc, {
    scopeSelectors: [
      "[data-cart-drawer]",
      "cart-drawer",
      ".cart-drawer",
      ".quick-cart",
      "mini-cart",
      "#mini-cart",
      "form.mini-cart",
      "[data-section-type='quick-cart']",
      "[x-show='cart_drawer']",
      "[data-cart-items]",
    ],
    maxBytes: DRAWER_MAX_BYTES,
  });
}

/** Surfaces needed per selector key — verifier sends only these (saves TPM). */
const KEY_HTML_SURFACES = {
  "product-form-selector": ["pdp"],
  "home-page-cvb": ["home"],
  "product-page-cvb": ["pdp"],
  "cart-drawer-cvb": ["drawer"],
  "cart-page-discount-code": ["cart"],
  "cart-page-cvb": ["cart"],
  "cart-icon": ["header"],
  "cart-drawer-discount-code": ["drawer"],
};

function buildKeyFocusHtml(crawl, key) {
  const surfaces = KEY_HTML_SURFACES[key] || ["home", "header", "pdp", "cart", "drawer"];
  const parts = [];
  for (const surface of surfaces) {
    if (surface === "home") parts.push(`=== HOME hero ===\n${compactHomeHero(crawl) || "(none)"}`);
    else if (surface === "header") parts.push(`=== HEADER ===\n${compactHeader(crawl) || "(none)"}`);
    else if (surface === "pdp") parts.push(`=== PDP product + form ===\n${compactPdpProduct(crawl) || "(none)"}`);
    else if (surface === "cart") parts.push(`=== /cart items + totals ===\n${compactCartMain(crawl) || "(none)"}`);
    else if (surface === "drawer") {
      const drawer = compactDrawer(crawl);
      parts.push(
        drawer
          ? `=== CART DRAWER ===\n${drawer}`
          : `=== CART DRAWER ===\n(none — emit "" for cart-drawer-cvb and cart-drawer-discount-code)`,
      );
    }
  }
  return parts.join("\n\n");
}

function buildFocusHtml(crawl) {
  const drawer = compactDrawer(crawl);
  const parts = [
    `=== HOME hero ===\n${compactHomeHero(crawl) || "(none)"}`,
    `=== HEADER ===\n${compactHeader(crawl) || "(none)"}`,
    `=== PDP product + form ===\n${compactPdpProduct(crawl) || "(none)"}`,
    `=== /cart items + totals ===\n${compactCartMain(crawl) || "(none)"}`,
  ];
  if (drawer) parts.push(`=== CART DRAWER ===\n${drawer}`);
  else parts.push(`=== CART DRAWER ===\n(none — emit "" for cart-drawer-cvb and cart-drawer-discount-code)`);
  return parts.join("\n\n");
}

function buildUserMessage(
  crawl,
  { correction = "", feedback = "", previousSelectors = null } = {},
) {
  const host = new URL(crawl.base).host;
  const note = String(feedback || "").trim();
  const isFollowUp = !correction && (!!note || previousSelectors);

  const lines = [
    correction
      ? correction
      : isFollowUp
        ? "User feedback below — fix selectors accordingly per detections-context-agent.md (recently updated from feedback if provided)."
        : "Find selectors for this store per detections-context-agent.md.",
    "",
    `Store: ${host}`,
    `Base: ${crawl.base}`,
    `PDP: /products/${crawl.handle}`,
    `Has cart drawer: ${crawl.hasDrawer ? "YES" : "NO"}`,
    `Required keys: ${mandatoryKeys(crawl.hasDrawer).join(", ")}`,
  ];

  if (previousSelectors && typeof previousSelectors === "object") {
    lines.push("", "=== PREVIOUS SELECTORS (revise these if the user asked) ===");
    lines.push(JSON.stringify(previousSelectors, null, 2));
    lines.push("");
  }

  if (note) {
    lines.push("=== USER FEEDBACK ===", note);
  }
  const hints = buildDomProbeHints(crawl);
  if (hints) lines.push("", hints);
  lines.push(
    "",
    buildFocusHtml(crawl),
    "",
    "Return per-key reasoning, then end with ```json block (8 keys).",
  );
  return lines.join("\n");
}

/* ============================================================================
 * Anthropic API call
 * ========================================================================= */

async function callClaude({ apiKey, model, baseUrl, system, messages, emit, maxRetries = 3 }) {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/messages`;
  const body = {
    model,
    max_tokens: 4096,
    system,
    messages,
  };
  const userBytes = messages.reduce(
    (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
  emit?.({
    type: "llm-request",
    model,
    url,
    systemBytes: system.length,
    userBytes,
    turn: messages.length,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      const message =
        json?.error?.message || json?.message || `Anthropic API error (HTTP ${res.status})`;
      const isRateLimit =
        res.status === 429 || /rate limit/i.test(message);
      if (isRateLimit && attempt < maxRetries) {
        const retryAfterSec = Number(res.headers.get("retry-after")) || 60;
        emit?.({
          type: "log",
          level: "warn",
          message: `Rate limited — waiting ${retryAfterSec}s before retry ${attempt + 1}/${maxRetries}…`,
        });
        await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
        continue;
      }
      const err = new Error(message);
      err.statusCode = res.status;
      err.payload = json;
      throw err;
    }

    const text = (json.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    emit?.({
      type: "llm-response",
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
      stopReason: json.stop_reason,
      bytes: text.length,
    });
    return { text, raw: json };
  }

  throw new Error("Anthropic API rate limit — retries exhausted");
}

/**
 * Strip the trailing ```json ...``` block (the structured answer) from the
 * model's reply so the reasoning prose can be logged on its own.
 */
function stripTrailingJsonBlock(text) {
  if (!text) return "";
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (!fenced.length) return text.trim();
  const last = fenced[fenced.length - 1];
  return (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
}

/**
 * Break long reasoning text into bite-sized chunks for the streaming log.
 * Splits on paragraph boundaries; falls back to hard line-length wrapping.
 */
function chunkReasoningForLog(text, maxParas = 8) {
  if (!text) return [];
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length <= maxParas) return paras;
  return paras.slice(0, maxParas).concat(`… (+${paras.length - maxParas} more reasoning paragraphs)`);
}

function parseLlmJson(text) {
  if (!text) return null;
  const s = text.trim();

  // Prefer the LAST fenced ```json ... ``` block (system prompt asks Claude to
  // end its reply with that block; any earlier fences would be HTML snippets it
  // quoted while reasoning).
  const fenced = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    const candidate = fenced[i][1].trim();
    if (!candidate.includes("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try outermost {...} inside this fence
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          /* keep looking */
        }
      }
    }
  }

  // Fallback: outermost {...} in the whole response
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ============================================================================
 * Verification of LLM output against live DOM
 * ========================================================================= */

const DYNAMIC_SECTION_RE = /shopify-section-template--\d+__/i;
// Only flag dynamic patterns inside id selectors / [id="…"] — not BEM class names
// like `.mini-cart__drawer-footer` (which contain `__drawer` but are theme-native).
const DYNAMIC_ID_IN_SELECTOR_RE =
  /#[^,\s]*(?:template--\d+__|--\d{5,}|\d{6,})|\[id[^=]*=["'][^"']*(?:template--\d+__|\d{6,})[^"']*["']\]/i;
const APP_INJECTED_RE = /mr-div-embedded|shopify-block-Aa[A-Za-z0-9]*.*(upsell_monk|monk_)/i;

function selectorSurfaceCheck(selector) {
  if (!selector) return null;
  if (DYNAMIC_SECTION_RE.test(selector)) return "dynamic-section-id";
  if (DYNAMIC_ID_IN_SELECTOR_RE.test(selector)) return "dynamic-id";
  if (APP_INJECTED_RE.test(selector)) return "app-injected";
  return null;
}

function countOf(doc, sel) {
  if (!doc || !sel) return -1;
  try {
    return doc.querySelectorAll(sel).length;
  } catch {
    return -1;
  }
}
function safeQuery(doc, sel) {
  if (!doc || !sel) return null;
  try {
    return doc.querySelector(sel);
  } catch {
    return null;
  }
}

/** Live DOM hints for common disambiguation issues. */
function buildDomProbeHints(crawl) {
  const { homeDoc, pdpDoc, cartDoc } = crawl;
  const hints = [];
  const h1 = countOf(homeDoc, 'header a[href="/cart"]');
  const p1 = countOf(pdpDoc, 'header a[href="/cart"]');
  if (h1 > 1 || p1 > 1) {
    hints.push(`cart-icon: header a[href="/cart"] home=${h1} pdp=${p1} — use :first-of-type if >1`);
  }
  const checkoutInForm = !!cartDoc.querySelector(
    'form[action="/cart"] [name="checkout"], form#cart [name="checkout"]',
  );
  const checkoutInMain = !!cartDoc.querySelector(
    'main [name="checkout"], main [class*="checkout"]',
  );
  if (!checkoutInForm && checkoutInMain) {
    hints.push(
      "cart-page-discount-code: checkout/totals are OUTSIDE form[action='/cart'] — scope to main (e.g. main [class*='border-t-section'], wrapper around input[name='checkout'])",
    );
  }
  if (crawl.hasDrawer) {
    hints.push(
      "cart-drawer keys: scope inside drawer root ([data-cart-drawer], cart-drawer, .quick-cart, etc.). Alpine themes often use [data-cart-items] for line items and [data-cart-footer] / [class*='border-t-section'] for totals inside the drawer.",
    );
    const { drawerDoc } = crawl;
    const nestedForms = countOf(drawerDoc, "#mini-cart .drawer__content form, mini-cart .drawer__content form");
    const directForms = countOf(drawerDoc, "#mini-cart .drawer__content > form, mini-cart .drawer__content > form");
    if (nestedForms > directForms && directForms === 1) {
      hints.push(
        "cart-drawer-cvb: descendant form matches multiple elements — use direct-child line-items form (.drawer__content > form) or line-item table/list container",
      );
    }
  }
  if (cartDoc.querySelector(".cart__content") && cartDoc.querySelector("form.cart__recap, form[action='/cart'].cart__recap")) {
    hints.push(
      'cart-page-cvb: line items live in .cart / .cart__content — form[action="/cart"] is often the .cart__recap checkout sidebar, not line items',
    );
  }
  return hints.length ? hints.join("\n") : "";
}

function countOutsideDrawer(doc, selector) {
  if (!doc || !selector) return -1;
  try {
    let count = 0;
    for (const el of doc.querySelectorAll(selector)) {
      if (!el.closest?.(DRAWER_ROOTS_QUERY)) count++;
    }
    return count;
  } catch {
    return -1;
  }
}

// Indicators that an element actually contains a totals/subtotal block.
// Loosened from the doc-strict list to also accept themes that use just
// "Total" (e.g. tegen says "Total Rs. 5,600.00 INR") or class names like
// .cart__total-container / .cart-page__total / cart-totals.
const TOTALS_BLOCK_SELECTORS =
  '.totals, .totals__subtotal, [data-cart-total], [data-block-subtotal], [class*="total-container"], [class*="cart-totals"], [class*="cart__total"], [class*="cart-page__total"], [class*="border-t-section"], cart-totals, cart-summary';
const TOTALS_TEXT_RE = /\b(Sub-?total|Estimated total|Order total|Grand total|Cart total|Total)\b/i;

// Money detector — currency symbol/code followed by digits, OR digits followed
// by a 3-letter ISO currency code. Captures formats like "$12.34", "€12,34",
// "₹5,600.00", "Rs. 5,600.00 INR", "12.34 USD", "USD 12.34".
const MONEY_RE =
  /(?:[\$€£¥₹₪₱₩₦₨฿]\s*[\d][\d.,]*|\b(?:Rs|USD|EUR|GBP|JPY|INR|AUD|CAD|SGD|HKD|NZD|CHF|SEK|NOK|DKK|MXN|BRL|ZAR|AED|SAR|THB|PHP|VND|IDR|MYR|KRW|TRY|PLN|CZK)\.?\s*[\d][\d.,]*|\b[\d][\d.,]*\s*(?:USD|EUR|GBP|JPY|INR|AUD|CAD|SGD|HKD|NZD|CHF|SEK|NOK|DKK|MXN|BRL|ZAR|AED|SAR|THB|PHP|VND|IDR|MYR|KRW|TRY|PLN|CZK)\b)/;

// A "checkout control" — the user-facing button/link that takes the buyer
// to checkout. Used as the second half of the relaxed totals-wrapper signal.
const CHECKOUT_CONTROL_SELECTORS =
  '[name="checkout"], button[name="checkout"], input[name="checkout"], [class*="checkout-button"], [class*="cart__checkout"], [class*="checkout-btn"], a[href*="/checkout"], button[is*="checkout"]';

const SITE_FOOTER_SELECTORS =
  ".shopify-section-group-footer-group, footer.section-footer, .section-footer";

function hasCheckoutControl(el) {
  if (!el) return false;
  if (el.matches?.(CHECKOUT_CONTROL_SELECTORS)) return true;
  return !!el.querySelector?.(CHECKOUT_CONTROL_SELECTORS);
}

function isSiteFooter(el) {
  return !!el?.closest?.(SITE_FOOTER_SELECTORS);
}

/** Cart page main content — not site footer, not drawer overlay. */
function isCartMainContent(el) {
  if (!el || isSiteFooter(el)) return false;
  if (el.closest?.(DRAWER_ROOTS_QUERY)) return false;
  return !!el.closest?.('main#MainContent, main, body.template-cart, [class*="template-cart"]');
}

function isTotalsWrapper(el) {
  if (!el) return false;
  if (el.querySelector?.(TOTALS_BLOCK_SELECTORS)) return true;
  const txt = (el.textContent || "").trim();
  if (TOTALS_TEXT_RE.test(txt)) return true;
  if (hasCheckoutControl(el) && MONEY_RE.test(txt)) return true;
  return false;
}

const LINE_ITEM_MARKERS =
  '.line-item-table, table.line-item, cart-items, line-item, [class*="line-item"], .cart__contents, [data-cart-items], .quick-cart__items';

function looksLikeLineItemsContainer(el) {
  if (!el) return false;
  if (el.querySelector?.(LINE_ITEM_MARKERS)) return true;
  if (el.matches?.(".cart, .cart__content, .cart__contents, .wt-cart__wrapper")) return true;
  return false;
}

function isCartRecapForm(el) {
  if (!el || el.tagName !== "FORM") return false;
  if (!(el.getAttribute("action") || "").includes("/cart")) return false;
  const cls = (el.className || "").toString();
  if (!/recap|checkout|aside|footer/i.test(cls)) return false;
  return !el.querySelector?.(".line-item-table, table.line-item, cart-items, line-item");
}

/** Drawer totals slot — inner footer block above price/recap/checkout, not the <footer> root. */
function isDrawerDiscountSlot(el) {
  if (!el) return false;
  if (el.tagName === "FOOTER") return false;
  if (isTotalsWrapper(el)) return true;
  const footerRoot = el.closest?.('footer, [class*="drawer-footer"], [class*="drawer__footer"]');
  if (!footerRoot || !el.closest?.(DRAWER_ROOTS_QUERY)) return false;
  for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
    const cls = (sib.className || "").toString();
    const txt = sib.textContent || "";
    if (
      MONEY_RE.test(txt) ||
      sib.querySelector?.(CHECKOUT_CONTROL_SELECTORS) ||
      /recap|total|subtotal|price|ostoskori|shipping/i.test(cls)
    ) {
      return true;
    }
  }
  return false;
}

function verify(selector, key, crawl) {
  if (selector === "") return { ok: true, note: "empty" };
  const banned = selectorSurfaceCheck(selector);
  if (banned) return { ok: false, reason: banned };

  const { homeDoc, pdpDoc, cartDoc, drawerDoc, hasDrawer } = crawl;

  switch (key) {
    case "product-form-selector": {
      const c = countOf(pdpDoc, selector);
      const h = countOf(homeDoc, selector);
      if (c !== 1) return { ok: false, reason: `pdp count ${c}` };
      if (h !== 0) return { ok: false, reason: `home count ${h} (must be 0)` };
      const el = safeQuery(pdpDoc, selector);
      if (!el || el.tagName !== "FORM")
        return { ok: false, reason: "not a form" };
      if (!(el.getAttribute("action") || "").includes("cart/add"))
        return { ok: false, reason: "no cart/add action" };
      return { ok: true };
    }
    case "home-page-cvb": {
      const h = countOf(homeDoc, selector);
      const p = countOf(pdpDoc, selector);
      if (h !== 1 || p !== 0) return { ok: false, reason: `home=${h} pdp=${p}` };
      return { ok: true };
    }
    case "product-page-cvb": {
      const h = countOf(homeDoc, selector);
      const p = countOf(pdpDoc, selector);
      if (h !== 0 || p !== 1) return { ok: false, reason: `home=${h} pdp=${p}` };
      const el = safeQuery(pdpDoc, selector);
      // The product container MUST wrap the cart-add form (the doc says so:
      // "Wraps gallery + title + variants + form"). Otherwise the agent has
      // picked the gallery / a sibling block.
      const form = el?.querySelector?.('form[action*="cart/add"]');
      if (!form) return { ok: false, reason: "does not contain cart-add form" };
      return { ok: true };
    }
    case "cart-drawer-cvb": {
      if (!hasDrawer) {
        if (selector === "") return { ok: true, note: "no drawer on theme" };
        return { ok: false, reason: "theme has no drawer" };
      }
      if (selector === "") return { ok: false, reason: "empty but drawer exists" };
      const c = countOf(drawerDoc, selector);
      const h = countOutsideDrawer(homeDoc, selector);
      const p = countOutsideDrawer(pdpDoc, selector);
      const cart = countOutsideDrawer(cartDoc, selector);
      if (c !== 1) return { ok: false, reason: `drawer count ${c}` };
      if (h !== 0 || p !== 0 || cart !== 0)
        return { ok: false, reason: `outside drawer: home=${h} pdp=${p} cart=${cart}` };
      const el = safeQuery(drawerDoc, selector);
      if (!el?.closest?.(DRAWER_ROOTS_QUERY))
        return { ok: false, reason: "matched outside drawer" };
      if (el.tagName === "FORM" && !el.querySelector?.("line-item, .line-item, [class*='line-item']")) {
        return {
          ok: false,
          reason: "form has no line items — use direct-child line-items form (.drawer__content > form) or line-item list container",
        };
      }
      if (!looksLikeLineItemsContainer(el) && !el?.querySelector?.(LINE_ITEM_MARKERS)) {
        return {
          ok: false,
          reason:
            "not a line-items container — empty drawer shell (#mini-cart / mini-cart tag) is invalid; target cart-items inside the populated drawer",
        };
      }
      return { ok: true };
    }
    case "cart-page-discount-code": {
      const c = countOf(cartDoc, selector);
      const h = countOf(homeDoc, selector);
      const p = countOf(pdpDoc, selector);
      if (c !== 1 || h !== 0 || p !== 0)
        return { ok: false, reason: `cart=${c} home=${h} pdp=${p}` };
      const el = safeQuery(cartDoc, selector);
      if (el?.closest?.(DRAWER_ROOTS_QUERY))
        return { ok: false, reason: "wrapper inside drawer" };
      if (!isCartMainContent(el))
        return { ok: false, reason: "not in cart main content (or in site footer)" };
      if (!isTotalsWrapper(el)) return { ok: false, reason: "not a totals wrapper" };
      return { ok: true };
    }
    case "cart-page-cvb": {
      const c = countOf(cartDoc, selector);
      const h = countOf(homeDoc, selector);
      const p = countOf(pdpDoc, selector);
      if (c !== 1 || h !== 0 || p !== 0)
        return { ok: false, reason: `cart=${c} home=${h} pdp=${p}` };
      const el = safeQuery(cartDoc, selector);
      if (isCartRecapForm(el)) {
        return {
          ok: false,
          reason: 'matched cart recap/checkout form — use .cart, .cart__content, or line-item table container',
        };
      }
      if (!looksLikeLineItemsContainer(el)) {
        return { ok: false, reason: "does not look like a line-items container" };
      }
      return { ok: true };
    }
    case "cart-icon": {
      const h = countOf(homeDoc, selector);
      const p = countOf(pdpDoc, selector);
      if (h !== 1 || p !== 1) {
        const dupHint =
          h > 1 || p > 1
            ? " — duplicate cart links (common: separate desktop + mobile header rows); disambiguate with :first-of-type, .header__row-desktop, .header__row-mobile, or a unique class like .header__icon-touch"
            : "";
        return { ok: false, reason: `home=${h} pdp=${p}${dupHint}` };
      }
      const el = safeQuery(homeDoc, selector);
      if (el?.closest?.(DRAWER_ROOTS_QUERY))
        return { ok: false, reason: "matched inside drawer" };
      const href = (el?.getAttribute?.("href") || "").trim();
      if (href.includes("/cart/add")) return { ok: false, reason: "links to /cart/add" };
      return { ok: true };
    }
    case "cart-drawer-discount-code": {
      if (!hasDrawer) {
        if (selector === "") return { ok: true, note: "no drawer on theme" };
        return { ok: false, reason: "theme has no drawer" };
      }
      if (selector === "") return { ok: false, reason: "empty but drawer exists" };
      const c = countOf(drawerDoc, selector);
      const h = countOutsideDrawer(homeDoc, selector);
      const p = countOutsideDrawer(pdpDoc, selector);
      const cart = countOutsideDrawer(cartDoc, selector);
      if (c !== 1) return { ok: false, reason: `drawer count ${c}` };
      if (h !== 0 || p !== 0 || cart !== 0)
        return { ok: false, reason: `outside drawer: home=${h} pdp=${p} cart=${cart}` };
      const el = safeQuery(drawerDoc, selector);
      if (!el?.closest?.(DRAWER_ROOTS_QUERY))
        return { ok: false, reason: "wrapper outside drawer" };
      if (el.tagName === "FOOTER") {
        return {
          ok: false,
          reason: "matched <footer> root — pick inner block inside drawer footer above price/checkout (e.g. .mini-cart__actions, .cart__recap-block)",
        };
      }
      if (!isDrawerDiscountSlot(el)) {
        return {
          ok: false,
          reason: "not a drawer totals slot — pick inner footer block above price/recap/checkout, not the footer element itself",
        };
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: "unknown key" };
  }
}

/* ============================================================================
 * Apply + verify LLM JSON; build retry prompts for missing mandatory keys
 * ========================================================================= */

function applyAndVerify(parsed, crawl, emit) {
  const selectors = {};
  const details = {};

  for (const key of SELECTOR_KEYS) {
    const raw = typeof parsed[key] === "string" ? parsed[key].trim() : "";
    const v = verify(raw, key, crawl);
    details[key] = { llmRaw: raw, verify: v };

    if (raw === "" && emptyAllowed(key, crawl.hasDrawer)) {
      emit?.({ type: "log", level: "info", message: `  ${key}: (empty — no drawer on theme)` });
      selectors[key] = "";
    } else if (raw === "") {
      emit?.({ type: "log", level: "warn", message: `  ${key}: (empty — required for this theme)` });
      selectors[key] = "";
    } else if (v.ok) {
      emit?.({ type: "log", level: "info", message: `  ✓ ${key}: ${raw}` });
      selectors[key] = raw;
    } else {
      emit?.({
        type: "log",
        level: "warn",
        message: `  ✗ ${key}: rejected "${raw}" — ${v.reason}`,
      });
      selectors[key] = "";
    }
    emit?.({ type: "selector", key, value: selectors[key], llmRaw: raw, verify: v });
  }

  return { selectors, details };
}

function buildCorrectionMessage(crawl, selectors, details) {
  const required = mandatoryKeys(crawl.hasDrawer);
  const lines = [
    "Previous selectors failed verification. Fix all failures and return a complete ```json block.",
    `Has drawer: ${crawl.hasDrawer ? "YES" : "NO"}. Required: ${required.join(", ")}.`,
    "",
    "Failures:",
  ];

  for (const key of SELECTOR_KEYS) {
    const value = selectors[key];
    const { llmRaw, verify } = details[key] || {};
    const isRequired = required.includes(key);
    if (value) continue;
    if (!isRequired && emptyAllowed(key, crawl.hasDrawer)) continue;
    if (!llmRaw) {
      lines.push(`- ${key}: empty but required`);
    } else {
      lines.push(`- ${key}: "${llmRaw}" — ${verify?.reason || "verify failed"}`);
    }
  }
  return lines.join("\n");
}

function buildOutputPayload(storeUrl, crawl, selectors, { partial = false, missingKeys = [], elapsedMs = 0 } = {}) {
  const host = String(storeUrl).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const outputJs = `/** ${host} */\n${formatOutputJs(selectors)}\n`;
  return {
    selectors,
    outputJs,
    productUrl: crawl.productUrl,
    elapsedMs,
    partial,
    missingKeys,
  };
}

function buildBestEffortSelectors(crawl, verified, details, lastParsed) {
  const out = {};
  for (const key of SELECTOR_KEYS) {
    if (verified[key]) {
      out[key] = verified[key];
    } else if (emptyAllowed(key, crawl.hasDrawer)) {
      out[key] = "";
    } else {
      // Never surface unverified LLM guesses — only keys that passed DOM verify.
      out[key] = "";
    }
  }
  return out;
}

/* ============================================================================
 * Public entry point
 * ========================================================================= */

/**
 * @param {string} storeUrl
 * @param {string} password
 * @param {(e: object) => void} onEvent
 * @param {{ apiKey?: string, model?: string, baseUrl?: string, feedback?: string, previousSelectors?: Record<string,string>|null, learnFromFeedback?: boolean }} opts
 */
export async function runLlmAgent(storeUrl, password = "", onEvent = () => {}, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || "";
  const model = opts.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const baseUrl = opts.baseUrl || process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL;
  const feedback = String(opts.feedback || opts.agentMessage || "").trim();
  const previousSelectors =
    opts.previousSelectors && typeof opts.previousSelectors === "object"
      ? opts.previousSelectors
      : null;
  const shouldLearn = opts.learnFromFeedback !== false && !!feedback;
  if (!apiKey) {
    const err = new Error(
      "ANTHROPIC_API_KEY is missing. Pass it in the request body as `apiKey` or set the env var.",
    );
    err.statusCode = 400;
    throw err;
  }

  const emit = (e) => {
    try {
      onEvent({ ...e, ts: e.ts || Date.now() });
    } catch {
      /* swallow */
    }
  };

  const startedAt = Date.now();
  emit({ type: "log", level: "info", message: `Starting LLM agent (model=${model}) for ${storeUrl}` });
  if (feedback) {
    emit({ type: "log", level: "info", message: `User feedback: ${feedback.slice(0, 200)}${feedback.length > 200 ? "…" : ""}` });
  }

  const promptContext = { feedback, previousSelectors };

  if (shouldLearn) {
    emit({ type: "step", id: "learn", status: "running", message: "Updating detections-context-agent.md from feedback..." });
    try {
      await learnFromFeedback({
        feedback,
        storeUrl,
        previousSelectors,
        apiKey,
        model,
        baseUrl,
        emit,
      });
      invalidateContextDocCache();
      emit({ type: "step", id: "learn", status: "done", message: "Rules doc updated" });
    } catch (e) {
      emit({ type: "step", id: "learn", status: "failed", message: e.message || String(e) });
      emit({ type: "log", level: "warn", message: `Learn step failed: ${e.message} — continuing with existing rules` });
    }
  }

  let crawl;
  try {
    crawl = await crawlStorefront(storeUrl, password, emit);
  } catch (e) {
    emit({ type: "error", message: e.message || String(e) });
    throw e;
  }

  emit({ type: "step", id: "compact", status: "running", message: "Compacting scraped HTML for the LLM..." });
  const initialUser = buildUserMessage(crawl, promptContext);
  emit({
    type: "step",
    id: "compact",
    status: "done",
    message: `${initialUser.length.toLocaleString()} bytes prepared (~${Math.round(initialUser.length / 4)} tokens est.)`,
  });

  const system = buildSystemPrompt();
  emit({
    type: "log",
    level: "info",
    message: `System prompt: ${system.length.toLocaleString()} bytes (~${Math.round(system.length / 4)} tokens est.)`,
  });

  let messages = [{ role: "user", content: initialUser }];
  let selectors = {};
  let details = {};
  let lastParsed = null;

  // --- Discover agent: initial LLM pass for all 8 selectors ---
  {
    const userBytes = messages[0]?.content?.length || 0;
    emit({
      type: "log",
      level: "info",
      message: `Discover agent: ${userBytes.toLocaleString()} bytes (~${Math.round(userBytes / 4)} tokens est.)`,
    });
    emit({
      type: "step",
      id: "discover",
      status: "running",
      message: `Discover agent — asking Claude (${model})...`,
    });

    let llm;
    try {
      llm = await callClaude({
        apiKey,
        model,
        baseUrl,
        system,
        messages,
        emit: (e) => emit({ ...e, purpose: e.purpose || "discover" }),
      });
    } catch (e) {
      emit({ type: "step", id: "discover", status: "failed", message: e.message });
      emit({ type: "error", message: e.message });
      throw e;
    }

    emit({
      type: "step",
      id: "discover",
      status: "done",
      message: `Discover agent replied (${llm.text.length.toLocaleString()} bytes)`,
    });

    const reasoningOnly = stripTrailingJsonBlock(llm.text);
    if (reasoningOnly) emit({ type: "agent-reply", content: reasoningOnly });
    for (const chunk of chunkReasoningForLog(reasoningOnly)) {
      emit({ type: "log", level: "info", message: chunk });
    }

    lastParsed = parseLlmJson(llm.text);
    if (!lastParsed || typeof lastParsed !== "object") {
      const err = new Error("Discover agent could not parse JSON from Claude response.");
      err.statusCode = 502;
      err.rawResponse = llm.text;
      emit({ type: "error", message: err.message });
      throw err;
    }

    emit({
      type: "step",
      id: "verify",
      status: "running",
      message: "DOM verify — initial selectors from discover agent...",
    });
    ({ selectors, details } = applyAndVerify(lastParsed, crawl, emit));
  }

  // --- Verifier agent: retry failed keys until all pass DOM checks ---
  if (VERIFIER_ENABLED) {
    const { runVerifierAgent } = await import("./agent-verifier.mjs");
    const verifierResult = await runVerifierAgent(crawl, {
      initialSelectors: selectors,
      initialDetails: details,
      apiKey,
      model,
      baseUrl,
      emit,
    });
    selectors = verifierResult.selectors;
    details = verifierResult.details;

    emit({
      type: "step",
      id: "verify",
      status: verifierResult.allPassed ? "done" : "running",
      message: verifierResult.allPassed
        ? "All selectors verified"
        : `Verifier done — ${mandatoryKeys(crawl.hasDrawer).filter((k) => !selectors[k]).length} key(s) still failing`,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  const stillMissing = mandatoryKeys(crawl.hasDrawer).filter((k) => !selectors[k]);
  if (stillMissing.length) {
    const bestEffort = buildBestEffortSelectors(crawl, selectors, details, lastParsed);
    const partial = buildOutputPayload(storeUrl, crawl, bestEffort, {
      partial: true,
      missingKeys: stillMissing,
      elapsedMs,
    });
    emit({ type: "result", ...partial });
    emit({
      type: "log",
      level: "warn",
      message: `Partial result returned; unverified keys: ${stillMissing.join(", ")}`,
    });
    const err = new Error(
      `LLM could not produce valid selectors for required keys: ${stillMissing.join(", ")}`,
    );
    err.statusCode = 502;
    err.missingKeys = stillMissing;
    err.partialResult = partial;
    emit({ type: "error", message: err.message });
    throw err;
  }

  emit({ type: "step", id: "verify", status: "done", message: "Verification complete" });

  const result = buildOutputPayload(storeUrl, crawl, selectors, { elapsedMs });
  emit({ type: "result", ...result });
  emit({ type: "log", level: "info", message: `Done in ${elapsedMs} ms` });
  return result;
}

export {
  SELECTOR_KEYS,
  mandatoryKeys,
  emptyAllowed,
  verify,
  parseLlmJson,
  callClaude,
  buildSystemPrompt,
  buildFocusHtml,
  buildKeyFocusHtml,
  buildDomProbeHints,
  applyAndVerify,
  buildOutputPayload,
  buildBestEffortSelectors,
};
