import { parseHTML } from "linkedom";
import { CANDIDATES, normalizeStoreUrl } from "./discover-selector.mjs";
import { applySetCookies, openStoreHome } from "./store-session.mjs";

/** Stable product container selectors — no dynamic shopify-section ids. */
const STABLE_CANDIDATES = [
  "#productForm",
  "main#root #productForm",
  "main#MainContent > section.shopify-section:first-of-type",
  "main#MainContent > section.shopify-section.section:first-of-type",
  'product-info[data-update-url="true"]',
  'main#MainContent product-info[data-update-url="true"]',
  "main#MainContent product-info",
  "main#MainContent .product__info-container",
  ".product-information",
  "article#main-product",
  "#main-product",
  "article.m6pr[data-product-url]",
  "main#content article#main-product",
  "main#content .product-information",
];

const STABLE_IDS = new Set(["main-product", "MainContent", "content", "productForm"]);

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

function isStableSelector(selector) {
  if (/shopify-section-template--\d+__/.test(selector)) return false;
  if (/#shopify-section-/.test(selector)) return false;
  return true;
}

function looksLikeProductContainer(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "product-info") return true;
  if (tag === "article" && el.classList.contains("m6pr")) return true;
  if (el.classList.contains("product-information")) return true;
  if (el.id === "main-product" || el.id === "productForm") return true;
  if (el.hasAttribute("data-product-id")) return true;
  return !!el.querySelector(
    'form[action*="/cart/add"], form[data-type="add-to-cart-form"], product-form, .product__title, .product-form',
  );
}

function verifyProductOnly(homeDoc, productDoc, selector) {
  if (!isStableSelector(selector)) {
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
  if (productCount !== 1) {
    return { ok: false, homeCount, productCount };
  }
  const el = productDoc.querySelector(selector);
  if (!looksLikeProductContainer(el)) {
    return { ok: false, homeCount, productCount, rejected: "not-product-container" };
  }
  return { ok: homeCount === 0 && productCount === 1, homeCount, productCount };
}

function selectorsForElement(el) {
  const built = [];
  const tag = el.tagName.toLowerCase();

  if (tag === "product-info" && el.getAttribute("data-update-url") === "true") {
    built.push('product-info[data-update-url="true"]');
    built.push('main#MainContent product-info[data-update-url="true"]');
  }
  if (el.classList.contains("product-information")) {
    built.push(".product-information");
    built.push("main#MainContent .product-information");
    built.push("main#content .product-information");
  }
  if (el.id && STABLE_IDS.has(el.id)) {
    built.push(`#${el.id}`);
    if (tag === "article") built.push(`article#${el.id}`);
  }
  if (tag === "article" && el.classList.contains("m6pr") && el.hasAttribute("data-product-url")) {
    built.push("article.m6pr[data-product-url]");
    built.push("article#main-product");
    built.push("#main-product");
  }

  return [...new Set(built)];
}

function discoverFromFormAncestor(homeDoc, productDoc) {
  const tried = [];
  let form = null;
  for (const sel of CANDIDATES) {
    try {
      const nodes = productDoc.querySelectorAll(sel);
      if (nodes.length === 1) {
        form = nodes[0];
        break;
      }
    } catch {
      /* invalid selector */
    }
  }
  if (!form) return { tried };

  let node = form.parentElement;
  const seen = new Set();
  while (node && node !== productDoc.body) {
    for (const sel of selectorsForElement(node)) {
      if (seen.has(sel)) continue;
      seen.add(sel);
      const v = verifyProductOnly(homeDoc, productDoc, sel);
      tried.push({ selector: sel, ...v, method: "form-ancestor" });
      if (v.ok) return { selector: sel, tried };
    }
    node = node.parentElement;
  }
  return { tried };
}

function discoverFromCandidates(homeDoc, productDoc) {
  const tried = [];
  for (const selector of STABLE_CANDIDATES) {
    const v = verifyProductOnly(homeDoc, productDoc, selector);
    tried.push({ selector, ...v, method: "stable-candidate" });
    if (v.ok) return { selector, tried };
  }
  return { tried };
}

/**
 * Product page container — stable CSS only; product page = 1, home = 0.
 */
export async function discoverProductPageCvb(storeUrl, storePassword = "") {
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
  const product = await fetchWithCookies(productUrl);

  const { document: homeDoc } = parseHTML(home.html);
  const { document: productDoc } = parseHTML(product.html);

  const cand = discoverFromCandidates(homeDoc, productDoc);
  if (cand.selector) {
    return {
      ok: true,
      storeUrl: base,
      homeUrl: base,
      productUrl,
      selector: cand.selector,
      description: "Main product container on PDP (not on home).",
      tried: cand.tried,
    };
  }

  const ancestor = discoverFromFormAncestor(homeDoc, productDoc);
  if (ancestor.selector) {
    return {
      ok: true,
      storeUrl: base,
      homeUrl: base,
      productUrl,
      selector: ancestor.selector,
      description: "Product container wrapping the add-to-cart form.",
      tried: [...cand.tried, ...ancestor.tried],
    };
  }

  const err = new Error(
    "No stable product container selector found (product=1, home=0; avoid dynamic section ids).",
  );
  err.statusCode = 422;
  err.tried = [...cand.tried, ...ancestor.tried];
  throw err;
}
