import { parseHTML } from "linkedom";
import { normalizeStoreUrl, effectiveStoreBase } from "./discover-selector.mjs";
import {
  createSession,
  extractVariantIdFromPdp,
  buildCartAddItems,
} from "./cart-drawer-html.mjs";
import { openStoreHome } from "./store-session.mjs";

const CART_PAGE_ITEMS_CANDIDATES = [
  "body.cart main#root > .shopify-section section form[action=\"/cart\"]",
  "body.cart main#root section form[action=\"/cart\"]",
  "main#root > .shopify-section section form[action=\"/cart\"]",
  "body.cart main#root > .shopify-section section form[action$=\"/cart\"]",
  "body.cart main#root section form[action$=\"/cart\"]",
  "main#root > .shopify-section section form[action$=\"/cart\"]",
  "body.cart main#root form[action$=\"/cart\"]",
  "main#root form[action$=\"/cart\"]",
  "body.cart main#root form[action=\"/cart\"]",
  "main#root form[action=\"/cart\"] ul",
  "cart-items #main-cart-items",
  "form#cart #main-cart-items",
  "cart-items form.cart__contents #main-cart-items",
  "cart-items .cart__contents .js-contents",
  "cart-items .cart__contents",
  "#main-cart-items",
  "cart-items",
  ".cart__items",
  "main#MainContent cart-items",
  "form.cart__contents#cart",
];

const LINE_ITEM_SELECTORS =
  "tr.cart-item, .cart-item, [id^='CartItem-'], tbody tr, .js-contents tr";

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

function isCartPageItemsContainer(el) {
  if (!el || el.nodeType !== 1) return false;
  const id = el.id || "";
  if (/^mr-div-embedded/i.test(id)) return false;
  const tag = el.tagName?.toLowerCase();
  const cls = (el.className || "").toString();
  if (id === "main-cart-items") return true;
  if (tag === "cart-items") return true;
  if (cls.includes("cart__items")) return true;
  if (cls.includes("js-contents") && el.closest("form.cart__contents, form#cart")) {
    return true;
  }
  if (cls.includes("cart__contents") && tag === "form") return false;
  if (tag === "ul" && el.closest('form[action="/cart"], form[action*="/cart"]')) return true;
  if (tag === "form") {
    const action = (el.getAttribute("action") || "").trim();
    if (action.endsWith("/cart") && el.closest("body.cart main#root, body.template-cart main#root")) {
      return true;
    }
  }
  if (tag === "template") {
    const xfor = el.getAttribute("x-for") || "";
    if (/cart\.items/.test(xfor) && el.closest('form[action="/cart"], form[action*="/cart"]')) {
      return true;
    }
  }
  return false;
}

function verifyCartPageOnly(cartDoc, homeDoc, productDoc, selector) {
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
  const el = cartDoc.querySelector(selector);
  if (!isCartPageItemsContainer(el)) {
    return { ok: false, cartCount, homeCount, productCount, rejected: "not-cart-items-container" };
  }
  const onCartPage =
    cartDoc.querySelector('link[rel="canonical"][href*="/cart"]') ||
    cartDoc.body?.classList?.contains?.("template-cart") ||
    /\bcart\b/.test(cartDoc.body?.className || "") ||
    /\/cart["']|pageurl.*cart/i.test(cartDoc.documentElement?.innerHTML?.slice(0, 5000) || "");
  if (
    !onCartPage &&
    !cartDoc.querySelector(
      'cart-items, #main-cart-items, form#cart, form[action="/cart"], form[action$="/cart"]',
    )
  ) {
    return { ok: false, cartCount, homeCount, productCount, rejected: "not-cart-page" };
  }
  return { ok: homeCount === 0 && productCount === 0, cartCount, homeCount, productCount };
}

/**
 * Cart page (/cart) line-items container — cart=1, home=0, product=0.
 */
export async function discoverCartPageCvb(storeUrl, storePassword = "") {
  const myshopifyBase = normalizeStoreUrl(storeUrl);
  const password = String(storePassword || "").trim();
  const { fetchWithCookies } = createSession();
  const home = await openStoreHome(myshopifyBase, password, fetchWithCookies);

  const base = effectiveStoreBase(home.finalUrl, myshopifyBase);

  const handle = firstProductHandle(home.html);
  if (!handle) {
    const err = new Error("No product link found on storefront home.");
    err.statusCode = 404;
    throw err;
  }

  const productUrl = new URL(`/products/${handle}`, base).href;
  const productPage = await fetchWithCookies(productUrl);
  let variantId = extractVariantIdFromPdp(productPage.html);
  let productJson = null;

  const productJs = await fetchWithCookies(new URL(`/products/${handle}.js`, base).href);
  if (productJs.json) productJson = productJs.json;

  if (!variantId && productJson?.variants?.[0]?.id) {
    variantId = productJson.variants[0].id;
  }

  if (variantId) {
    await fetchWithCookies(new URL("/cart/add.js", base).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        items: buildCartAddItems(variantId, productPage.html, productJson),
      }),
    });
  }

  const cartPage = await fetchWithCookies(new URL("/cart", base).href);
  const cartDoc = parseHTML(cartPage.html).document;
  const homeDoc = parseHTML(home.html).document;
  const productDoc = parseHTML(productPage.html).document;

  const tried = [];
  for (const selector of CART_PAGE_ITEMS_CANDIDATES) {
    const v = verifyCartPageOnly(cartDoc, homeDoc, productDoc, selector);
    tried.push({ selector, ...v, method: "stable-candidate" });
    if (v.ok) {
      return {
        ok: true,
        storeUrl: base,
        cartUrl: new URL("/cart", base).href,
        productUrl,
        selector,
        description: "Cart items container on /cart page only.",
        tried,
      };
    }
  }

  const err = new Error(
    "No stable cart page items container found (cart=1, home=0, product=0).",
  );
  err.statusCode = 422;
  err.tried = tried;
  throw err;
}
