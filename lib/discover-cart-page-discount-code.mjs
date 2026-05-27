import { parseHTML } from "linkedom";
import { normalizeStoreUrl, effectiveStoreBase } from "./discover-selector.mjs";
import {
  createSession,
  extractVariantIdFromPdp,
  buildCartAddItems,
} from "./cart-drawer-html.mjs";
import { openStoreHome } from "./store-session.mjs";

/**
 * Stable wrappers on the /cart page that sit directly around the totals block.
 * Anything inserted at the top of this wrapper renders above the total price
 * (the natural slot for a discount-code UI on the cart page). We do NOT search
 * for "discount" or "coupon" class names, and we do NOT require the word
 * "footer" — the matched element just has to contain the totals/subtotal block
 * and live on the cart page.
 */
const CART_PAGE_TOTALS_WRAPPER_CANDIDATES = [
  // Dawn / Horizon cart page
  "form#cart .cart__blocks",
  ".cart__blocks",
  "form#cart .cart__footer .cart__blocks",
  "form#cart .cart__footer",
  ".cart__footer",
  // Vintage Shopify cart
  "form#cart .cart__totals",
  "form[action=\"/cart\"] .cart__totals",
  "form[action=\"/cart\"] .totals",
  // Other custom themes
  ".cart-page__totals",
  ".cart-page__summary",
];

const TOTALS_SELECTOR = [
  ".totals",
  ".totals__subtotal",
  ".totals__total",
  ".cart-footer__total",
  ".cart__total",
  '[data-cart-total]',
  '[data-cart-subtotal]',
].join(", ");

const CART_UI_SCOPES = [
  "form#cart",
  "form[action=\"/cart\"]",
  "body.cart",
  "body.template-cart",
  "main#MainContent",
  "main#root",
];

function isOnCartPage(doc) {
  if (doc.body?.classList?.contains?.("cart")) return true;
  if (doc.body?.classList?.contains?.("template-cart")) return true;
  if (doc.querySelector('link[rel="canonical"][href$="/cart"]')) return true;
  if (
    doc.querySelector(
      'cart-items, #main-cart-items, form#cart, form[action="/cart"], form[action$="/cart"]',
    )
  ) {
    return true;
  }
  return false;
}

function isOnCartPageScope(el) {
  for (const sel of CART_UI_SCOPES) {
    try {
      if (el.closest(sel)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function containsTotalsBlock(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.querySelector(TOTALS_SELECTOR)) return true;
  const text = (el.textContent || "").trim();
  if (/\b(Subtotal|Estimated total|Order total|Cart total)\b/i.test(text)) return true;
  return false;
}

function isInsideCartDrawer(el) {
  try {
    return !!el.closest("cart-drawer, #CartDrawer, .cart-drawer, mini-cart, .mini-cart");
  } catch {
    return false;
  }
}

function verifyCartPageTotalsWrapper(cartDoc, homeDoc, productDoc, selector) {
  if (/shopify-section-template--\d+__/.test(selector)) {
    return { ok: false, cartCount: 0, homeCount: 0, productCount: 0, rejected: "dynamic-section-id" };
  }
  let cartCount = 0;
  let homeCount = 0;
  let productCount = 0;
  try {
    cartCount = cartDoc.querySelectorAll(selector).length;
    homeCount = homeDoc.querySelectorAll(selector).length;
    productCount = productDoc.querySelectorAll(selector).length;
  } catch {
    return { ok: false, cartCount: -1, homeCount: -1, productCount: -1 };
  }
  if (cartCount !== 1) {
    return { ok: false, cartCount, homeCount, productCount };
  }
  if (!isOnCartPage(cartDoc)) {
    return { ok: false, cartCount, homeCount, productCount, rejected: "not-cart-page" };
  }
  const el = cartDoc.querySelector(selector);
  if (isInsideCartDrawer(el)) {
    return { ok: false, cartCount, homeCount, productCount, rejected: "inside-cart-drawer" };
  }
  if (!isOnCartPageScope(el)) {
    return { ok: false, cartCount, homeCount, productCount, rejected: "not-cart-scope" };
  }
  if (!containsTotalsBlock(el)) {
    return { ok: false, cartCount, homeCount, productCount, rejected: "no-totals-inside" };
  }
  return { ok: homeCount === 0 && productCount === 0, cartCount, homeCount, productCount };
}

function firstProductHandle(html) {
  const seen = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].trim();
    let tail = "";
    if (raw.startsWith("/products/")) tail = raw.slice("/products/".length);
    else if (raw.includes("/products/")) tail = raw.split("/products/")[1];
    else continue;
    tail = tail.split("?")[0].split("#")[0].replace(/^\/+/, "");
    const handle = tail.split("/")[0];
    if (!handle || !/^[a-zA-Z0-9][-a-zA-Z0-9_]*$/.test(handle) || seen.has(handle)) continue;
    seen.add(handle);
    return handle;
  }
  return null;
}

/**
 * /cart page totals wrapper — the container on the cart page that contains the
 * totals/checkout block. Inserting content at the top of this element renders
 * it above the total price.
 *
 * Verification: cart=1, home=0, PDP=0; element is on /cart, not inside a cart
 * drawer, and contains a totals/subtotal block.
 *
 * Returns "" when the theme's /cart page has no stable wrapper around totals.
 */
export async function discoverCartPageDiscountCode(storeUrl, storePassword = "") {
  const myshopifyBase = normalizeStoreUrl(storeUrl);
  const password = String(storePassword || "").trim();
  const { fetchWithCookies } = createSession();
  const home = await openStoreHome(myshopifyBase, password, fetchWithCookies);

  const base = effectiveStoreBase(home.finalUrl, myshopifyBase);

  const handle = firstProductHandle(home.html);
  if (!handle) {
    return {
      ok: true,
      storeUrl: base,
      selector: "",
      description: "No product link on home; cannot probe cart page totals wrapper.",
    };
  }

  const productUrl = new URL(`/products/${handle}`, base).href;
  const productPage = await fetchWithCookies(productUrl);

  // Add one item so cart totals actually render, then GET /cart.
  const variantId = extractVariantIdFromPdp(productPage.html);
  if (variantId) {
    try {
      await fetchWithCookies(new URL("/cart/add.js", base).href, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ items: buildCartAddItems(variantId, productPage.html) }),
      });
    } catch {
      /* if add fails, fall through and probe whatever /cart returns */
    }
  }

  const cartPage = await fetchWithCookies(new URL("/cart", base).href);

  const cartDoc = parseHTML(cartPage.html).document;
  const homeDoc = parseHTML(home.html).document;
  const productDoc = parseHTML(productPage.html).document;

  const tried = [];

  for (const selector of CART_PAGE_TOTALS_WRAPPER_CANDIDATES) {
    const v = verifyCartPageTotalsWrapper(cartDoc, homeDoc, productDoc, selector);
    tried.push({ selector, ...v, method: "cart-page-totals-wrapper" });
    if (v.ok) {
      return {
        ok: true,
        storeUrl: base,
        productUrl,
        selector,
        description: "Wrapper on /cart page that contains the totals block.",
        tried,
      };
    }
  }

  return {
    ok: true,
    storeUrl: base,
    productUrl,
    selector: "",
    description: "No stable totals wrapper on the cart page.",
    tried,
  };
}
