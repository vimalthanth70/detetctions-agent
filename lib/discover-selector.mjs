import { parseHTML } from "linkedom";
import { applySetCookies, isPasswordProtected, openStoreHome } from "./store-session.mjs";

const HOST_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9_]*\.myshopify\.com$/;

export const CANDIDATES = [
  '#productForm form[action="/cart/add"]',
  'form[id^="product_form_"][action="/cart/add"]',
  'form.f8pr-buy-button[action="/cart/add"]',
  'form[id^="main-product-form-"][action="/cart/add"]',
  'form.f8pr.f8pr-buy-button[action="/cart/add"]',
  '.product-information form[data-type="add-to-cart-form"]',
  'product-form-component[data-section-id$="__main"] form[data-type="add-to-cart-form"]',
  'form[id^="BuyButtons-ProductForm-"][data-type="add-to-cart-form"]',
  '.product-information product-form-component form[data-type="add-to-cart-form"]',
  'product-form form[data-type="add-to-cart-form"]',
  'form[id^="product-form-template"][data-type="add-to-cart-form"]',
  'form.main-product-form[data-type="add-to-cart-form"][id^="product-form-template"]',
  'form[action="/cart/add"].main-product-form[id^="product-form-template"]',
  'form[action="/cart/add"].main-product-form',
  'form[action="/cart/add"]:not(.installment):not(.sticky-atc-bar__form)',
  'form.form[action*="/cart/add"][data-type="add-to-cart-form"]',
  'form[action*="/cart/add"][data-type="add-to-cart-form"]',
];

export function normalizeStoreUrl(input) {
  const raw = String(input || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!HOST_PATTERN.test(raw)) {
    throw new Error("Invalid store URL. Use your Shopify hostname, e.g. your-store.myshopify.com");
  }
  return `https://${raw}/`;
}

/** Use redirect target origin so cart cookies work on custom domains (e.g. *.com). */
export function effectiveStoreBase(finalUrl, fallbackBase) {
  try {
    const origin = new URL(finalUrl).origin;
    return `${origin}/`;
  } catch {
    return fallbackBase;
  }
}

function createSession() {
  const jar = new Map();
  const fetchWithCookies = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (jar.size) {
      headers.set("Cookie", [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36",
    );
    const redirect = init.redirect ?? "follow";
    const res = await fetch(url, { ...init, headers, redirect });
    applySetCookies(jar, res);
    return {
      html: await res.text(),
      finalUrl: res.url,
      status: res.status,
      location: res.headers.get("location"),
    };
  };
  return { fetchWithCookies };
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

function verifySelector(document, selector) {
  let nodes;
  try {
    nodes = document.querySelectorAll(selector);
  } catch {
    return { ok: false, count: -1 };
  }
  const count = nodes.length;
  if (count !== 1) return { ok: false, count };
  const form = nodes[0];
  if (form.tagName !== "FORM") return { ok: false, count, reason: "not a form" };
  const action = form.getAttribute("action") || "";
  if (!action.includes("cart/add")) return { ok: false, count, reason: "action not cart/add" };
  if (
    !form.querySelector(
      'button[name="add"], input[name="add"], button[type="submit"], input[type="submit"]',
    )
  ) {
    return { ok: false, count, reason: "no add-to-cart control" };
  }
  return { ok: true, count: 1 };
}

export function formatOutputJs(selector, storeUrl, productUrl) {
  const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `export default {
  'product-form-selector': '${escaped}',
};`;
}

/**
 * @param {string} storeUrl - hostname or URL
 * @param {string} [storePassword]
 */
export async function discoverProductFormSelector(storeUrl, storePassword = "") {
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
  const { html: productHtml } = await fetchWithCookies(productUrl);
  if (isPasswordProtected(productHtml)) {
    const err = new Error("Product page still shows password gate.");
    err.statusCode = 403;
    throw err;
  }

  const { document } = parseHTML(productHtml);
  const tried = [];
  let chosen = null;

  for (const sel of CANDIDATES) {
    const v = verifySelector(document, sel);
    tried.push({ selector: sel, count: v.count, valid: v.ok });
    if (v.ok) {
      chosen = sel;
      break;
    }
  }

  if (!chosen) {
    const err = new Error("No unique product form selector found for this theme.");
    err.statusCode = 422;
    err.tried = tried;
    throw err;
  }

  const outputJs = formatOutputJs(chosen, base, productUrl);

  return {
    ok: true,
    storeUrl: base,
    productUrl,
    selector: chosen,
    outputJs,
    copySelector: chosen,
    copyOutputJs: outputJs,
    tried,
  };
}
