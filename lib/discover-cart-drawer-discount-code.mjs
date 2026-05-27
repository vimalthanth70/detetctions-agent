import { CART_UI_ROOT_SELECTORS, loadCartDrawerDocument } from "./cart-drawer-html.mjs";

/**
 * Stable wrappers inside the cart drawer / cart-popup / mini-cart that sit
 * directly around the totals block. Anything inserted at the top of this
 * wrapper renders above the total price (the natural slot for a discount-code
 * UI). We do NOT search for "discount" or "coupon" class names, and we do NOT
 * require the word "footer" — the matched element just has to contain the
 * totals/subtotal element and live inside the cart drawer UI.
 */
const DRAWER_TOTALS_WRAPPER_CANDIDATES = [
  // Dawn / Cactus drawer
  "cart-drawer .cart-drawer__footer",
  "#CartDrawer .cart-drawer__footer",
  "cart-drawer .drawer__footer",
  "#CartDrawer .drawer__footer",
  // Alpine slide-in drawer
  'section[x-show="cart_drawer"] aside',
  'section[x-show="cart_drawer"] aside form[action="/cart"]',
  // Mini-cart popup (Isomers)
  "mini-cart ul.ctas",
  ".mini-cart ul.ctas",
];

const TOTALS_SELECTOR = [
  ".totals",
  ".totals__subtotal",
  ".totals__total",
  ".cart-drawer__totals",
  ".cart-footer__total",
  '[data-cart-total]',
  '[data-cart-subtotal]',
].join(", ");

function isInsideCartUi(el) {
  for (const sel of CART_UI_ROOT_SELECTORS) {
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
  if (/\b(Subtotal|Estimated total|Order total)\b/i.test(text)) return true;
  return false;
}

function verifyTotalsWrapper(doc, selector) {
  if (/shopify-section-template--\d+__/.test(selector)) {
    return { ok: false, count: 0, rejected: "dynamic-section-id" };
  }
  let nodes;
  try {
    nodes = doc.querySelectorAll(selector);
  } catch {
    return { ok: false, count: -1 };
  }
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  const el = nodes[0];
  if (!isInsideCartUi(el)) return { ok: false, count: 1, rejected: "outside-cart-ui" };
  if (!containsTotalsBlock(el)) return { ok: false, count: 1, rejected: "no-totals-inside" };
  return { ok: true, count: 1 };
}

/**
 * Cart drawer / cart-popup totals wrapper — the container inside the drawer
 * that holds the totals/checkout block. Inserting content at the top of this
 * element renders it above the total price. Returns "" when no cart drawer.
 */
export async function discoverCartDrawerDiscountCode(storeUrl, storePassword = "") {
  const loaded = await loadCartDrawerDocument(storeUrl, storePassword);

  if (!loaded.hasDrawer) {
    return {
      ok: true,
      selector: "",
      hasDrawer: false,
      description: "No cart drawer or cart-popup — no totals wrapper.",
    };
  }

  const doc = loaded.document;
  const tried = [];

  for (const selector of DRAWER_TOTALS_WRAPPER_CANDIDATES) {
    const v = verifyTotalsWrapper(doc, selector);
    tried.push({ selector, ...v, method: "drawer-totals-wrapper" });
    if (v.ok) {
      return {
        ok: true,
        storeUrl: loaded.storeUrl,
        productUrl: loaded.productUrl,
        selector,
        hasDrawer: true,
        description: "Wrapper inside cart drawer that contains the totals block.",
        tried,
      };
    }
  }

  return {
    ok: true,
    storeUrl: loaded.storeUrl,
    productUrl: loaded.productUrl,
    selector: "",
    hasDrawer: true,
    description: "Cart drawer present but no stable totals-wrapper selector found.",
    tried,
  };
}
