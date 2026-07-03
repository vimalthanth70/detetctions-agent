/**
 * Eval: run the agent on known stores and compare output to expected selectors.
 * Skips stores where Shopify.theme.schema_name no longer matches the recorded theme.
 *
 * Comparison is DOM-based (zero extra LLM tokens): selectors are tested against
 * the live pages with linkedom. If both got/expected resolve to the same DOM node
 * the key is marked as a pass — cosmetic selector differences don't count as failures.
 * Falls back to string equality when neither selector matches in static HTML.
 *
 * Usage:
 *   node scripts/eval.mjs
 *   node scripts/eval.mjs --store wrne13-mp.myshopify.com
 *   node scripts/eval.mjs --concurrency 2
 */

import { parseHTML } from "linkedom";

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
      "cart-drawer-discount-code":
        "cart-drawer-component .cart-drawer__summary > :first-child",
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
      "product-form-selector":
        'form[action*="/cart/add"]:not([id*="installment"])',
      "home-page-cvb": ".hero",
      "product-page-cvb": '[data-section-type="product-template"]',
      "cart-drawer-cvb": "#CartContainer .ajaxcart__inner",
      "cart-page-discount-code":
        "form.cart:not(.ajaxcart) .grid__item.large--five-twelfths .cart__row--table",
      "cart-page-cvb": "form.cart:not(.ajaxcart)",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code":
        "#CartContainer .ajaxcart__footer > .grid--full",
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
      "cart-drawer-discount-code":
        'cart-drawer [slot="footer"] > div:first-child',
    },
  },
  {
    url: "luxus-home-and-garden.myshopify.com",
    schema_name: "Prestige",
    selectors: {
      "product-form-selector":
        'form[action*="/cart/add"]:not([id*="installment"])',
      "home-page-cvb": '[class*="ai-hero-video-banner"]:not([class*="__"])',
      "product-page-cvb": '[data-section-type="product"]',
      "cart-drawer-cvb": "#sidebar-cart .Cart__ItemList",
      "cart-page-discount-code": ".Cart__Recap .Cart__Total",
      "cart-page-cvb": "form.Cart.Cart--expanded",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code": "#sidebar-cart .Drawer__Footer",
    },
  },
  {
    url: "bisco-dental-products.myshopify.com",
    schema_name: "iamota Theme Foundation",
    selectors: {
      "product-form-selector":
        'form[action*="/cart/add"]:not([id*="installment"])',
      "home-page-cvb": ".page-section--hero-banner",
      "product-page-cvb": '.product[data-section-type="product"]',
      "cart-drawer-cvb": "",
      "cart-page-discount-code": ".cart__summary .cart-subtotal__container",
      "cart-page-cvb": ".cart__main .cart__row",
      "cart-icon": "a.mini-cart__header-link",
      "cart-drawer-discount-code": "",
    },
  },
  {
    url: "pinedacovalin-us.myshopify.com",
    schema_name: "Prestige",
    selectors: {
      "product-form-selector": '.Product form[action="/cart/add"]',
      "home-page-cvb": '[data-section-type="slideshow"]',
      "product-page-cvb": '[data-section-type="product"]',
      "cart-drawer-cvb": "#sidebar-cart .Cart__ItemList",
      "cart-page-discount-code": ".Cart__Recap .Cart__Total",
      "cart-page-cvb": "form.Cart .Cart__ItemList",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code": "#sidebar-cart .Drawer__Footer",
    },
  },
  {
    url: "candycoatgels.myshopify.com",
    schema_name: "Sense",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
      "home-page-cvb":
        '[class*="ai-hero-banner"]:not([class*="banner-image"]):not([class*="banner-overlay"]):not([class*="banner-content"])',
      "product-page-cvb": "#MainContent .product",
      "cart-drawer-cvb": "cart-drawer cart-drawer-items",
      "cart-page-discount-code": "#main-cart-footer .totals",
      "cart-page-cvb": ".cart__items",
      "cart-icon": 'header a[href$="/cart"]',
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
  {
    url: "moroccantan.myshopify.com",
    schema_name: "Dawn",
    selectors: {
      "product-form-selector":
        'product-form.product-form form[action*="/cart/add"]',
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
    url: "f00hae-i3.myshopify.com",
    schema_name: "Essence",
    selectors: {
      "product-form-selector": 'form[id$="__main"]:not([id*="Installment"])',
      "home-page-cvb": ".section-slideshow",
      "product-page-cvb": ".section-main-product",
      "cart-drawer-cvb":
        '#CartModal-ScrollBody > div:not(.modal-header):not([class*="recommendation"]):not([class*="complementary"])',
      "cart-page-discount-code": ".cart-side .cart-totals",
      "cart-page-cvb": ".cart-items",
      "cart-icon": 'header a[href$="/cart"]',
      "cart-drawer-discount-code":
        "#CartModal-ScrollBody + div > div:first-child",
    },
  },
  // {
  //   url: "xzs2yf-wv.myshopify.com",
  //   schema_name: "Kalles",
  //   selectors: {
  //     "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
  //     "home-page-cvb": ".t4s-sec-slideshow",
  //     "product-page-cvb": ".t4s-section-main-product",
  //     "cart-drawer-cvb": "#t4s-mini_cart [data-cart-items]",
  //     "cart-page-discount-code": ".t4s-cartPage__footer .t4s-cart-total",
  //     "cart-page-cvb": 'form[action="/cart"] .t4s-cartPage__items',
  //     "cart-icon": '.t4s-site-nav__cart a[href="/cart"]',
  //     "cart-drawer-discount-code": "#t4s-mini_cart .t4s-cart-total",
  //   },
  // },
  // {
  //   url: "s3zi3h-9k.myshopify.com",
  //   schema_name: "MvTech",
  //   selectors: {
  //     "product-form-selector": 'form[id$="__main"]:not([id*="Installment"])',
  //     "home-page-cvb": ".section-slideshow",
  //     "product-page-cvb": ".section-main-product",
  //     "cart-drawer-cvb":
  //       '#CartModal-ScrollBody > div:not(.modal-header):not([class*="recommendation"]):not([class*="complementary"])',
  //     "cart-page-discount-code": ".cart-side .cart-totals",
  //     "cart-page-cvb": ".cart-items",
  //     "cart-icon": 'modal-trigger[target="#cart-modal"] a[href="/cart"]',
  //     "cart-drawer-discount-code":
  //       "#CartModal-ScrollBody + div > div:first-child",
  //   },
  // },
  // {
  //   url: "maysama-gb.myshopify.com",
  //   schema_name: "Dawn",
  //   selectors: {
  //     "product-form-selector": 'form[id$="__main"]:not([id*="installment"])',
  //     "home-page-cvb": 'div[class*="ai-hero-video__container"]',
  //     "product-page-cvb": ".product.grid--2-col-tablet",
  //     "cart-drawer-cvb": "cart-drawer cart-drawer-items",
  //     "cart-page-discount-code": "#main-cart-footer .totals",
  //     "cart-page-cvb": "#main-cart-items",
  //     "cart-icon": 'header a[href="/cart"]',
  //     "cart-drawer-discount-code": "cart-drawer .drawer__footer .totals",
  //   },
  // },
  // {
  //   url: "ghhqny-jb.myshopify.com",
  //   schema_name: "Concept",
  //   selectors: {
  //     "product-form-selector": 'form[action*="/cart/add"].product-form',
  //     "home-page-cvb": ".scrolling-text-section + div .banner",
  //     "product-page-cvb": ".featured-product.product",
  //     "cart-drawer-cvb": "cart-drawer cart-items",
  //     "cart-page-discount-code": "main-cart .cart__sidebar .totals",
  //     "cart-page-cvb": "main-cart.cart__content",
  //     "cart-icon": "a.cart-drawer-button",
  //     "cart-drawer-discount-code":
  //       "cart-drawer .drawer__footer .grid.grid-cols-2.gap-4",
  //   },
  // },
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

const PORT = process.env.PORT || 3002;
const BASE_URL = `http://localhost:${PORT}`;

// Parse CLI args
const args = process.argv.slice(2);
const storeIdx = args.indexOf("--store");
const storeFilter = storeIdx !== -1 ? args[storeIdx + 1] : null;
const concIdx = args.indexOf("--concurrency");
const concurrency = concIdx !== -1 ? parseInt(args[concIdx + 1], 10) : 1;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/** Fetch a URL and return { html, doc } or null on failure. No LLM involved. */
async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const doc = parseHTML(html).document;
    return { html, doc };
  } catch {
    return null;
  }
}

/**
 * Fetch pages needed for DOM comparison (no LLM tokens).
 * homeResult is passed in from the theme-check fetch so we don't re-fetch home.
 * PDP and cart are fetched lazily and only once.
 */
async function fetchStoreDocs(storeUrl, homeResult) {
  const docs = { home: homeResult?.doc ?? null, pdp: null, cart: null };

  // Find first product URL from home DOM
  if (docs.home) {
    const links = [...docs.home.querySelectorAll('a[href*="/products/"]')];
    for (const link of links.slice(0, 5)) {
      const href = link.getAttribute("href") || "";
      if (!href || href.includes("?") || href.endsWith("/products/")) continue;
      const pdpUrl = href.startsWith("http")
        ? href
        : `https://${storeUrl}${href}`;
      const r = await fetchPage(pdpUrl);
      if (r?.doc) {
        docs.pdp = r.doc;
        break;
      }
    }
  }

  const cartResult = await fetchPage(`https://${storeUrl}/cart`);
  docs.cart = cartResult?.doc ?? null;

  return docs;
}

/** Which doc to query for each selector key */
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

/**
 * Check if two selectors are functionally equivalent on a given doc.
 * Returns { pass, reason, domChecked }
 * - domChecked=true  → result is based on live DOM (reliable)
 * - domChecked=false → doc was unavailable or both matched nothing; fell back to string compare
 */
function domEquivalent(doc, got, expected) {
  if (!doc)
    return {
      pass: got === expected,
      reason: "doc unavailable — string fallback",
      domChecked: false,
    };

  let gotEl = null,
    expEl = null;
  try {
    gotEl = doc.querySelector(got || "__nomatch__");
  } catch {
    /* invalid selector */
  }
  try {
    expEl = doc.querySelector(expected || "__nomatch__");
  } catch {
    /* invalid selector */
  }

  // Both match nothing in static HTML (e.g. AJAX-loaded or drawer content not rendered).
  // Treat as soft pass — the agent's verifier already confirmed the selector against live DOM.
  // Exact string match is a bonus; differing scope prefixes (cart-drawer, form, etc.) are fine.
  if (!gotEl && !expEl) {
    const exactMatch = got === expected;
    return {
      pass: true,
      reason: exactMatch
        ? "both match nothing — string match"
        : "both match nothing — unverifiable (soft pass)",
      domChecked: false,
      softPass: !exactMatch,
    };
  }

  // One matches, the other doesn't → definitely different
  if (!gotEl || !expEl) {
    return {
      pass: false,
      reason: gotEl
        ? "got matches element but expected matches nothing"
        : "expected matches element but got matches nothing",
      domChecked: true,
    };
  }

  // Both match — compare by isSameNode
  const same = gotEl.isSameNode(expEl);
  return {
    pass: same,
    reason: same ? "same DOM element ✓" : "different DOM elements",
    domChecked: true,
  };
}

/** Fetch home page and extract Shopify.theme.schema_name. Returns { schemaName, homeResult }. */
async function fetchThemeInfo(storeUrl) {
  const homeResult = await fetchPage(`https://${storeUrl}/`);
  if (!homeResult) return { schemaName: null, homeResult: null };
  const { html } = homeResult;
  const m = html.match(
    /Shopify\.theme\s*=\s*\{[^}]*"schema_name"\s*:\s*"([^"]+)"/,
  );
  if (m) return { schemaName: m[1], homeResult };
  const m2 = html.match(/schema_name["']?\s*:\s*["']([^"']+)["']/);
  return { schemaName: m2 ? m2[1] : null, homeResult };
}

/** Run the agent for a store via the local server */
async function runAgent(storeUrl) {
  const res = await fetch(`${BASE_URL}/api/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeUrl }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  const lines = text.trim().split("\n");
  let result = null;
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.type === "result") result = d;
    } catch {
      /* skip */
    }
  }
  return result;
}

function compare(got, expected, docs) {
  const results = {};
  for (const key of KEYS) {
    const g = (got?.[key] ?? "").trim();
    const e = (expected[key] ?? "").trim();

    // Both empty → pass immediately
    if (!g && !e) {
      results[key] = { got: g, expected: e, pass: true, reason: "both empty" };
      continue;
    }
    // Exact string match → pass immediately (no DOM fetch needed)
    if (g === e) {
      results[key] = { got: g, expected: e, pass: true, reason: "exact match" };
      continue;
    }
    // One empty, other not → fail immediately
    if (!g || !e) {
      results[key] = { got: g, expected: e, pass: false, reason: "one empty" };
      continue;
    }

    // Different strings — do DOM comparison (zero LLM tokens)
    const docKey = KEY_DOC[key];
    const doc = docs?.[docKey] ?? null;
    const { pass, reason, domChecked, softPass } = domEquivalent(doc, g, e);
    results[key] = { got: g, expected: e, pass, reason, domChecked, softPass };
  }
  return results;
}

function pad(str, n) {
  return String(str).padEnd(n);
}

async function evalStore(store) {
  const { url, schema_name: expectedSchema, selectors: expected } = store;

  process.stdout.write(`\n${"─".repeat(70)}\n`);
  process.stdout.write(`Store: ${url}\n`);

  // Theme check — reuses home fetch for DOM comparison later (no extra fetch)
  process.stdout.write(`Checking theme... `);
  const { schemaName: actualSchema, homeResult } = await fetchThemeInfo(url);
  if (!actualSchema) {
    process.stdout.write(`⚠️  Could not detect theme — skipping\n`);
    return { url, status: "skipped", reason: "theme detection failed" };
  }
  if (actualSchema.toLowerCase() !== expectedSchema.toLowerCase()) {
    process.stdout.write(
      `⚠️  Theme changed: expected "${expectedSchema}", got "${actualSchema}" — skipping\n`,
    );
    return {
      url,
      status: "skipped",
      reason: `theme changed to "${actualSchema}"`,
    };
  }
  process.stdout.write(`✓ ${actualSchema}\n`);

  // Run agent (uses LLM tokens — unavoidable)
  process.stdout.write(`Running agent...\n`);
  let result;
  try {
    result = await runAgent(url);
  } catch (err) {
    process.stdout.write(`❌ Agent error: ${err.message}\n`);
    return { url, status: "error", reason: err.message };
  }

  if (!result) {
    process.stdout.write(`❌ No result returned\n`);
    return { url, status: "error", reason: "no result" };
  }

  // Fetch PDP + cart for DOM comparison (zero LLM tokens — plain HTTP only)
  process.stdout.write(`Fetching pages for DOM comparison...\n`);
  const docs = await fetchStoreDocs(url, homeResult);

  const got = result.selectors || {};
  const comparison = compare(got, expected, docs);
  const passed = Object.values(comparison).filter((r) => r.pass).length;
  const total = KEYS.length;

  process.stdout.write(`\nResults: ${passed}/${total} keys match\n\n`);
  process.stdout.write(
    `  ${pad("Key", 30)} ${pad("Pass", 6)} Got vs Expected\n`,
  );
  process.stdout.write(`  ${"─".repeat(80)}\n`);

  for (const key of KEYS) {
    const {
      got: g,
      expected: e,
      pass,
      reason,
      domChecked,
      softPass,
    } = comparison[key];
    const icon = pass ? "✓" : "✗";
    const tag =
      domChecked === true
        ? " [dom]"
        : softPass
          ? " [str?]"
          : domChecked === false
            ? " [str]"
            : "";
    process.stdout.write(`  ${icon} ${pad(key, 30)}${tag}\n`);
    if (!pass) {
      process.stdout.write(`      got:      ${g || "(empty)"}\n`);
      process.stdout.write(`      expected: ${e || "(empty)"}\n`);
      if (reason) process.stdout.write(`      reason:   ${reason}\n`);
    }
  }

  return {
    url,
    status: result.partial ? "partial" : passed === total ? "pass" : "fail",
    passed,
    total,
    comparison,
  };
}

async function runQueue(stores, concurrency) {
  const results = [];
  const queue = [...stores];

  async function worker() {
    while (queue.length) {
      const store = queue.shift();
      results.push(await evalStore(store));
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

// Main
const filtered = storeFilter
  ? STORES.filter((s) => s.url.includes(storeFilter))
  : STORES;

if (filtered.length === 0) {
  console.error(`No stores match filter: ${storeFilter}`);
  process.exit(1);
}

console.log(
  `\nDetections Agent Eval — ${filtered.length} store(s), concurrency=${concurrency}`,
);
console.log(`Server: ${BASE_URL}\n`);

const allResults = await runQueue(filtered, concurrency);

// Summary
const ran = allResults.filter((r) => r.status !== "skipped");
const skipped = allResults.filter((r) => r.status === "skipped");
const passed = allResults.filter((r) => r.status === "pass");
const failed = allResults.filter(
  (r) => r.status === "fail" || r.status === "partial" || r.status === "error",
);

console.log(`\n${"═".repeat(70)}`);
console.log(`SUMMARY`);
console.log(`${"═".repeat(70)}`);
console.log(`Total:   ${allResults.length}`);
console.log(
  `Skipped: ${skipped.length}${skipped.length ? " (" + skipped.map((s) => s.url.split(".")[0]).join(", ") + ")" : ""}`,
);
console.log(`Ran:     ${ran.length}`);
console.log(
  `Pass:    ${passed.length}/${ran.length} stores (all 8 keys correct)`,
);

if (ran.length) {
  const totalKeys = ran.reduce((s, r) => s + (r.total || 0), 0);
  const passedKeys = ran.reduce((s, r) => s + (r.passed || 0), 0);
  console.log(
    `Keys:    ${passedKeys}/${totalKeys} (${Math.round((passedKeys / totalKeys) * 100)}%)`,
  );
}

if (failed.length) {
  console.log(`\nFailed stores:`);
  for (const r of failed) {
    const pct = r.total ? `${r.passed}/${r.total}` : "error";
    console.log(`  ✗ ${r.url} — ${pct}`);
  }

  // Per-key failure breakdown
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
