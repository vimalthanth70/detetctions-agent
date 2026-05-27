import {
  CART_UI_ROOT_SELECTORS,
  loadCartDrawerDocument,
} from "./cart-drawer-html.mjs";

const ITEMS_CONTAINER_CANDIDATES = [
  'section[x-show="cart_drawer"] section.flex-grow.overflow-y-auto',
  'section[x-show="cart_drawer"] section.overflow-y-auto',
  'section[x-show="cart_drawer"] template[x-for*="cart.items"]',
  "cart-drawer #CartDrawer-CartItems",
  "#CartDrawer-CartItems",
  "cart-drawer .drawer__cart-items-wrapper",
  "cart-drawer table.cart-items",
  "cart-drawer cart-items ul[role='list']",
  "cart-drawer cart-items ul",
  "cart-drawer cart-items",
  "#CartDrawer cart-items",
  "cart-drawer-items",
  ".mini-cart .product-cards-container",
  "mini-cart .product-cards-container",
  "cart-drawer .cart-items",
  "cart-drawer [class*='cart-items']",
];

const LINE_ITEM_SELECTORS =
  "cart-item, .cart-item, .line-item, tr.cart-item, [id^='CartDrawer-Item'], [id^='CartItem-'], [data-cart-item], li, template[x-for*='cart.items']";

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

function countLineItems(container) {
  if (!container) return 0;
  try {
    return container.querySelectorAll(LINE_ITEM_SELECTORS).length;
  } catch {
    return 0;
  }
}

function isItemsContainer(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName?.toLowerCase();
  const id = el.id || "";
  const cls = (el.className || "").toString();
  if (id === "CartDrawer-CartItems" || id.includes("CartDrawer-Items")) return true;
  if (cls.includes("product-cards-container")) return true;
  if (cls.includes("drawer__cart-items")) return true;
  if (tag === "cart-items") return true;
  if (cls.includes("cart-items") && !cls.includes("cart-item__")) return true;
  if (tag === "table" && cls.includes("cart-items")) return true;
  if (tag === "ul" && el.getAttribute("role") === "list") {
    return !!el.closest("cart-drawer, mini-cart, .mini-cart, .cart-drawer");
  }
  if (tag === "template") {
    const xfor = el.getAttribute("x-for") || "";
    if (/cart\.items/.test(xfor)) {
      return !!el.closest('section[x-show="cart_drawer"], cart-drawer, .cart-drawer, mini-cart');
    }
  }
  if (tag === "section") {
    const cls = (el.className || "").toString();
    if (
      (cls.includes("overflow-y-auto") || cls.includes("flex-grow")) &&
      el.closest('section[x-show="cart_drawer"]')
    ) {
      return true;
    }
  }
  return false;
}

function verifyItemsContainer(doc, selector, options = {}) {
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
  if (!isItemsContainer(el)) {
    return { ok: false, count: 1, rejected: "not-items-container" };
  }
  const lineCount = countLineItems(el);
  if (lineCount < 1 && !options.allowEmptyLineItems) {
    return { ok: false, count: 1, lineCount: 0, rejected: "no-line-items" };
  }
  if (!isInsideCartUi(el)) {
    return { ok: false, count: 1, rejected: "outside-cart-ui" };
  }
  return { ok: true, count: 1, lineCount };
}

/**
 * Cart drawer / cart-popup line-items container. Adds one product to cart first.
 * Returns selector "" when no cart UI.
 */
export async function discoverCartDrawerCvb(storeUrl, storePassword = "") {
  const loaded = await loadCartDrawerDocument(storeUrl, storePassword);

  if (!loaded.hasDrawer) {
    return {
      ok: true,
      storeUrl: loaded.storeUrl || storeUrl,
      selector: "",
      hasDrawer: false,
      description: "No cart drawer or cart-popup on this storefront.",
    };
  }

  const doc = loaded.document;
  const verifyOptions = { allowEmptyLineItems: true };
  const tried = [];

  let fallback = null;
  for (const selector of ITEMS_CONTAINER_CANDIDATES) {
    const v = verifyItemsContainer(doc, selector, verifyOptions);
    tried.push({ selector, ...v, method: "stable-candidate" });
    if (v.ok && v.lineCount >= 1) {
      return {
        ok: true,
        storeUrl: loaded.storeUrl,
        productUrl: loaded.productUrl,
        selector,
        hasDrawer: true,
        description: "Line items container inside cart drawer or cart-popup.",
        tried,
      };
    }
    if (v.ok && !fallback) fallback = { selector, tried };
  }

  if (fallback) {
    return {
      ok: true,
      storeUrl: loaded.storeUrl,
      productUrl: loaded.productUrl,
      selector: fallback.selector,
      hasDrawer: true,
      description: "Line items container (cart-popup; items may hydrate via JS).",
      tried: fallback.tried,
    };
  }

  const err = new Error(
    "Cart UI present but no stable line-items container selector found.",
  );
  err.statusCode = 422;
  err.tried = tried;
  throw err;
}
