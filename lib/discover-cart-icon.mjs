import { parseHTML } from "linkedom";
import { normalizeStoreUrl } from "./discover-selector.mjs";
import { createSession, hasCartDrawer } from "./cart-drawer-html.mjs";
import { openStoreHome } from "./store-session.mjs";

const CART_ICON_CANDIDATES = [
  'a.cart-drawer-button[aria-controls="CartDrawer"]',
  'a[aria-controls="CartDrawer"]',
  'button.cart-drawer-button[aria-controls="CartDrawer"]',
  '.cart-drawer-button[aria-controls="CartDrawer"]',
  '[aria-controls="CartDrawer"].cart-drawer-button',
  'a[href="/cart"].cart-drawer-button',
  'header a[href="/cart"].gap-x-2',
  'header a[href="/cart"]:has(svg)',
  'header a[href="/cart"]:not(.tw-uppercase)',
  'header .mobile-nav a[href="/cart"]',
  'nav a[href="/cart"]',
  'header a[href="/cart"]',
  "#cart-icon",
  ".header__icon--cart",
  "a.js-drawer-open-cart",
  "cart-icon",
  'a[href="/cart"]:not([href*="/cart/add"])',
  'button[aria-label*="cart" i]',
  'a[aria-label*="cart" i]',
];

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

function looksLikeCartTrigger(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (!["a", "button", "cart-icon"].includes(tag)) return false;

  const href = (el.getAttribute("href") || "").trim();
  if (href.includes("/cart/add")) return false;
  if (href === "/cart" || href.endsWith("/cart")) return true;

  const controls = el.getAttribute("aria-controls") || "";
  if (/cart|CartDrawer|cart-drawer/i.test(controls)) return true;

  const cls = (el.className || "").toString();
  if (/cart-drawer-button|header__icon--cart|icon-cart/i.test(cls)) return true;

  const id = el.id || "";
  if (/cart-icon|cart-toggle/i.test(id)) return true;

  const label = (el.getAttribute("aria-label") || "").toLowerCase();
  if (label.includes("cart") || label.includes("carrello") || label.includes("bag")) {
    return true;
  }

  return false;
}

function verifyCartIcon(homeDoc, productDoc, selector) {
  if (/shopify-section-template--\d+__/.test(selector)) {
    return { ok: false, homeCount: 0, productCount: 0, rejected: "dynamic-section-id" };
  }
  let homeCount = 0;
  let productCount = 0;
  try {
    homeCount = homeDoc.querySelectorAll(selector).length;
    productCount = productDoc.querySelectorAll(selector).length;
  } catch {
    return { ok: false, homeCount: -1, productCount: -1 };
  }
  if (homeCount !== 1 || productCount !== 1) {
    return { ok: false, homeCount, productCount };
  }
  const el = homeDoc.querySelector(selector);
  if (!looksLikeCartTrigger(el)) {
    return { ok: false, homeCount, productCount, rejected: "not-cart-trigger" };
  }
  if (
    el.closest(
      'section[x-show="cart_drawer"], cart-drawer, #CartDrawer, .cart-drawer, mini-cart, .mini-cart',
    )
  ) {
    return { ok: false, homeCount, productCount, rejected: "inside-drawer" };
  }
  return { ok: true, homeCount: 1, productCount: 1 };
}

/**
 * Header cart control — opens cart drawer or navigates to /cart.
 */
export async function discoverCartIcon(storeUrl, storePassword = "") {
  const base = normalizeStoreUrl(storeUrl);
  const password = String(storePassword || "").trim();
  const { fetchWithCookies } = createSession();
  const home = await openStoreHome(base, password, fetchWithCookies);

  const handle = firstProductHandle(home.html);
  if (!handle) {
    const err = new Error("No product link found on storefront home.");
    err.statusCode = 404;
    throw err;
  }

  const productUrl = new URL(`/products/${handle}`, base).href;
  const productPage = await fetchWithCookies(productUrl);

  const { document: homeDoc } = parseHTML(home.html);
  const { document: productDoc } = parseHTML(productPage.html);

  const tried = [];
  for (const selector of CART_ICON_CANDIDATES) {
    const v = verifyCartIcon(homeDoc, productDoc, selector);
    tried.push({ selector, ...v, method: "stable-candidate" });
    if (v.ok) {
      return {
        ok: true,
        storeUrl: base,
        homeUrl: base,
        productUrl,
        selector,
        hasDrawer: hasCartDrawer(homeDoc),
        description: "Cart trigger in header (opens drawer or /cart).",
        tried,
      };
    }
  }

  return {
    ok: true,
    storeUrl: base,
    homeUrl: base,
    productUrl,
    selector: "",
    hasDrawer: hasCartDrawer(homeDoc),
    description: "No stable cart icon selector (home=1, product=1).",
    tried,
  };
}
