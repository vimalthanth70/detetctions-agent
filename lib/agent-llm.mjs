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
 *   4. DOM-verify each selector on the crawled pages.
 *   5. Emit progress events (scrape steps, discover, verify).
 *
 * Configuration (env or per-request override):
 *   ANTHROPIC_API_KEY       — required
 *   ANTHROPIC_MODEL         — model slug (defaults to "claude-sonnet-4-6")
 *   ANTHROPIC_BASE_URL      — defaults to "https://api.anthropic.com"
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setDefaultResultOrder } from "node:dns";
// Force IPv4-first DNS resolution globally — fixes EHOSTUNREACH on IPv6-broken
// networks where api.anthropic.com's AAAA record is unreachable.
setDefaultResultOrder("ipv4first");

import { crawlStorefront, DRAWER_ROOTS_QUERY, isCloudflareChallenge } from "./agent-crawl.mjs";
import { formatOutputJs } from "./format-output.mjs";
import { learnFromFeedback } from "./agent-learn.mjs";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const MAX_CORRECTION_TURNS = 2;
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
  return compactDocHtml(effectiveHomeDoc(crawl), {
    scopeSelectors: ["slide-show", "slideshow-component", "full-width-slider", ".hero", ".banner", "#main", "div#main", "main"],
    maxBytes: FOCUS_MAX_BYTES,
  });
}

function compactHeader(crawl) {
  return compactDocHtml(effectiveHomeDoc(crawl), {
    scopeSelectors: ["header", "store-header", "header-component", ".header", ".header__inner", ".site-header"],
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
          "#FcDrawer",
          ".fc-drawer",
          "[data-section-id='custom-cart-drawer']",
          "cart-drawer-component",
          ".cart-drawer",
          "dialog.cart-drawer__dialog",
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

  const homeStatus = crawl.homeIsBlocked
    ? crawl.homeAfterAddDoc && !crawl.homeAfterAddIsBlocked
      ? "BLOCKED (Cloudflare) — hero/header HTML uses home-after-add-to-cart page"
      : crawl.drawerHtml
        ? "BLOCKED (Cloudflare) — hero/header HTML uses sections-API page"
        : "BLOCKED (Cloudflare) — home HTML unavailable"
    : "OK";

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
    `Home page status: ${homeStatus}`,
    `Required keys: ${mandatoryKeys(crawl.hasDrawer).join(", ")}`,
  ];

  if (previousSelectors && typeof previousSelectors === "object") {
    lines.push("", "=== PREVIOUS SELECTORS (revise these if the user asked) ===");
    lines.push(JSON.stringify(previousSelectors, null, 2));
    lines.push("");
  }

  if (note) {
    lines.push("=== USER FEEDBACK ===", note);
    lines.push(
      "If the user gave an exact selector for a key, copy it verbatim into your JSON for that key.",
    );
  }
  const hints = buildDomProbeHints(crawl);
  if (hints) lines.push("", "=== DOM HINTS ===", hints);
  const verified = buildVerifiedCandidateHints(crawl);
  if (verified) lines.push("", "=== VERIFIED CANDIDATES (prefer these) ===", verified);
  if (crawl.hasDrawer && effectiveHomeDoc(crawl)?.querySelector?.("cart-drawer-component, cart-icon")) {
    lines.push(
      "",
      "Horizon / Online Store 2.0: cart-icon element (not a[href='/cart']); cart-drawer-component + cart-items-component; drawer totals .cart-drawer__summary; cart page line items .cart-page__items.",
    );
  }
  lines.push(
    "",
    buildFocusHtml(crawl),
    "",
    "Return per-key reasoning, then end with ```json block (all 8 keys). Required keys MUST be non-empty theme-native selectors — never return \"\" except cart-drawer keys when Has cart drawer is NO.",
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
  const homeDoc = effectiveHomeDoc(crawl);
  const { pdpDoc, cartDoc } = crawl;
  const hints = [];

  // Cloudflare-blocked home page — warn the LLM
  if (crawl.homeIsBlocked) {
    const fallback = crawl.homeAfterAddDoc && !crawl.homeAfterAddIsBlocked
      ? "home-after-add"
      : crawl.drawerHtml
        ? "sections-API"
        : "unknown";
    hints.push(
      `⚠ Home page was blocked by Cloudflare — hero/header probes use the ${fallback} page as home reference. Treat it as the home page for hero and cart-icon discovery.`,
    );
  }

  // Non-standard ATC — warn the LLM when no standard form exists
  if (hasNoStandardAtcForm(pdpDoc)) {
    hints.push(
      "product-form-selector: PDP has NO form[action*='/cart/add'] — this is a JS-driven ATC theme. Use the main ATC button selector (e.g. button.add-cart, button[id*='AddToCart']) scoped inside the product container. product-page-cvb: the container does NOT need to contain a form.",
    );
  } else if (onlyAppInjectedAtcForms(pdpDoc)) {
    hints.push(
      "product-form-selector: All form[action*='/cart/add'] elements on PDP are app-injected catalog-card quick-buy forms — use the main ATC button instead. product-page-cvb: container only needs to hold the ATC button.",
    );
  }
  const h1 = countOf(homeDoc, 'header a[href$="/cart"]');
  const p1 = countOf(pdpDoc, 'header a[href$="/cart"]');
  if (h1 > 1 || p1 > 1) {
    hints.push(`cart-icon: header a[href$="/cart"] home=${h1} pdp=${p1} — use :first-of-type if >1`);
  }
  const hIcon = countOf(homeDoc, "cart-icon");
  const pIcon = countOf(pdpDoc, "cart-icon");
  if (hIcon === 1 && pIcon === 1 && h1 === 0 && p1 === 0) {
    hints.push("cart-icon: theme uses cart-icon web component — use cart-icon or cart-icon.header-actions__cart-icon");
  }
  if (countOf(homeDoc, ".cart-page__items") === 1 && countOf(pdpDoc, ".cart-page__items") === 0) {
    hints.push("cart-page-cvb: use .cart-page__items (Horizon cart page line items)");
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
      "cart-drawer keys: scope inside drawer root (cart-drawer-component, [data-cart-drawer], cart-drawer, .quick-cart, etc.). Horizon: cart-drawer-component cart-items-component + .cart-drawer__summary.",
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
  if (countOf(homeDoc, "main .shopify-section:first-of-type") === 1 && countOf(pdpDoc, "main .shopify-section:first-of-type") === 1) {
    hints.push(
      "home-page-cvb: first main .shopify-section matches home AND pdp — do NOT use it. Pick a home-only hero class (e.g. .fastslider-section, slide-show, .hero, .banner) or first section block unique to home.",
    );
  }
  if (countOf(pdpDoc, 'form[action*="/cart/add"]') > 1) {
    hints.push(
      "product-form-selector: PDP has multiple cart/add forms — use form[action*='/cart/add'].product-form or :not([id*='installment'])",
    );
  }
  if (countOf(cartDoc, "main-cart.cart__content") === 1) {
    hints.push("cart-page-cvb: main-cart.cart__content; cart-page-discount-code: main-cart .cart__sidebar");
  }
  if (crawl.homeDoc?.querySelector?.("cart-drawer cart-items")) {
    hints.push(
      "cart-drawer-cvb: cart-drawer cart-items; cart-drawer-discount-code: cart-drawer .drawer__footer .grid.grid-cols-2.gap-4 (inner block inside .drawer__footer, not the footer root)",
    );
  }
  if (
    countOf(homeDoc, '.header__icons .header__buttons a[href$="/cart"]') >= 1 &&
    countOf(pdpDoc, '.header__icons .header__buttons a[href$="/cart"]') >= 1
  ) {
    hints.push(
      "cart-icon: .header__icons .header__buttons a[href$='/cart'] — often 2 matches (desktop + mobile); that is valid",
    );
  }
  if (
    countOf(homeDoc, ".header__action-item-link.header__cart-toggle") >= 1 &&
    countOf(pdpDoc, ".header__action-item-link.header__cart-toggle") >= 1
  ) {
    hints.push(
      "cart-icon: Warehouse theme — use .header__action-item-link.header__cart-toggle (not bare a[href='/cart'] which can match footer/duplicate links)",
    );
  }
  if (countOf(cartDoc, ".cart-recap") === 1) {
    hints.push(
      "cart-page-discount-code: Warehouse — inner row .cart-recap .cart-recap__price-line (not outer .cart-recap root)",
    );
  }
  if (crawl.hasDrawer && countOf(crawl.drawerDoc, ".mini-cart__recap") === 1) {
    hints.push(
      "cart-drawer-discount-code: Warehouse — inner row .mini-cart__recap .mini-cart__recap-price-line (not outer .mini-cart__recap root)",
    );
  }
  if (crawl.homeDoc?.querySelector?.(".ajaxcart-draw, .js-cart-draw") || crawl.homeHtml?.includes?.("CartTemplate")) {
    hints.push(
      "cart-drawer-cvb: Venue ajax cart — .ajaxcart__products inside .ajaxcart-draw (from #CartTemplate); cart-drawer-discount-code: .ajaxcart__footer .ajaxcart__footer-total",
    );
  }
  // Archetype/Atlantic theme (e.g. Luxus): drawer is #sidebar-cart, items in .Cart__ItemList (AJAX)
  // footer is .Drawer__Footer; home hero may use ai-hero-video-banner app block
  if (crawl.homeDoc?.querySelector?.("#sidebar-cart") || crawl.homeHtml?.includes?.("id=\"sidebar-cart\"")) {
    hints.push(
      "cart-drawer-cvb: Archetype/Atlantic theme — drawer is #sidebar-cart; items in .Cart__ItemList inside Drawer__Main → use #sidebar-cart .Cart__ItemList",
      "cart-drawer-discount-code: Archetype/Atlantic theme — drawer footer is .Drawer__Footer inside #sidebar-cart (total embedded in checkout button, no separate subtotal row) → use #sidebar-cart .Drawer__Footer",
      "cart-page-discount-code: Archetype/Atlantic theme — subtotal/total element is .Cart__Total inside .Cart__Recap → use .Cart__Recap .Cart__Total (NOT the whole .Cart__Footer .Cart__Recap which also wraps the checkout button)",
      "home-page-cvb: if a video hero uses the AI hero video banner app block, the outermost element has class 'ai-hero-video-banner-<id>' (children have '__') → use [class*=\"ai-hero-video-banner\"]:not([class*=\"__\"])",
      "home-page-cvb: if an image hero uses the AI hero banner app block, the outermost element has class 'ai-hero-banner-<id>' (children have 'banner-image', 'banner-overlay', 'banner-content' in their class) → use [class*=\"ai-hero-banner\"]:not([class*=\"banner-image\"]):not([class*=\"banner-overlay\"]):not([class*=\"banner-content\"])",
    );
  }
  // Timber/ajaxcart theme: drawer is #CartDrawer, AJAX content injected into #CartContainer (.drawer__cart)
  // Cart page is server-rendered (not AJAX). #CartDrawerForm does NOT exist in this theme.
  if (crawl.homeDoc?.querySelector?.("#CartContainer") || crawl.homeHtml?.includes?.("CartContainer")) {
    hints.push(
      "cart-drawer-cvb: Timber/ajaxcart theme — AJAX content injected into #CartContainer inside #CartDrawer; items wrapper is .ajaxcart__inner → use #CartContainer .ajaxcart__inner",
      "cart-drawer-discount-code: Timber/ajaxcart theme — subtotal is first .grid--full child of .ajaxcart__footer inside #CartContainer → use #CartContainer .ajaxcart__footer > .grid--full (NOT .ajaxcart__footer itself which is the whole footer)",
      "cart-page-discount-code: Timber/ajaxcart theme — cart page is server-rendered; subtotal row is .cart__row--table inside the right totals column → use form.cart:not(.ajaxcart) .grid__item.large--five-twelfths .cart__row--table (use :not(.ajaxcart) to exclude the Handlebars template form that also has class 'cart')",
      "cart-page-cvb: Timber/ajaxcart theme — use form.cart:not(.ajaxcart) (the server-rendered cart form), NOT form.cart which also matches the Handlebars template form (class='cart ajaxcart') in the <script> tag",
      "#CartDrawerForm does NOT exist in this theme — never use #CartDrawerForm selectors here",
    );
  }
  if (/slidecarthq\.js|window\.SLIDECART/i.test(`${crawl.homeHtml || ""}${crawl.pdpHtml || ""}`)) {
    hints.push(
      "cart-drawer-cvb: SlideCartHQ app — .slidecarthq .items; cart-drawer-discount-code: .footer-row.amp-sc__footer-row--subtotal (subtotal row container with label + price)",
    );
  }
  return hints.length ? hints.join("\n") : "";
}

/** Probe live DOM for selectors that pass verify — steers LLM away from empty guesses. */
function buildVerifiedCandidateHints(crawl) {
  const noStandardForm = hasNoStandardAtcForm(crawl.pdpDoc) || onlyAppInjectedAtcForms(crawl.pdpDoc);

  const pools = {
    "home-page-cvb": [
      ".fastslider-section",
      // Artisan/custom themes: first shopify-section after header is the slideshow wrapper
      // (checked before .hero-wrapper since both can verify home=1,pdp=0 on the same store)
      ".container-background-image",
      // Wonder theme (wt-* classes): brands marquee section is home-only
      ".wt-brands__container",
      "#MainContent > section.hero-wrapper:first-child",
      ".hero-wrapper",
      "#MainContent > .shopify-section.hero-wrapper:first-child",
      ".hero",
      "slide-show",
      ".slideshow",
      '[data-section-type="slideshow-section"]',
      ".banner",
      "main .shopify-section:first-of-type .slideshow",
      // When hero .banner also appears on PDP, scope via adjacent preceding section
      ".scrolling-text-section + div .banner",
      ".scrolling-text-section + .shopify-section .banner",
      ".announcement-bar-section + div .banner",
      ".announcement-bar-section + .shopify-section .banner",
      // Archetype/Atlantic-style themes: AI hero video banner app block — outermost custom element
      // has class "ai-hero-video-banner-<id>" (no "__"), inner children all have "__" in class name
      '[class*="ai-hero-video-banner"]:not([class*="__"])',
      // AI hero image banner app block — outermost element has class "ai-hero-banner-<id>",
      // inner children have "banner-image", "banner-overlay", "banner-content" in class name
      '[class*="ai-hero-banner"]:not([class*="banner-image"]):not([class*="banner-overlay"]):not([class*="banner-content"])',
    ],
    "cart-icon": [
      "a.js-drawer-open-cart",
      '.header__icons .header__buttons a[href$="/cart"]',
      // iamota theme: desktop secondary nav cart link (more specific than mobile .header__link--cart)
      "a.mini-cart__header-link",
      ".header__action-item-link.header__cart-toggle",
      "cart-icon",
      "cart-icon.header-actions__cart-icon",
      "a.cart-drawer-button",
      '[data-testid="cart-icon"]',
      'button[data-option-target="Cart"]',
      'header a[href$="/cart"]',
      // Details/summary pattern (mini-cart trigger in Warehouse-style themes)
      'details:has(mini-cart) > summary',
      'details.cart-menu > summary',
    ],
    "product-page-cvb": [
      // Timber/Brooklyn/Debut themes: standard Shopify section wrapper for product template
      '[data-section-type="product-template"]',
      // Wonder theme
      ".wt-product__wrapper",
      // Yuva theme
      ".product-section",
    ],
    "product-form-selector": [
      // Standard form-based selectors (tried first)
      ...(noStandardForm
        ? []
        : [
            'form[id$="__main"]:not([id*="installment"])',
            'form[id$="__main"]:not([id*="Installment"])',
            '.product-section form[action*="/cart/add"]',
            'form#AddToCartForm',
            'form[action*="/cart/add"].product-form',
            'form[action*="/cart/add"]:not([id*="installment"])',
            'form[action*="/cart/add"]:not([id*="Installment"])',
            '.section-main-product form[action*="/cart/add"]',
            '.section-main-product form.product-form',
            'form[action="/cart/add"]',
          ]),
      // Non-standard JS-driven ATC buttons (only probed when no standard form exists)
      ...(noStandardForm
        ? [
            'button.add-cart',
            'button[id*="heroAddToCart"]',
            'button[id*="AddToCart"]',
            'button[class*="add-cart"]',
            'button[data-add-to-cart]',
            'button[name="add"]',
          ]
        : []),
    ],
    "cart-page-cvb": [
      "#CartPageForm [data-products]",
      ".cart__page-col[data-products]",
      ".cart-page__items",
      // Prestige theme: items container inside form.cart-page
      "form.cart-page .order-summary",
      ".order-summary",
      "main-cart.cart__content",
      ".cart-items",
      "form.cart-form .cart-items",
      ".cart__items",
      // Wonder theme: actual line-items list inside the cart page (empty in static HTML when cart is empty)
      ".wt-cart__list",
      // Timber/ajaxcart theme: server-rendered cart form — :not(.ajaxcart) excludes the
      // Handlebars template form (class="cart ajaxcart") that also lives on the same page
      "form.cart:not(.ajaxcart)",
      // Generic: items row container inside cart main area
      ".cart__main .cart__row",
    ],
    "cart-page-discount-code": [
      "#CartPageForm .cart__page-col:not([data-products]) .cart__item-sub.cart__item-row",
      ".cart-recap .cart-recap__price-line",
      ".cart-page__summary .cart__summary-totals",
      ".cart-page__summary .totals",
      "main-cart .cart__sidebar .totals",
      ".cart__sidebar .totals",
      // Aurora theme: cart-page custom element → cart-subtotal-block → inner totals heading
      "cart-page cart-subtotal-block .cart-subtotal__totals",
      ".cart-summary",
      // Wonder theme: subtotal container inside cart footer
      "#main-cart-footer .wt-cart__subtotal",
      // Yuva theme: subtotal li item inside cart-total-list
      ".cart-total-item[data-cart-total]",
      // Timber/ajaxcart theme (e.g. The Coffee Ride): server-rendered cart page — subtotal row
      // is the .grid--full.cart__row--table inside the right totals column.
      // Use :not(.ajaxcart) to exclude the Handlebars template form (class="cart ajaxcart")
      // which also exists on the same page inside a <script type="text/template"> tag.
      "form.cart:not(.ajaxcart) .grid__item.large--five-twelfths .cart__row--table",
      // Archetype/Atlantic theme: total price element inside .Cart__Recap
      ".Cart__Recap .Cart__Total",
      // Generic: subtotal container inside cart summary/sidebar
      ".cart__summary .cart-subtotal__container",
      ".cart-subtotal__container",
      // Generic: total element inside cart summary (more specific than the outer summary container)
      ".cart-page__summary .cart-summary__total",
      ".cart-summary__total",
    ],
    "cart-drawer-cvb": [
      "#CartDrawerForm [data-products]",
      "#CartDrawer cart-items",
      "cart-drawer cart-items",
      "#CartDrawer .cart__items",
      ".slidecarthq .items",
      ".ajaxcart__products",
      ".mini-cart__line-item-list",
      // Prefer inner items-only containers over the broad cart-items-component wrapper
      // (cart-items-component may include drawer header/title, not just line items)
      "cart-drawer-component .cart-items__wrapper",
      "cart-drawer-component .cart-items",
      "cart-drawer-component .cart-drawer__items",
      "cart-drawer-component cart-items-component",
      "cart-drawer cart-items",
      // cart-modal theme: items-only div inside scroll body (excludes modal-header and recommendation sections)
      "#CartModal-ScrollBody > div:not(.modal-header):not([class*='recommendation']):not([class*='complementary'])",
      "#CartModal-ScrollBody > div:not(.modal-header)",
      "#CartModal-ScrollBody",
      "#cart-modal #CartModal-ScrollBody",
      // Kalles / t4s theme: items inside [data-cart-wrapper] drawer
      "#t4s-mini_cart [data-cart-items]",
      "#t4s-mini_cart .t4s-cartPage__items",
      "[data-cart-wrapper] [data-cart-items]",
      // quick-cart / cart-flyout theme: AJAX-populated items container inside [data-cart-drawer]
      "[data-cart-drawer] .quick-cart__items",
      ".quick-cart__items",
      // Timber/ajaxcart theme: drawer content is AJAX-injected into #CartContainer (.drawer__cart)
      // inside #CartDrawer; the items wrapper is .ajaxcart__inner rendered inside #CartContainer
      "#CartContainer .ajaxcart__inner",
      // Archetype/Atlantic theme (e.g. Luxus): drawer is #sidebar-cart, items are in .Cart__ItemList
      // inside form.Cart.Drawer__Content > .Drawer__Main — AJAX-populated (empty in static HTML)
      "#sidebar-cart .Cart__ItemList",
    ],
    "cart-drawer-discount-code": [
      "#CartDrawerForm .drawer__footer .cart__item-sub.cart__item-row:not(.cart__discounts)",
      ".footer-row.amp-sc__footer-row--subtotal",
      ".footer-subtotal-wrapper .slidecart-subtotal",
      ".ajaxcart__footer .ajaxcart__footer-total",
      ".mini-cart__recap .mini-cart__recap-price-line",
      // Single-child footer pattern: first child of drawer summary is the totals slot
      "cart-drawer-component .cart-drawer__summary > :first-child",
      "cart-drawer-component .cart-drawer-summary",
      // cart-modal theme: first child of footer sibling (Total row, not the whole footer wrapper)
      "#CartModal-ScrollBody + div > div:first-child",
      "#CartModal-ScrollBody + div > :first-child",
      // Kalles / t4s theme: totals row inside drawer
      "#t4s-mini_cart .t4s-cart-total",
      "[data-cart-wrapper] .t4s-cart-total",
      // Wonder theme: subtotal container inside cart drawer
      "cart-drawer .wt-cart__subtotal",
      // Timber/ajaxcart theme: subtotal row (.grid--full first child of .ajaxcart__footer)
      // inside #CartContainer in the drawer — NOT .ajaxcart__footer itself (too broad, is the whole footer)
      "#CartContainer .ajaxcart__footer > .grid--full",
      // Archetype/Atlantic theme (e.g. Luxus): drawer footer inside #sidebar-cart —
      // contains total (embedded in checkout button) and taxes note; no separate subtotal row
      "#sidebar-cart .Drawer__Footer",
      // Generic: total element inside cart drawer summary
      ".cart-drawer__summary .cart-summary__total",
      ".cart-drawer-summary .cart-summary__total",
      "cart-drawer-component .cart-drawer__summary .cart-summary__total",
    ],
  };

  const hints = [];
  for (const [key, candidates] of Object.entries(pools)) {
    if (!crawl.hasDrawer && DRAWER_KEYS.has(key)) continue;
    for (const sel of candidates) {
      if (selectorSurfaceCheck(sel)) continue;
      const v = verify(sel, key, crawl);
      if (v.ok) {
        hints.push(`${key}: DOM-verified candidate → ${sel}`);
        break;
      }
    }
  }
  return hints.length ? hints.join("\n") : "";
}

/**
 * When the initial home fetch was blocked by a Cloudflare challenge, use the
 * home-after-add-to-cart page (fetched with session cookies already set, so CF
 * usually resolves) as the home reference.  Fall back to drawerDoc only when
 * both are unavailable or also blocked — but only if drawerDoc is different
 * from homeDoc (i.e., was actually resolved to a sections-API fragment).
 */
function effectiveHomeDoc(crawl) {
  if (!crawl.homeIsBlocked) return crawl.homeDoc;
  if (crawl.homeAfterAddDoc && !crawl.homeAfterAddIsBlocked) return crawl.homeAfterAddDoc;
  // Last resort: drawerDoc, but only when it was resolved to something real
  if (crawl.drawerDoc && crawl.drawerDoc !== crawl.homeDoc && crawl.drawerHtml) {
    return crawl.drawerDoc;
  }
  return crawl.homeDoc; // return the blocked doc — better than null
}

/**
 * True when the PDP has NO standard cart/add forms (i.e. the theme uses a
 * JS-driven ATC button rather than a classic HTML form submission).
 */
function hasNoStandardAtcForm(pdpDoc) {
  return countOf(pdpDoc, 'form[action*="/cart/add"]') === 0;
}

/**
 * True when all cart/add forms on the PDP are app-injected catalog-card quick-buy
 * forms (e.g. SBA theme), not the main product form.
 */
function onlyAppInjectedAtcForms(pdpDoc) {
  const total = countOf(pdpDoc, 'form[action*="/cart/add"]');
  if (total === 0) return false; // no forms at all → separate case
  const appForms = countOf(pdpDoc, 'form[action*="/cart/add"].sba-catalog-card__form, form[action*="/cart/add"][data-sba-catalog-form]');
  return appForms >= total;
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

/** Drawer markup often lives in home overlay HTML, not only the section API fragment. */
function queryDrawerElements(doc, selector) {
  if (!doc || !selector) return [];
  try {
    return [...doc.querySelectorAll(selector)].filter((el) =>
      el.closest?.(DRAWER_ROOTS_QUERY),
    );
  } catch {
    return [];
  }
}

function resolveDrawerElements(crawl, selector) {
  const order = [
    crawl.drawerDoc,
    crawl.homeAfterAddDoc,
    crawl.homeDoc,
    crawl.pdpDoc,
  ].filter(Boolean);
  for (const doc of order) {
    const els = queryDrawerElements(doc, selector);
    if (els.length) return { els, doc };
  }
  return { els: [], doc: crawl.drawerDoc };
}

function countOutsideDrawerContext(crawl, selector) {
  return (
    countOutsideDrawer(crawl.homeDoc, selector) +
    countOutsideDrawer(crawl.pdpDoc, selector) +
    countOutsideDrawer(crawl.cartDoc, selector)
  );
}

// Indicators that an element actually contains a totals/subtotal block.
// Loosened from the doc-strict list to also accept themes that use just
// "Total" (e.g. tegen says "Total Rs. 5,600.00 INR") or class names like
// .cart__total-container / .cart-page__total / cart-totals.
const TOTALS_BLOCK_SELECTORS =
  '.totals, .totals__subtotal, .totals__total, .totals__total-value, [data-cart-total], [data-block-subtotal], [class*="total-container"], [class*="cart-totals"], [class*="cart__total"], [class*="cart-page__total"], [class*="border-t-section"], cart-totals, cart-summary';
const TOTALS_TEXT_RE =
  /\b(Sub-?total|Subtotale|Totale|Zwischensumme|Gesamtsumme|Gesamtbetrag|Gesamt|Estimated total|Order total|Grand total|Cart total|Total|Ara Toplam|Toplam|Sous-total|Montant total|Totaal|Totale carrello)\b/i;

// Money detector — currency symbol/code followed by digits, OR digits followed
// by a 3-letter ISO currency code. Captures formats like "$12.34", "€12,34",
// "₹5,600.00", "Rs. 5,600.00 INR", "12.34 USD", "USD 12.34", "600€".
const MONEY_RE =
  /(?:[\$€£¥₹₪₱₩₦₨฿]\s*[\d][\d.,]*|\b(?:Rs|USD|EUR|GBP|JPY|INR|AUD|CAD|SGD|HKD|NZD|CHF|SEK|NOK|DKK|MXN|BRL|ZAR|AED|SAR|THB|PHP|VND|IDR|MYR|KRW|TRY|PLN|CZK)\.?\s*[\d][\d.,]*|\b[\d][\d.,]*\s*(?:USD|EUR|GBP|JPY|INR|AUD|CAD|SGD|HKD|NZD|CHF|SEK|NOK|DKK|MXN|BRL|ZAR|AED|SAR|THB|PHP|VND|IDR|MYR|KRW|TRY|PLN|CZK)\b|\b[\d][\d.,]*[\$€£¥₹])/;

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
  return !!el.closest?.(
    'main#MainContent, main, body.template-cart, body.page--cart, body.cart, [class*="template-cart"], .cart-section, .container.main',
  );
}

function isTotalsWrapper(el) {
  if (!el) return false;
  if (el.querySelector?.("[data-subtotal], [data-cart-subtotal]")) return true;
  if (el.querySelector?.(TOTALS_BLOCK_SELECTORS)) return true;
  const txt = (el.textContent || "").trim();
  if (TOTALS_TEXT_RE.test(txt)) return true;
  if (hasCheckoutControl(el) && MONEY_RE.test(txt)) return true;
  return false;
}

const LINE_ITEM_MARKERS =
  'cart-items-component, cart-items, .cart-items, .cart-page__items, .cart-drawer__items, .line-item-table, table.line-item, line-item, [class*="line-item"], .cart__contents, [data-cart-items], [data-products], .cart__items, .cart__item, .quick-cart__items, table.cart-items__table, .cart-items__table-row, .xo-cart-table, table.xo-table, div.main-cart, .xo-cart-mini-item, xo-product.xo-cart-mini-item, [xo-unique-id="xo-cart-mini-content"], .bls-items, ul.cart_items, .cart_items.js-cart_items, .cart-left_wrap, .cart__wrapper, [data-cart-item], .cartitems--container, .cartitems, ul.cartitems--list, [data-cart-item-list], .ajax-cart__items, .ajaxcart__products, .slidecarthq .items, [class*="CartItem"], .Cart__ItemList, [class*="cart-item" i], .cart-modal-item, [data-cart-item-index], .t4s-cartPage__items, [data-cart-items], [data-cart-item]';

function looksLikeLineItemsContainer(el) {
  if (!el) return false;
  if (el.matches?.("cart-items-component, cart-items, #FcItems, .fc-item, .cart-items, .cart-page__items, .cart-drawer__items, main-cart.cart__content, .xo-cart-table, div.main-cart, table.xo-table, [xo-unique-id='xo-cart-mini-content'], .bls-items, ul.cart_items, .cart_items.js-cart_items, .cart-left_wrap, .cart__wrapper, .cartitems--container, .cartitems, ul.cartitems--list, [data-cart-item-list], .ajax-cart__items, .ajaxcart__products, .slidecarthq .items, [data-products], .cart__items, .drawer__scrollable, .drawer__contents, .cart-drawer__line-items, .cart-drawer__content, .drawer__inner, #CartModal-ScrollBody, [id*='CartModal'][id*='Scroll'], [data-preserve-scroll], .t4s-cartPage__items, [data-cart-items]")) return true;
  // Themes that use data-cart-wrapper on the mini-cart outerbox (e.g. Fame theme).
  // Only match when the element is the cart content wrapper itself — not just a descendant.
  if (el.matches?.("[data-cart-wrapper], .minicart__outerbox, .minicart__box")) return true;
  // popup-cart theme: items container is AJAX-populated (empty in static HTML)
  if (el.matches?.(".popup-cart__items, [class*='popup-cart__items']")) return true;
  // quick-cart / cart-flyout theme: items container is AJAX-populated (empty in static HTML)
  if (el.matches?.(".quick-cart__items, .js-items[class*='quick-cart']")) return true;
  // Wonder theme: line-items list (empty when cart is empty during crawl)
  if (el.matches?.(".wt-cart__list")) return true;
  // Timber/ajaxcart theme: items wrapper injected into #CartContainer via AJAX (empty in static HTML)
  if (el.matches?.(".ajaxcart__inner")) return true;
  // Archetype/Atlantic theme: Cart__ItemList inside #sidebar-cart drawer (AJAX-populated)
  if (el.matches?.(".Cart__ItemList")) return true;
  if (el.querySelector?.(LINE_ITEM_MARKERS)) return true;
  if (el.matches?.(".cart, .cart__content, .cart__contents, .wt-cart__wrapper")) return true;
  // Prestige theme: .order-summary is the line items section inside form.cart-page
  if (el.matches?.(".order-summary") && el.closest?.('form.cart-page, form[action="/cart"]')) return true;
  // Empty-cart fallback: accept elements inside form[action="/cart"] whose class name
  // semantically signals a line-items list, even when no item children are rendered.
  // This handles themes (e.g. cart-template__products) where the cart was empty during crawl.
  if (
    el.closest?.('form[action="/cart"]') &&
    /product|item|cart.{0,10}(list|content|product|item)|line.?item/i.test(String(el.className || ""))
  ) {
    return true;
  }
  return false;
}

const CART_ICON_TRIGGER_SELECTORS =
  'cart-icon, [data-testid="cart-icon"], [data-testid="cart-drawer-trigger"], button[aria-label*="Cart" i], a[aria-label*="Cart" i]';

function isCartIconTrigger(el) {
  if (!el) return false;
  if (el.matches?.(CART_ICON_TRIGGER_SELECTORS)) return true;
  if (el.matches?.(".xo-header__right-item-cart, xo-modal-trigger.xo-header__right-item-cart")) return true;
  if (el.matches?.("a.bls-minicart-action, .bls-minicart-action")) return true;
  if (el.matches?.("a.mini_cart, .icon-cart.mini_cart, .icon-cart")) return true;
  if (el.matches?.("a.site-header-cart--button, .site-header-cart--button")) return true;
  if (el.matches?.(".header__action-item-link.header__cart-toggle, a.header__cart-toggle")) return true;
  if (el.matches?.("a.js-cart-full, .js-cart-draw-icon, .cart-draw-trigger-icon")) return true;
  if (el.matches?.("a.cart-drawer-button, .cart-drawer-button")) return true;
  if (el.matches?.('a[aria-controls="CartDrawer"], [aria-controls="CartDrawer"]')) return true;
  if (el.matches?.("a.js-drawer-open-cart, .js-drawer-open-cart")) return true;
  if (el.matches?.('button[data-option-target="Cart"], [data-option-target="Cart"][data-component="Action"]'))
    return true;
  if (el.closest?.("button[data-testid='cart-drawer-trigger'], button[aria-haspopup='dialog'][aria-label*='Cart' i]"))
    return true;
  return false;
}

/** Valid cart-icon match counts: 1, or 2 when desktop + mobile header rows share the same selector. */
function validateCartIconMatches(doc, selector) {
  let els;
  try {
    els = [...doc.querySelectorAll(selector)];
  } catch {
    return { ok: false, reason: "invalid selector" };
  }
  if (!els.length) return { ok: false, reason: "no matches" };
  if (els.length > 2) {
    return {
      ok: false,
      reason: `count ${els.length} (max 2 — desktop + mobile header cart links)`,
    };
  }
  for (const el of els) {
    if (el?.closest?.(DRAWER_ROOTS_QUERY) && !isCartIconTrigger(el)) {
      return { ok: false, reason: "matched inside drawer" };
    }
    const href = (el?.getAttribute?.("href") || "").trim();
    if (href.includes("/cart/add")) return { ok: false, reason: "links to /cart/add" };
  }
  return { ok: true };
}

/** Reject outer summary/footer containers — discount keys need the inner totals row/block. */
function isOuterDiscountContainer(el, key) {
  if (!el) return false;
  if (key === "cart-drawer-discount-code") {
    if (el.matches?.(".fc-footer-inner, .fc-footer")) return true;
    if (el.matches?.(".drawer__footer") && !el.matches?.(".grid")) return true;
    if (el.matches?.(".cart-drawer__summary, .cart-summary")) return true;
    if (el.matches?.(".xo-modal-content__footer, .xo-cart-mini-footer")) return true;
    if (el.matches?.(".bls-cart-summary, .bls-cart-footer")) return true;
    if (el.matches?.(".mini-cart__recap, .cart-recap, .ajaxcart__footer, .footer-subtotal-wrapper, .discount-box")) return true;
  }
  if (key === "cart-page-discount-code") {
    if (el.matches?.(".cart-page__summary, .cart__summary-container, .cart-summary, .cart__sidebar")) {
      return true;
    }
    // .cart-recap is the outer sidebar on Warehouse; but on some themes it is
    // the inner totals block inside .cart-footer — only blacklist it when it is
    // NOT already scoped inside a .cart-footer parent.
    if (el.matches?.(".cart-recap, .mini-cart__recap") && !el.closest?.(".cart-footer")) return true;
  }
  return false;
}

function isCartRecapForm(el) {
  if (!el || el.tagName !== "FORM") return false;
  if (!(el.getAttribute("action") || "").includes("/cart")) return false;
  const cls = (el.className || "").toString();
  if (!/recap|checkout|aside|footer/i.test(cls)) return false;
  return !el.querySelector?.(".line-item-table, table.line-item, cart-items, line-item");
}

/** Drawer totals / discount slot — inner block inside drawer footer, not the footer root. */
function isDrawerDiscountSlot(el) {
  if (!el) return false;
  if (el.tagName === "FOOTER") return false;
  if (isTotalsWrapper(el)) return true;
  if (
    el.matches?.(".bls-subtotal, .bls-subtotal-price") &&
    el.closest?.(DRAWER_ROOTS_QUERY)
  ) {
    return true;
  }
  if (
    el.matches?.(".cart_subtotal.js-cart_subtotal, .js-cart_subtotal.subtotal_all") &&
    el.closest?.(DRAWER_ROOTS_QUERY)
  ) {
    return true;
  }
  if (el.matches?.(".slidecart-subtotal") && el.closest?.(DRAWER_ROOTS_QUERY)) return true;
  if (el.matches?.(".amp-sc__footer-row--subtotal") && el.closest?.(DRAWER_ROOTS_QUERY)) return true;
  if (
    el.matches?.(".drawer__footer-bottom") &&
    el.closest?.(DRAWER_ROOTS_QUERY) &&
    (el.classList?.contains?.("grid") ||
      hasCheckoutControl(el) ||
      MONEY_RE.test(el.textContent || "") ||
      isTotalsWrapper(el))
  ) {
    return true;
  }
  if (
    el.matches?.(".cart__item-sub.cart__item-row") &&
    el.querySelector?.("[data-subtotal]") &&
    el.closest?.(DRAWER_ROOTS_QUERY)
  ) {
    return true;
  }
  const drawerFooter = el.closest?.(".drawer__footer, .fc-footer, [class*='drawer-footer'], [class*='drawer__footer']");
  if (drawerFooter && el.closest?.(DRAWER_ROOTS_QUERY)) {
    // Concept / Tailwind themes: checkout row grid inside .drawer__footer
    // SUPR / custom fc-drawer: totals block .fc-footer-inner
    if (
      el.matches?.(".grid, .fc-subtotal-row") ||
      el.classList?.contains?.("grid") ||
      el.classList?.contains?.("fc-subtotal-row") ||
      hasCheckoutControl(el) ||
      MONEY_RE.test(el.textContent || "")
    ) {
      return true;
    }
  }
  const footerRoot = el.closest?.('footer, .fc-footer, [class*="drawer-footer"], [class*="drawer__footer"]');
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

  // Guard against verifying selectors on Cloudflare challenge pages —
  // CF pages have generic DOM structure that can produce false-positive counts.
  const pdpIsBlocked = isCloudflareChallenge(crawl.pdpHtml || "");
  const homeIsBlocked = crawl.homeIsBlocked && isCloudflareChallenge(crawl.homeAfterAddHtml || "");
  const cartIsBlocked = isCloudflareChallenge(crawl.cartHtml || "");

  const PDP_KEYS = ["product-form-selector", "product-page-cvb"];
  const HOME_KEYS = ["home-page-cvb", "cart-icon"];
  const CART_KEYS = ["cart-page-discount-code", "cart-page-cvb"];

  if (pdpIsBlocked && PDP_KEYS.includes(key))
    return { ok: false, reason: "PDP is Cloudflare-blocked" };
  if (homeIsBlocked && HOME_KEYS.includes(key))
    return { ok: false, reason: "home page is Cloudflare-blocked" };
  if (cartIsBlocked && CART_KEYS.includes(key))
    return { ok: false, reason: "cart page is Cloudflare-blocked" };

  const { homeDoc, pdpDoc, cartDoc, drawerDoc, hasDrawer } = crawl;

  switch (key) {
    case "product-form-selector": {
      const effHome = effectiveHomeDoc(crawl);
      const c = countOf(pdpDoc, selector);
      const h = countOf(effHome, selector);
      if (c !== 1) return { ok: false, reason: `pdp count ${c}` };
      if (h !== 0) return { ok: false, reason: `home count ${h} (must be 0)` };
      const el = safeQuery(pdpDoc, selector);
      if (!el) return { ok: false, reason: "element not found" };

      // Standard path: HTML form with cart/add action
      if (el.tagName === "FORM" && (el.getAttribute("action") || "").includes("cart/add")) {
        return { ok: true };
      }

      // Non-standard path: JS-driven ATC (no standard form exists on PDP at all,
      // or all forms are app-injected quick-buy widgets).
      // Accept a button/interactive element that is clearly the main ATC control.
      const noStandardForm = hasNoStandardAtcForm(pdpDoc) || onlyAppInjectedAtcForms(pdpDoc);
      if (noStandardForm) {
        const tag = el.tagName;
        const cls = (el.className || "").toString().toLowerCase();
        const id = (el.id || "").toLowerCase();
        const text = (el.textContent || "").toLowerCase().trim();
        const looksLikeAtc =
          /add.?to.?cart|add.?cart|atc[-_]|buy.?now|add_to_cart|heroaddtocart|addtocart/i.test(
            `${cls} ${id} ${text}`,
          );
        if (
          (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "DIV") &&
          looksLikeAtc
        ) {
          return {
            ok: true,
            note: "non-standard ATC (JS-driven — no form[action*=cart/add] on PDP)",
          };
        }
        // Fallback: any BUTTON inside a container that is the sole pdp=1/home=0 match
        if (tag === "BUTTON") {
          return {
            ok: true,
            note: "non-standard ATC button (no standard form on PDP)",
          };
        }
      }

      if (el.tagName !== "FORM") return { ok: false, reason: "not a form and not a recognized non-standard ATC element" };
      if (!(el.getAttribute("action") || "").includes("cart/add"))
        return { ok: false, reason: "no cart/add action" };
      return { ok: true };
    }
    case "home-page-cvb": {
      const h = countOf(effectiveHomeDoc(crawl), selector);
      const p = countOf(pdpDoc, selector);
      if (h === 1 && p === 0) return { ok: true };
      // Accept header-group sections that render on every page (global hero/banner).
      // Per rules: "Branded hero reused on PDP" — use it even if home=1/pdp=1.
      if (h === 1 && p === 1) {
        const el = safeQuery(effectiveHomeDoc(crawl), selector);
        if (el?.closest?.('.shopify-section-group-header-group, [class*="section-group-header"]')) {
          return { ok: true, note: 'header-group hero (global section on all pages — still correct home-page-cvb)' };
        }
      }
      return { ok: false, reason: `home=${h} pdp=${p}` };
    }
    case "product-page-cvb": {
      const h = countOf(effectiveHomeDoc(crawl), selector);
      const p = countOf(pdpDoc, selector);
      if (h !== 0 || p !== 1) return { ok: false, reason: `home=${h} pdp=${p}` };
      const el = safeQuery(pdpDoc, selector);
      if (!el) return { ok: false, reason: "element not found" };

      // Standard path: container wraps the cart/add form.
      const form = el?.querySelector?.('form[action*="cart/add"]');
      if (form) return { ok: true };

      // Non-standard path: JS-driven ATC theme — no form exists at all (or only
      // app-injected catalog-card forms).  Accept the container if:
      //   (a) there are no standard forms on the PDP, AND
      //   (b) the container holds an identifiable ATC button or JS-driven control.
      if (hasNoStandardAtcForm(pdpDoc) || onlyAppInjectedAtcForms(pdpDoc)) {
        // Does the container hold an ATC button?
        const atcBtn = el?.querySelector?.(
          'button[class*="add-cart"], button[id*="AddToCart"], button[id*="heroAddToCart"], .add-cart, [data-add-to-cart], button[data-action*="add"], button[name="add"]',
        );
        if (atcBtn) {
          return {
            ok: true,
            note: "non-standard ATC container (JS-driven — has ATC button, no form)",
          };
        }
        // Last resort: container present on pdp=1/home=0 and PDP has truly no forms
        if (hasNoStandardAtcForm(pdpDoc)) {
          return {
            ok: true,
            note: "non-standard ATC container (no form[action*=cart/add] on PDP)",
          };
        }
      }

      return { ok: false, reason: "does not contain cart-add form (and PDP has standard forms)" };
    }
    case "cart-drawer-cvb": {
      if (!hasDrawer) {
        if (selector === "") return { ok: true, note: "no drawer on theme" };
        return { ok: false, reason: "theme has no drawer" };
      }
      if (selector === "") return { ok: false, reason: "empty but drawer exists" };
      // Reject #CartDrawerForm selectors when cart-drawer custom element exists —
      // #CartDrawerForm is the /cart?view=ajax shell (not browser DOM); prefer cart-drawer cart-items
      if (
        /^#CartDrawerForm/i.test(selector) &&
        (countOf(drawerDoc, "cart-drawer") > 0 || countOf(homeDoc, "cart-drawer") > 0)
      ) {
        return {
          ok: false,
          reason:
            "cart-drawer element exists — use cart-drawer cart-items instead of #CartDrawerForm (which is the /cart?view=ajax shell, not browser DOM)",
        };
      }
      // Reject #CartDrawerForm selectors when Timber/ajaxcart theme is detected (#CartContainer present)
      // In this theme, the drawer is #CartDrawer and content is AJAX-injected into #CartContainer
      if (
        /^#CartDrawerForm/i.test(selector) &&
        (countOf(homeDoc, "#CartContainer") > 0)
      ) {
        return {
          ok: false,
          reason:
            "Timber/ajaxcart theme detected (#CartContainer exists) — #CartDrawerForm does not exist here; use #CartContainer .ajaxcart__inner instead",
        };
      }
      // Accept Timber/ajaxcart drawer pattern: #CartContainer exists in home DOM but .ajaxcart__inner
      // is AJAX-injected (empty in static HTML) — trust it as valid AJAX-populated drawer
      if (
        /^#CartContainer\s+\.ajaxcart__inner/.test(selector) &&
        countOf(homeDoc, "#CartContainer") > 0
      ) {
        return { ok: true, note: "Timber/ajaxcart theme — AJAX-populated drawer items wrapper" };
      }
      // Accept Archetype/Atlantic drawer pattern: #sidebar-cart exists in home DOM but .Cart__ItemList
      // is AJAX-injected (empty in static HTML) — trust it as valid AJAX-populated drawer
      if (
        /^#sidebar-cart\s+\.Cart__ItemList/.test(selector) &&
        countOf(homeDoc, "#sidebar-cart") > 0
      ) {
        return { ok: true, note: "Archetype/Atlantic theme — AJAX-populated drawer items list" };
      }
      const { els } = resolveDrawerElements(crawl, selector);
      const outside = countOutsideDrawerContext(crawl, selector);
      if (els.length !== 1) {
        const inSection = countOf(drawerDoc, selector);
        const inHome = queryDrawerElements(homeDoc, selector).length;
        return {
          ok: false,
          reason: `drawer count ${els.length} (section=${inSection}, home-drawer=${inHome})`,
        };
      }
      if (outside !== 0) return { ok: false, reason: `outside drawer: ${outside} match(es) on home/pdp/cart` };
      const el = els[0];
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
      if (isOuterDiscountContainer(el, "cart-page-discount-code")) {
        return {
          ok: false,
          reason:
            "matched outer cart summary container — pick inner totals block (e.g. .cart__summary-totals, .totals) inside .cart-page__summary",
        };
      }
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
        // When the cart was crawled empty, the line-items container has no item
        // children — heuristic matching always fails on empty carts.
        // Accept the element if it is plausibly a products/items wrapper
        // (inside the cart form, or has "product/item/cart" in its name)
        // and is clearly not a recap/totals/footer container.
        const cartIsEmpty =
          /your cart is empty|cart.*empty|empty.*cart|carrello.*vuoto|panier.*vide|carrito.*vac[íi]o|winkelwagen.*leeg|korb.*leer|il tuo carrello/i.test(
            crawl.cartHtml || "",
          );
        if (cartIsEmpty) {
          const cls = String(el.className || "").toLowerCase();
          const id = String(el.id || "").toLowerCase();
          const insideCartForm = !!el.closest?.('form[action="/cart"], form[action*="/cart"]');
          const looksLikeProducts = /product|item|line|cart/.test(`${cls} ${id}`);
          const notRecap =
            !/recap|summary|aside|footer|total|checkout|discount|payment/i.test(`${cls} ${id}`);
          if ((insideCartForm || looksLikeProducts) && notRecap) {
            return {
              ok: true,
              note: "cart was empty during crawl — accepted as likely line-items container",
            };
          }
        }
        return { ok: false, reason: "does not look like a line-items container" };
      }
      return { ok: true };
    }
    case "cart-icon": {
      const h = countOf(effectiveHomeDoc(crawl), selector);
      const p = countOf(pdpDoc, selector);
      if (h !== p || (h !== 1 && h !== 2)) {
        const dupHint =
          h > 2 || p > 2
            ? " — max 2 (desktop + mobile header cart links); prefer .header__icons .header__buttons a[href$='/cart']"
            : h !== p
              ? " — home and PDP counts must match"
              : "";
        return { ok: false, reason: `home=${h} pdp=${p}${dupHint}` };
      }
      const homeCheck = validateCartIconMatches(effectiveHomeDoc(crawl), selector);
      if (!homeCheck.ok) return homeCheck;
      const pdpCheck = validateCartIconMatches(pdpDoc, selector);
      if (!pdpCheck.ok) return pdpCheck;
      return { ok: true, note: h === 2 ? "desktop+mobile (2 matches)" : undefined };
    }
    case "cart-drawer-discount-code": {
      if (!hasDrawer) {
        if (selector === "") return { ok: true, note: "no drawer on theme" };
        return { ok: false, reason: "theme has no drawer" };
      }
      if (selector === "") return { ok: false, reason: "empty but drawer exists" };
      // Reject #CartDrawerForm selectors when cart-drawer custom element exists
      if (
        /^#CartDrawerForm/i.test(selector) &&
        (countOf(drawerDoc, "cart-drawer") > 0 || countOf(homeDoc, "cart-drawer") > 0)
      ) {
        return {
          ok: false,
          reason:
            "cart-drawer element exists — use cart-drawer .drawer__footer .totals instead of #CartDrawerForm (which is the /cart?view=ajax shell, not browser DOM)",
        };
      }
      // Reject #CartDrawerForm selectors when Timber/ajaxcart theme is detected (#CartContainer present)
      if (
        /^#CartDrawerForm/i.test(selector) &&
        countOf(homeDoc, "#CartContainer") > 0
      ) {
        return {
          ok: false,
          reason:
            "Timber/ajaxcart theme detected (#CartContainer exists) — #CartDrawerForm does not exist here; use #CartContainer .ajaxcart__footer > .grid--full instead",
        };
      }
      // Accept Timber/ajaxcart drawer discount pattern: #CartContainer .ajaxcart__footer > .grid--full
      // The subtotal row is AJAX-injected (empty in static HTML) — trust it as valid
      if (
        /^#CartContainer\s+\.ajaxcart__footer/.test(selector) &&
        countOf(homeDoc, "#CartContainer") > 0
      ) {
        return { ok: true, note: "Timber/ajaxcart theme — AJAX-populated subtotal row in drawer footer" };
      }
      // Accept Archetype/Atlantic drawer footer: #sidebar-cart .Drawer__Footer exists in home DOM
      if (
        /^#sidebar-cart\s+\.Drawer__Footer/.test(selector) &&
        countOf(homeDoc, "#sidebar-cart") > 0
      ) {
        return { ok: true, note: "Archetype/Atlantic theme — drawer footer with total" };
      }
      const { els } = resolveDrawerElements(crawl, selector);
      const outside = countOutsideDrawerContext(crawl, selector);
      if (els.length !== 1) {
        const inSection = countOf(drawerDoc, selector);
        const inHome = queryDrawerElements(homeDoc, selector).length;
        return {
          ok: false,
          reason: `drawer count ${els.length} (section=${inSection}, home-drawer=${inHome})`,
        };
      }
      if (outside !== 0)
        return { ok: false, reason: `outside drawer: ${outside} match(es) on home/pdp/cart` };
      const el = els[0];
      if (!el?.closest?.(DRAWER_ROOTS_QUERY))
        return { ok: false, reason: "wrapper outside drawer" };
      if (el.tagName === "FOOTER") {
        return {
          ok: false,
          reason: "matched <footer> root — pick inner block inside drawer footer above price/checkout (e.g. .mini-cart__actions, .cart__recap-block)",
        };
      }
      if (isOuterDiscountContainer(el, "cart-drawer-discount-code")) {
        return {
          ok: false,
          reason:
            "matched outer drawer footer container — pick inner totals row inside .fc-footer-inner (e.g. .fc-subtotal-row) or .drawer__footer .grid",
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
 * Parse explicit selectors from user feedback / overrides
 * ========================================================================= */

function trimSelector(val) {
  let s = String(val || "")
    .trim()
    .replace(/[.,;]+$/, "")
    .trim();
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** @returns {Record<string, string>} */
export function parseFeedbackSelectors(feedback) {
  const text = String(feedback || "").trim();
  if (!text) return {};
  const out = {};

  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (parsed && typeof parsed === "object") {
        for (const key of SELECTOR_KEYS) {
          const v = parsed[key];
          if (typeof v === "string" && v.trim()) out[key] = trimSelector(v);
        }
      }
    } catch {
      /* ignore */
    }
  }

  for (const key of SELECTOR_KEYS) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      // key: '#selector with spaces' | key = "..."
      new RegExp(`(?:^|\\n)\\s*${esc}\\s*[:=]\\s*['"\`]([^'"\`]+)['"\`]`, "gi"),
      new RegExp(`(?:^|\\n)\\s*${esc}\\s*[:=]\\s*(.+?)(?=\\s*(?:\\n|$))`, "gi"),
      // key should be '#a b c' or key should be #a b c
      new RegExp(
        `${esc}\\s+should\\s+be\\s+(?:['"\`]([^'"\`]+)['"\`]|(.+?)(?=\\s*(?:\\n|$|;)))`,
        "gi",
      ),
      new RegExp(`use\\s+(?:['"\`]([^'"\`]+)['"\`]|(.+?))\\s+for\\s+${esc}`, "gi"),
      new RegExp(`for\\s+${esc}\\s+use\\s+(?:['"\`]([^'"\`]+)['"\`]|(.+?)(?=\\s*(?:\\n|$)))`, "gi"),
      new RegExp(`${esc}\\s+is\\s+(?:['"\`]([^'"\`]+)['"\`]|(.+?)(?=\\s*(?:\\n|$)))`, "gi"),
      new RegExp(`fix\\s+${esc}\\s+to\\s+(?:['"\`]([^'"\`]+)['"\`]|(.+?)(?=\\s*(?:\\n|$)))`, "gi"),
    ];
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const val = trimSelector(m[1] || m[2]);
        if (val && !/^(the|a|an|use|fix)\b/i.test(val)) out[key] = val;
      }
    }
  }

  return out;
}

/** User hints that pass DOM verify — these always win over LLM output. */
function verifiedUserHints(userHints, crawl) {
  const locked = {};
  if (!userHints || typeof userHints !== "object") return locked;
  for (const key of SELECTOR_KEYS) {
    const raw = userHints[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const val = raw.trim();
    const v = verify(val, key, crawl);
    if (v.ok) locked[key] = val;
  }
  return locked;
}

function keysNeedingWork(selectors, crawl, userHints) {
  const required = mandatoryKeys(crawl.hasDrawer);
  const locked = verifiedUserHints(userHints, crawl);
  return required.filter((key) => {
    if (!selectors[key]) return true;
    if (locked[key] && selectors[key] !== locked[key]) return true;
    return false;
  });
}

function mergeSelectorHints(...sources) {
  const merged = {};
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [key, val] of Object.entries(src)) {
      if (!SELECTOR_KEYS.includes(key)) continue;
      const s = typeof val === "string" ? val.trim() : "";
      if (s) merged[key] = s;
    }
  }
  return merged;
}

/**
 * Apply user-provided selectors when they pass DOM verify (feedback text or API overrides).
 */
function applyUserSelectorOverrides(selectors, details, crawl, overrides, emit, source = "user") {
  if (!overrides || typeof overrides !== "object") return;
  for (const key of SELECTOR_KEYS) {
    const raw = overrides[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const val = raw.trim();
    const v = verify(val, key, crawl);
    details[key] = { ...(details[key] || {}), llmRaw: val, verify: v, userOverride: true };
    if (v.ok) {
      if (selectors[key] !== val) {
        emit?.({
          type: "log",
          level: "info",
          message: `  ✓ ${key}: ${val} (${source} override)`,
        });
      }
      selectors[key] = val;
      emit?.({ type: "selector", key, value: val, llmRaw: val, verify: v, source });
    } else {
      emit?.({
        type: "log",
        level: "warn",
        message: `  ✗ ${key}: ${source} override "${val}" rejected — ${v.reason}`,
      });
    }
  }
}

/* ============================================================================
 * Apply + verify LLM JSON; build retry prompts for missing mandatory keys
 * ========================================================================= */

function applyAndVerify(parsed, crawl, emit, { lockedKeys = {} } = {}) {
  const selectors = {};
  const details = {};

  for (const key of SELECTOR_KEYS) {
    if (lockedKeys[key]) {
      const val = lockedKeys[key];
      const v = verify(val, key, crawl);
      details[key] = { llmRaw: val, verify: v, userOverride: true };
      selectors[key] = val;
      emit?.({
        type: "log",
        level: "info",
        message: `  ✓ ${key}: ${val} (locked from feedback)`,
      });
      emit?.({ type: "selector", key, value: val, llmRaw: val, verify: v, source: "feedback-locked" });
      continue;
    }

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

function buildCorrectionMessage(crawl, selectors, details, { userHints = null } = {}) {
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

  if (userHints && typeof userHints === "object") {
    const hintLines = [];
    for (const key of required) {
      if (selectors[key]) continue;
      const hint = userHints[key];
      if (!hint) continue;
      const v = verify(hint, key, crawl);
      if (v.ok) {
        hintLines.push(`- ${key}: user provided "${hint}" — use this exact selector in JSON.`);
      } else {
        hintLines.push(`- ${key}: user suggested "${hint}" but it failed verify (${v.reason}) — find another.`);
      }
    }
    if (hintLines.length) {
      lines.push("", "User-provided selectors (honor verified ones exactly):", ...hintLines);
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

/**
 * Returns a per-key map of which keys are blocked by Cloudflare.
 * - PDP-dependent keys fail when the PDP is CF-blocked.
 * - Home-dependent keys fail when both home and homeAfterAdd are CF-blocked.
 * - Cart-dependent keys fail when the cart page is CF-blocked.
 */
function buildCfBlockedKeys(crawl) {
  const pdpBlocked = isCloudflareChallenge(crawl.pdpHtml || "");
  const homeBlocked = crawl.homeIsBlocked && (crawl.homeAfterAddIsBlocked !== false
    ? isCloudflareChallenge(crawl.homeAfterAddHtml || "")
    : false);
  const cartBlocked = isCloudflareChallenge(crawl.cartHtml || "");

  // Keys that rely solely on PDP content
  const PDP_KEYS = new Set(["product-form-selector", "product-page-cvb"]);
  // Keys that rely on home page content
  const HOME_KEYS = new Set(["home-page-cvb", "cart-icon"]);
  // Keys that rely on cart page content
  const CART_KEYS = new Set(["cart-page-discount-code", "cart-page-cvb"]);
  // Drawer keys rely on drawer HTML — not CF-blocked if no drawer
  const DRAWER_KEYS = new Set(["cart-drawer-cvb", "cart-drawer-discount-code"]);

  const blocked = new Set();
  if (pdpBlocked) PDP_KEYS.forEach(k => blocked.add(k));
  if (homeBlocked) HOME_KEYS.forEach(k => blocked.add(k));
  if (cartBlocked) CART_KEYS.forEach(k => blocked.add(k));
  return blocked;
}

function buildBestEffortSelectors(crawl, verified, details, lastParsed) {
  const cfBlocked = buildCfBlockedKeys(crawl);
  const out = {};
  for (const key of SELECTOR_KEYS) {
    if (verified[key]) {
      out[key] = verified[key];
    } else if (emptyAllowed(key, crawl.hasDrawer)) {
      out[key] = "";
    } else if (cfBlocked.has(key)) {
      // The page this key depends on was blocked by Cloudflare.
      out[key] = "❌ CF blocked";
    } else {
      // Never surface unverified LLM guesses — only keys that passed DOM verify.
      out[key] = "";
    }
  }
  return out;
}

/* ============================================================================
 * Inspection pass helpers
 * ========================================================================= */

function isTemplateDrawer(crawl) {
  return /data-cart-drawer-template/i.test(crawl.homeHtml || '') ||
         /data-cart-drawer-template/i.test(crawl.drawerHtml || '');
}

function extractTemplateDrawerContent(rawHtml) {
  if (!rawHtml) return null;
  const tmplIdx = rawHtml.search(/data-cart-drawer-template/i);
  if (tmplIdx < 0) return null;
  const tagStart = rawHtml.lastIndexOf('<template', tmplIdx);
  if (tagStart < 0) return null;
  const tagOpenEnd = rawHtml.indexOf('>', tagStart);
  const tagEnd = rawHtml.indexOf('</template>', tagStart);
  if (tagOpenEnd < 0 || tagEnd < 0) return null;
  return rawHtml.slice(tagOpenEnd + 1, tagEnd);
}

function getParentChain(el, depth = 6) {
  const chain = [];
  let cur = el?.parentElement;
  for (let i = 0; i < depth && cur?.tagName; i++) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id && !cur.id.match(/\d{6,}|template--/i) ? `#${cur.id}` : '';
    const cls = String(cur.className || '').trim().split(/\s+/)
      .filter(c => c && !c.match(/\d{6,}/) && c.length >= 2).slice(0, 3).map(c => `.${c}`).join('');
    chain.unshift(`${tag}${id}${cls}`);
    cur = cur.parentElement;
  }
  return chain;
}

function elDesc(el) {
  if (!el) return '(null)';
  const tag = (el.tagName || '').toLowerCase();
  const id = el.id && !el.id.match(/\d{6,}/) ? ` id="${el.id}"` : '';
  const cls = String(el.className || '').trim().split(/\s+/).filter(c => c && !c.match(/\d{6,}/)).slice(0, 4).join(' ');
  const clsStr = cls ? ` class="${cls}"` : '';
  const extra = [...(el.attributes || [])]
    .filter(a => a.name.startsWith('data-') && a.name.length < 30 || ['action','name'].includes(a.name))
    .slice(0, 3).map(a => ` ${a.name}="${String(a.value).slice(0,30)}"`).join('');
  return `<${tag}${id}${clsStr}${extra}>`;
}

function inspectProductForms(crawl) {
  const { pdpDoc } = crawl;
  const effHome = effectiveHomeDoc(crawl);
  if (!pdpDoc) return null;
  let forms;
  try { forms = [...pdpDoc.querySelectorAll('form[action*="/cart/add"]')]; } catch { return null; }
  if (!forms.length) return 'INSPECTION product-form-selector: No form[action*="/cart/add"] found on PDP.';

  const lines = [`INSPECTION product-form-selector — ${forms.length} cart/add form(s) on PDP:`];
  forms.forEach((form, i) => {
    const skip = (form.id || '').includes('installment') ? ' [INSTALLMENT]'
      : String(form.className || '').match(/upsell|quick.?buy|product-upsell/i) ? ' [UPSELL]' : '';
    lines.push(`\n  Form ${i+1}:${skip} ${elDesc(form)}`);
    lines.push(`  Parents: ${getParentChain(form, 7).join(' > ')}`);
  });

  const mainForms = forms.filter(f =>
    !(f.id || '').includes('installment') &&
    !String(f.className || '').match(/upsell|quick.?buy|product-upsell/i)
  );
  if (mainForms.length === 1) {
    lines.push(`\n  MAIN FORM: ${elDesc(mainForms[0])}`);
    lines.push('  Scanning ancestors for unique PDP scope (home=0):');
    let el = mainForms[0].parentElement;
    for (let d = 0; d < 10 && el?.tagName; d++) {
      const tag = el.tagName.toLowerCase();
      const candidates = [];
      if (el.id && !el.id.match(/\d{6,}|template--/i)) candidates.push(`${tag}#${el.id}`);
      const classes = String(el.className || '').trim().split(/\s+/).filter(c => c && !c.match(/\d{6,}/) && c.length >= 2);
      // Try first-2-classes combo, then each class individually (catches short modifiers like .mu, .wt)
      if (classes.length) candidates.push(`${tag}.${classes.slice(0, 2).join('.')}`);
      for (const cls of classes.slice(0, 4)) {
        const solo = `${tag}.${cls}`;
        if (!candidates.includes(solo)) candidates.push(solo);
      }
      if (tag.includes('-')) candidates.push(tag);
      let foundUnique = false;
      for (const sel of candidates) {
        try {
          const pdpC = pdpDoc.querySelectorAll(sel).length;
          const homeC = effHome ? effHome.querySelectorAll(sel).length : -1;
          lines.push(`    ${sel}: pdp=${pdpC} home=${homeC}${homeC === 0 ? ' ← UNIQUE SCOPE' : ''}`);
          if (homeC === 0 && pdpC >= 1) { foundUnique = true; break; }
        } catch {}
      }
      if (foundUnique) break; // stop scanning further ancestors once unique scope found
      el = el.parentElement;
    }
  }
  return lines.join('\n');
}

function inspectHomeSections(crawl) {
  const homeDoc = effectiveHomeDoc(crawl);
  const { pdpDoc } = crawl;
  if (!homeDoc) return null;
  const lines = ['INSPECTION home-page-cvb — sections on home page:'];
  let mainEl;
  try { mainEl = homeDoc.querySelector('#MainContent, main') || homeDoc.body; } catch { mainEl = homeDoc.body; }
  let sections = [];
  try { sections = [...mainEl.querySelectorAll('section, div[id*="shopify-section"], div[class*="shopify-section"]')].slice(0, 12); } catch {}
  const CLASS_FILTER_RE = /^(color|gradient|padding|flex|grid|hidden|relative|absolute)/i;

  /** Check a class against home/pdp counts and emit hint lines. Returns true if home-only found. */
  function checkClass(cls, tag, secIdx) {
    try {
      const homeC = homeDoc.querySelectorAll(`.${cls}`).length;
      const pdpC = pdpDoc ? pdpDoc.querySelectorAll(`.${cls}`).length : -1;
      // Check if matching element is in a header-group section (verifier accepts home=1 pdp=1 for header-group heroes)
      if (homeC === 1 && pdpC === 1) {
        const el = homeDoc.querySelector(`.${cls}`);
        const inHeaderGroup = el?.closest?.('.shopify-section-group-header-group, [class*="section-group-header"]');
        if (inHeaderGroup) {
          lines.push(`    ✓ .${cls} → home=1 pdp=1 but IN HEADER-GROUP ← USE THIS (verifier accepts header-group heroes)`);
          // Also suggest tag-scoped version
          const tagSel = `${tag}.${cls}`;
          const tH = homeDoc.querySelectorAll(tagSel).length;
          if (tH === 1) lines.push(`    ✓ ${tagSel} → home=1 pdp=1 header-group ← USE THIS`);
          return true;
        }
      }
      if (homeC === 1 && pdpC === 0) {
        lines.push(`    ✓ .${cls} → home=1 pdp=0 ← HOME-ONLY`);
        return true;
      } else if (homeC <= 3 && homeC >= 1 && pdpC === 0) {
        // Multiple home matches — try first-child scoped variants to isolate
        lines.push(`    ~ .${cls} → home=${homeC} pdp=0 (try scoped variant)`);
        const scopedCandidates = [
          `#MainContent > ${tag}.${cls}:first-child`,
          `main > ${tag}.${cls}:first-child`,
          `#MainContent > .shopify-section.${cls}:first-child`,
          `#MainContent > .${cls}:first-child`,
        ];
        for (const scoped of scopedCandidates) {
          try {
            const sH = homeDoc.querySelectorAll(scoped).length;
            const sP = pdpDoc ? pdpDoc.querySelectorAll(scoped).length : -1;
            if (sH === 1 && sP === 0) {
              lines.push(`    ✓ ${scoped} → home=1 pdp=0 ← USE THIS`);
              return true;
            }
          } catch {}
        }
      } else if (homeC >= 1 && pdpC > 0) {
        // Class appears on both home and PDP — still try :first-child scoped,
        // because the hero is the first section on home but NOT first on PDP
        const scopedCandidates = [
          `#MainContent > .${cls}:first-child`,
          `#MainContent > ${tag}.${cls}:first-child`,
          `#MainContent > .shopify-section.${cls}:first-child`,
        ];
        for (const scoped of scopedCandidates) {
          try {
            const sH = homeDoc.querySelectorAll(scoped).length;
            const sP = pdpDoc ? pdpDoc.querySelectorAll(scoped).length : -1;
            if (sH === 1 && sP === 0) {
              lines.push(`    ✓ ${scoped} → home=1 pdp=0 ← USE THIS (first-child scoped)`);
              return true;
            }
          } catch {}
        }
      }
    } catch {}
    return false;
  }

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    lines.push(`\n  Section ${i+1}: ${elDesc(sec)}`);
    const tag = (sec.tagName || 'div').toLowerCase();

    // Check if this section is in the header-group (appears on all pages — verifier accepts as home-page-cvb)
    const isHeaderGroup = sec.classList?.contains?.('shopify-section-group-header-group') ||
      !!sec.closest?.('.shopify-section-group-header-group, [class*="section-group-header"]');
    if (isHeaderGroup) {
      lines.push(`    ⚑ HEADER-GROUP section — appears on all pages (home=1 pdp=1), verifier accepts as home-page-cvb`);
    }

    // 1. Check the section's OWN classes first (querySelectorAll misses these)
    const ownClasses = String(sec.className || '').trim().split(/\s+/)
      .filter(c => c && !c.match(/\d{6,}/) && c.length >= 2 && !CLASS_FILTER_RE.test(c) &&
        c !== 'shopify-section' && c !== 'shopify-section-group-header-group');
    if (ownClasses.length) {
      lines.push(`    Section own classes: ${ownClasses.map(c => `.${c}`).join(' ')}`);
      for (const cls of ownClasses) {
        checkClass(cls, tag, i);
      }
      // Also try first-child positional with own class combo
      if (ownClasses.length >= 2) {
        const combo = `#MainContent > .${ownClasses.slice(0, 2).join('.')}:first-child`;
        try {
          const sH = homeDoc.querySelectorAll(combo).length;
          const sP = pdpDoc ? pdpDoc.querySelectorAll(combo).length : -1;
          if (sH === 1 && sP === 0) lines.push(`    ✓ ${combo} → home=1 pdp=0 ← USE THIS`);
        } catch {}
      }
    }

    // 2. Check inner descendant classes
    const innerCls = [...new Set(
      [...sec.querySelectorAll('[class]')].slice(0, 20)
        .flatMap(el => String(el.className || '').trim().split(/\s+/))
        .filter(c => c && !c.match(/\d{6,}/) && c.length >= 2 && !CLASS_FILTER_RE.test(c))
    )].slice(0, 10);
    for (const cls of innerCls) {
      checkClass(cls, tag, i);
    }
  }
  return lines.join('\n');
}

function inspectCartIconLinks(crawl) {
  const homeDoc = effectiveHomeDoc(crawl);
  const { pdpDoc } = crawl;
  if (!homeDoc) return null;
  const lines = ['INSPECTION cart-icon — all a[href$="/cart"] on home:'];
  let links;
  try { links = [...homeDoc.querySelectorAll('a[href$="/cart"]')]; } catch { return null; }
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    lines.push(`\n  Link ${i+1}: ${elDesc(link)}`);
    lines.push(`  Parents: ${getParentChain(link, 4).join(' > ')}`);
    lines.push(`  In header: ${!!link.closest('header, .header, [class*="header"], [id*="Header"]')}`);
    lines.push(`  In drawer: ${!!link.closest(DRAWER_ROOTS_QUERY)}`);
    const attrs = [...(link.attributes || [])].filter(a => a.name.startsWith('data-') || a.name === 'aria-controls');
    for (const attr of attrs) {
      const sel = `a[${attr.name}]`;
      try {
        const h = homeDoc.querySelectorAll(sel).length;
        const p = pdpDoc ? pdpDoc.querySelectorAll(sel).length : -1;
        if (h <= 2 && h === p && h >= 1) lines.push(`    Try: ${sel} → home=${h} pdp=${p}`);
      } catch {}
    }
    const classes = String(link.className || '').trim().split(/\s+/).filter(c => c && !c.match(/\d{6,}/));
    for (let n = classes.length; n >= 2; n--) {
      const sel = `a.${classes.slice(0, n).join('.')}`;
      try {
        const h = homeDoc.querySelectorAll(sel).length;
        const p = pdpDoc ? pdpDoc.querySelectorAll(sel).length : -1;
        if (h <= 2 && h === p && h >= 1) { lines.push(`    Try: ${sel} → home=${h} pdp=${p}`); break; }
      } catch {}
    }
  }
  return lines.join('\n');
}

function inspectCartTotals(crawl) {
  const { cartDoc, cartHtml } = crawl;
  const lines = ['INSPECTION cart-page-discount-code:'];
  if ((cartHtml || '').length < 50000 || /your cart is empty|empty.{0,20}cart/i.test(cartHtml || '')) {
    lines.push('⚠ Cart page appears EMPTY during crawl — totals may not be rendered. Selector must target the totals area that renders with items.');
  }
  if (!cartDoc) return lines.join('\n');
  const selectors = [
    'cart-page cart-subtotal-block',
    'cart-subtotal-block',
    '.cart__aside', '[data-foot-holder]', '.cart__recap', '#main-cart-footer',
    '.cart__footer', '.cart__sidebar', '.cart__total', '.totals',
    '[class*="recap"]', '[class*="summary"]',
  ];
  for (const sel of selectors) {
    try {
      const els = [...cartDoc.querySelectorAll(sel)];
      if (!els.length) continue;
      lines.push(`\n  ${sel} (${els.length}): ${elDesc(els[0])}`);
      const children = [...els[0].children].slice(0, 5);
      for (const child of children) {
        const childCls = String(child.className || '').trim().split(/\s+/).slice(0,3).join('.');
        const childTag = (child.tagName || '').toLowerCase();
        const txt = (child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        lines.push(`    > ${childTag}.${childCls}: "${txt}"`);
      }
    } catch {}
  }

  // Detect when a totals candidate matches >1 on cart (Aurora-style double discount-code widget)
  // and suggest scoping to avoid the order-notes duplicate.
  const multiMatchCandidates = ['cart-discount-code', '.cart-order-notes__discount-code', '.cart-discount-code'];
  for (const sel of multiMatchCandidates) {
    try {
      const count = cartDoc.querySelectorAll(sel).length;
      if (count > 1) {
        lines.push(`\n⚠ "${sel}" matches ${count} times on cart page (Aurora-style double widget).`);
        lines.push(`  Scope to subtotal block: cart-page cart-subtotal-block .cart-subtotal__totals`);
        lines.push(`  Or exclude order-notes: cart-page cart-subtotal-block ${sel}`);
      }
    } catch {}
  }

  // Generic duplicate-totals detection: when a common totals selector matches >1,
  // walk each element's parent chain to find a cart-page-only ancestor that scopes it to 1 match.
  const genericTotalsCandidates = [
    '.cart_subtotal', '.js-cart_subtotal', '.cart-subtotal', '.subtotal',
    '.cart__subtotal', '[data-cart-subtotal]', '.totals__subtotal',
  ];
  const homeDoc = effectiveHomeDoc(crawl);
  const pdpDoc = crawl.pdpDoc;
  for (const sel of genericTotalsCandidates) {
    try {
      const els = [...cartDoc.querySelectorAll(sel)];
      if (els.length <= 1) continue;
      lines.push(`\n⚠ "${sel}" matches ${els.length} times on cart page — checking parent chains to find a scoping ancestor:`);
      for (let i = 0; i < els.length; i++) {
        lines.push(`  Match ${i + 1}: ${elDesc(els[i])}`);
        let ancestor = els[i].parentElement;
        for (let depth = 0; depth < 6 && ancestor && ancestor.tagName !== 'BODY'; depth++) {
          const aTag = (ancestor.tagName || 'div').toLowerCase();
          const aId = ancestor.id && !ancestor.id.match(/\d{6,}/) ? `#${ancestor.id}` : '';
          const aClasses = String(ancestor.className || '').trim().split(/\s+/)
            .filter(c => c && !c.match(/\d{6,}/) && c.length >= 2);
          // Try id-based scope
          if (aId) {
            const scoped = `${aId} ${sel}`;
            try {
              const cC = cartDoc.querySelectorAll(scoped).length;
              const hC = homeDoc ? homeDoc.querySelectorAll(scoped).length : 0;
              const pC = pdpDoc ? pdpDoc.querySelectorAll(scoped).length : 0;
              if (cC === 1 && hC === 0 && pC === 0) {
                lines.push(`    ✓ ${scoped} → cart=1 home=0 pdp=0 ← USE THIS`);
              }
            } catch {}
          }
          // Try class-based scope (first 1-2 classes)
          for (let n = Math.min(2, aClasses.length); n >= 1; n--) {
            const scopeSel = `.${aClasses.slice(0, n).join('.')}`;
            const scoped = `${scopeSel} ${sel}`;
            try {
              const cC = cartDoc.querySelectorAll(scoped).length;
              const hC = homeDoc ? homeDoc.querySelectorAll(scoped).length : 0;
              const pC = pdpDoc ? pdpDoc.querySelectorAll(scoped).length : 0;
              if (cC === 1 && hC === 0 && pC === 0) {
                lines.push(`    ✓ ${scoped} → cart=1 home=0 pdp=0 ← USE THIS`);
              }
            } catch {}
          }
          // Try tag+class scope
          if (aClasses.length) {
            const scoped = `${aTag}.${aClasses[0]} ${sel}`;
            try {
              const cC = cartDoc.querySelectorAll(scoped).length;
              const hC = homeDoc ? homeDoc.querySelectorAll(scoped).length : 0;
              const pC = pdpDoc ? pdpDoc.querySelectorAll(scoped).length : 0;
              if (cC === 1 && hC === 0 && pC === 0) {
                lines.push(`    ✓ ${scoped} → cart=1 home=0 pdp=0 ← USE THIS`);
              }
            } catch {}
          }
          ancestor = ancestor.parentElement;
        }
      }
    } catch {}
  }

  return lines.join('\n');
}

/**
 * Extract the footer/totals section from raw drawer HTML.
 * Searches for footer-like keywords and returns a window around the first match,
 * plus the last N chars (footer is usually at the end of the drawer markup).
 */
function extractDrawerFooterChunk(rawHtml, maxBytes = 3000) {
  if (!rawHtml) return null;
  const clean = rawHtml.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\s+/g, ' ').trim();

  // Keywords that appear near drawer footer / totals blocks
  const FOOTER_RE = /(?:subtotal|checkout|cart[-_]?total|cart[-_]?footer|drawer[-_]?footer|sticky[-_]?bottom|data-subtotal|data-cart-total|\.totals|fc-footer|fc-subtotal|amp-sc__footer|ajaxcart__footer)/i;

  const matchIdx = clean.search(FOOTER_RE);

  // Always include the last portion (footer is usually at the end)
  const tail = clean.slice(-maxBytes);

  if (matchIdx < 0) return tail;

  // Also include a window around the first keyword match
  const windowStart = Math.max(0, matchIdx - 200);
  const windowEnd = Math.min(clean.length, matchIdx + maxBytes);
  const headWindow = clean.slice(windowStart, windowEnd);

  // Return both if they don't overlap; otherwise just the tail
  if (windowEnd < clean.length - maxBytes) {
    return `[Footer keyword match at ~${matchIdx}]:\n${headWindow}\n\n[Last ${maxBytes} chars of drawer]:\n${tail}`;
  }
  return tail;
}

function inspectDrawerContent(crawl, key) {
  const lines = [`INSPECTION ${key}:`];
  if (isTemplateDrawer(crawl)) {
    lines.push('⚠ TEMPLATE DRAWER: content is inside <template data-cart-drawer-template>.');
    lines.push('querySelectorAll CANNOT see inside <template> — counts will always be 0.');
    lines.push('Output your best selector from the template HTML below. It will bypass verification.');
    const content = extractTemplateDrawerContent(crawl.homeHtml || '');
    if (content) {
      const preview = content.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      lines.push('\nTemplate HTML:');
      lines.push(preview);
    }
  } else {
    const { drawerHtml } = crawl;
    if (drawerHtml) {
      // For discount-code key: focus on footer/totals section (may be at end of long HTML)
      // For cvb key: show the beginning (line items are near the top)
      if (key === 'cart-drawer-discount-code') {
        lines.push('Drawer footer/totals section (keyword-anchored + last chars):');
        lines.push(extractDrawerFooterChunk(drawerHtml, 3000) || '(could not extract footer)');
      } else {
        lines.push('Drawer HTML (first 3000 chars):');
        lines.push(drawerHtml.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\s+/g, ' ').trim().slice(0, 3000));
      }
    }
  }
  return lines.join('\n');
}

function buildInspectionHints(failedKeys, crawl) {
  const sections = [];
  for (const key of failedKeys) {
    let hint = null;
    switch (key) {
      case 'product-form-selector': hint = inspectProductForms(crawl); break;
      case 'home-page-cvb': hint = inspectHomeSections(crawl); break;
      case 'cart-icon': hint = inspectCartIconLinks(crawl); break;
      case 'cart-drawer-cvb':
      case 'cart-drawer-discount-code': hint = inspectDrawerContent(crawl, key); break;
      case 'cart-page-discount-code': hint = inspectCartTotals(crawl); break;
      case 'product-page-cvb': hint = inspectProductForms(crawl); break;
    }
    if (hint) sections.push(hint);
  }
  return sections.join('\n\n---\n\n');
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
  const userHints = mergeSelectorHints(
    parseFeedbackSelectors(feedback),
    opts.selectorOverrides,
  );
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
  if (Object.keys(userHints).length) {
    emit({
      type: "log",
      level: "info",
      message: `Parsed selector hints from feedback: ${Object.keys(userHints).join(", ")}`,
    });
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
    crawl = await crawlStorefront(storeUrl, password, emit, { productHandle: opts.productHandle, allowCustomDomain: opts.allowCustomDomain });
  } catch (e) {
    // If home is CF-blocked and no products could be found, emit a CF-blocked result
    if (e.statusCode === 404 && isCloudflareChallenge(e.homeHtml || "")) {
      // Drawer keys default to '' when totally blocked — we can't confirm a drawer exists
      const DRAWER_KEYS = ["cart-drawer-cvb", "cart-drawer-discount-code"];
      const cfSelectors = Object.fromEntries(
        SELECTOR_KEYS.map(k => [k, DRAWER_KEYS.includes(k) ? "" : "❌ CF blocked"])
      );
      const host = String(storeUrl).replace(/^https?:\/\//, "").replace(/\/$/, "");
      const outputJs = `/** ${host} */\n${formatOutputJs(cfSelectors)}\n`;
      emit({ type: "result", selectors: cfSelectors, outputJs, partial: true, missingKeys: SELECTOR_KEYS, elapsedMs: Date.now() - startedAt });
    }
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

  const runDiscoverTurn = async (purpose, stepMessage) => {
    const userBytes = messages[messages.length - 1]?.content?.length || 0;
    emit({
      type: "log",
      level: "info",
      message: `${purpose}: ${userBytes.toLocaleString()} bytes (~${Math.round(userBytes / 4)} tokens est.)`,
    });
    emit({
      type: "step",
      id: "discover",
      status: "running",
      message: stepMessage,
    });

    let llm;
    try {
      llm = await callClaude({
        apiKey,
        model,
        baseUrl,
        system,
        messages,
        emit: (e) => emit({ ...e, purpose: e.purpose || purpose }),
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
    if (reasoningOnly && purpose === "discover") emit({ type: "agent-reply", content: reasoningOnly });
    for (const chunk of chunkReasoningForLog(reasoningOnly)) {
      emit({ type: "log", level: "info", message: chunk });
    }

    messages.push({ role: "assistant", content: llm.text });

    const parsed = parseLlmJson(llm.text);
    if (!parsed || typeof parsed !== "object") {
      const err = new Error("Discover agent could not parse JSON from Claude response.");
      err.statusCode = 502;
      err.rawResponse = llm.text;
      emit({ type: "error", message: err.message });
      throw err;
    }
    return parsed;
  };

  // --- Discover agent: initial LLM pass + correction retries ---
  {
    lastParsed = await runDiscoverTurn(
      "discover",
      `Discover agent — asking Claude (${model})...`,
    );

    emit({
      type: "step",
      id: "verify",
      status: "running",
      message: "DOM verify — selectors from discover agent...",
    });
    let lockedKeys = verifiedUserHints(userHints, crawl);
    ({ selectors, details } = applyAndVerify(lastParsed, crawl, emit, { lockedKeys }));
    applyUserSelectorOverrides(selectors, details, crawl, userHints, emit, "feedback");
    lockedKeys = verifiedUserHints(userHints, crawl);

    for (let turn = 0; turn < MAX_CORRECTION_TURNS; turn++) {
      const needsWork = keysNeedingWork(selectors, crawl, userHints);
      if (!needsWork.length) break;

      emit({
        type: "step",
        id: "discover",
        status: "running",
        message: `Correction pass ${turn + 1}/${MAX_CORRECTION_TURNS} — ${needsWork.join(", ")}`,
      });

      const correction = buildCorrectionMessage(crawl, selectors, details, { userHints });
      messages.push({
        role: "user",
        content: `${correction}\n\n${buildFocusHtml(crawl)}`,
      });

      lastParsed = await runDiscoverTurn(
        "discover-correction",
        `Correction ${turn + 1} — asking Claude (${model})...`,
      );

      lockedKeys = verifiedUserHints(userHints, crawl);
      const merged = { ...selectors };
      const mergedDetails = { ...details };
      const pass = applyAndVerify(lastParsed, crawl, emit, { lockedKeys });
      for (const key of SELECTOR_KEYS) {
        if (lockedKeys[key]) continue;
        if (pass.selectors[key]) {
          merged[key] = pass.selectors[key];
          mergedDetails[key] = pass.details[key];
        }
      }
      selectors = merged;
      details = mergedDetails;
      applyUserSelectorOverrides(selectors, details, crawl, userHints, emit, "feedback");
      lockedKeys = verifiedUserHints(userHints, crawl);
      for (const [key, val] of Object.entries(lockedKeys)) {
        selectors[key] = val;
      }
    }

    // --- Inspection pass: targeted HTML analysis for still-failing keys ---
    {
      const needsInspection = mandatoryKeys(crawl.hasDrawer).filter((k) => !selectors[k]);
      emit({ type: 'log', level: 'info', message: `Inspection gate: needsInspection=[${needsInspection.join(', ')}]` });
      if (needsInspection.length) {
        let inspectionHints = '';
        try {
          inspectionHints = buildInspectionHints(needsInspection, crawl);
        } catch (e) {
          emit({ type: 'log', level: 'warn', message: `buildInspectionHints threw: ${e?.message}` });
        }
        emit({ type: 'log', level: 'info', message: `Inspection hints length: ${inspectionHints?.length ?? 0}` });
        if (inspectionHints) {
          emit({
            type: 'step', id: 'discover', status: 'running',
            message: `Inspection pass — ${needsInspection.join(', ')}`,
          });

          const inspectionCorrectionMsg = [
            `Targeted HTML inspection for still-failing keys: ${needsInspection.join(', ')}.`,
            'The data below was extracted directly from the crawled HTML pages.',
            'Use it to produce correct selectors. Return a complete ```json block with ALL 8 keys.',
            '',
            buildCorrectionMessage(crawl, selectors, details, { userHints }),
            '',
            '=== TARGETED INSPECTION DATA ===',
            inspectionHints,
          ].join('\n');

          messages.push({ role: 'user', content: inspectionCorrectionMsg });

          let inspParsed;
          try {
            inspParsed = await runDiscoverTurn('discover-inspection', `Inspection pass — asking Claude (${model})...`);
          } catch (e) {
            emit({ type: 'log', level: 'warn', message: `Inspection pass failed: ${e.message}` });
            inspParsed = null;
          }

          if (inspParsed) {
            const lockedKeys = verifiedUserHints(userHints, crawl);
            const pass = applyAndVerify(inspParsed, crawl, emit, { lockedKeys });
            for (const key of SELECTOR_KEYS) {
              if (lockedKeys[key]) continue;
              if (pass.selectors[key]) {
                selectors[key] = pass.selectors[key];
                details[key] = pass.details[key];
              }
            }
            applyUserSelectorOverrides(selectors, details, crawl, userHints, emit, 'feedback');

            // Template-drawer bypass: if drawer content is in <template>, accept
            // the LLM's selector even though querySelectorAll returns count=0.
            if (crawl.hasDrawer && isTemplateDrawer(crawl)) {
              for (const key of ['cart-drawer-cvb', 'cart-drawer-discount-code']) {
                if (!selectors[key]) {
                  const raw = typeof inspParsed[key] === 'string' ? inspParsed[key].trim() : '';
                  if (raw && !selectorSurfaceCheck(raw)) {
                    selectors[key] = raw;
                    emit({
                      type: 'selector', key, value: raw, llmRaw: raw,
                      verify: { ok: true, note: 'template-drawer — verified from HTML inspection' },
                      source: 'inspection',
                    });
                    emit({ type: 'log', level: 'info', message: `  ✓ ${key}: ${raw} (template-drawer bypass)` });
                  }
                }
              }
            }
          }
        }
      }
    }

    const failedKeys = mandatoryKeys(crawl.hasDrawer).filter((k) => !selectors[k]);
    emit({
      type: "step",
      id: "verify",
      status: failedKeys.length ? "failed" : "done",
      message: failedKeys.length
        ? `${failedKeys.length} key(s) failed: ${failedKeys.join(", ")}`
        : "All selectors verified",
    });
  }

  const elapsedMs = Date.now() - startedAt;
  applyUserSelectorOverrides(selectors, details, crawl, userHints, emit, "feedback-final");
  for (const [key, val] of Object.entries(verifiedUserHints(userHints, crawl))) {
    selectors[key] = val;
  }

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

  applyUserSelectorOverrides(selectors, details, crawl, userHints, emit, "feedback-final");
  for (const [key, val] of Object.entries(verifiedUserHints(userHints, crawl))) {
    selectors[key] = val;
  }

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
  buildDomProbeHints,
  applyAndVerify,
  buildOutputPayload,
  buildBestEffortSelectors,
};
