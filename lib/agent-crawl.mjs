/**
 * Shared crawl: fetch home, PDP, add-to-cart, /cart, drawer markup.
 *
 * Used by the LLM agent (lib/agent-llm.mjs).
 */

import { parseHTML } from "linkedom";
import { applySetCookies, openStoreHome, isPasswordProtected } from "./store-session.mjs";
import { normalizeStoreUrl, effectiveStoreBase } from "./store-url.mjs";

export function createSession() {
  const jar = new Map();
  const cookieHeader = () =>
    jar.size ? [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : "";

  const fetchWithCookies = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    const cookies = cookieHeader();
    if (cookies) headers.set("Cookie", cookies);
    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36",
    );
    const redirect = init.redirect ?? "follow";
    const res = await fetch(url, { ...init, headers, redirect });
    applySetCookies(jar, res);

    const ctype = res.headers.get("content-type") || "";
    const wantsJson =
      ctype.includes("application/json") ||
      ctype.includes("text/javascript") ||
      ctype.includes("application/javascript");
    if (wantsJson) {
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { json, html: null, finalUrl: res.url, status: res.status };
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { json: JSON.parse(trimmed), html: null, finalUrl: res.url, status: res.status };
      } catch {
        /* fall through */
      }
    }
    return { html: text, json: null, finalUrl: res.url, status: res.status };
  };
  return { fetchWithCookies };
}

function firstProductHandle(html) {
  const seen = new Set();
  for (const m of (html || "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
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

function extractVariantId(pdpHtml, productJson) {
  if (productJson?.variants?.[0]?.id) return productJson.variants[0].id;
  if (!pdpHtml) return null;
  const m1 = pdpHtml.match(/<input[^>]+name=["']id["'][^>]+value=["'](\d+)["']/i);
  if (m1) return Number(m1[1]);
  const m2 = pdpHtml.match(/value=["'](\d+)["'][^>]+name=["']id["']/i);
  if (m2) return Number(m2[1]);
  const m3 = pdpHtml.match(/"variantId"\s*:\s*(\d+)/);
  if (m3) return Number(m3[1]);
  return null;
}

function extractSellingPlanId(pdpHtml, productJson) {
  if (productJson?.variants?.[0]?.selling_plan_allocations?.[0]?.selling_plan_id) {
    return Number(productJson.variants[0].selling_plan_allocations[0].selling_plan_id);
  }
  if (!pdpHtml) return null;
  const m = pdpHtml.match(/<input[^>]+name=["']selling_plan["'][^>]+value=["'](\d+)["']/i);
  if (m) return Number(m[1]);
  return null;
}

const DRAWER_TAG_RE =
  /^(cart-drawer|cart-popup|mini-cart|cart-notification-drawer|quick-cart)$/;
const DRAWER_ATTR_RE =
  /(^|\s)(cart-drawer|cart-popup|mini-cart|cart-notification-drawer|drawer--cart|quick-cart)(\s|$|__)/i;
const DRAWER_SECTION_TYPE_RE = /^(quick-cart|ajax-cart|side-cart|cart-drawer|mini-cart)$/i;
const DRAWER_HTML_RE =
  /data-cart-drawer(?:\s|>|=)|x-show=["'][^"']*(?:cart[_-]?drawer|rightDrawer[^"']*cart|modals\.rightDrawer[^"']*cart)/i;

/** Shared drawer / mini-cart / quick-cart root query (used by crawl + LLM verify). */
export const DRAWER_ROOTS_QUERY =
  'cart-drawer, #CartDrawer, .cart-drawer, mini-cart, #mini-cart, cart-popup, cart-notification-drawer, form.mini-cart, form.cart.mini-cart, [x-show="cart_drawer"], .quick-cart, [data-section-type="quick-cart"], [data-section-type="ajax-cart"], [data-cart-drawer], [data-teleport-target][data-cart-drawer]';

function findDrawerRoot(doc) {
  if (!doc) return null;
  return (
    doc.querySelector?.(DRAWER_ROOTS_QUERY) ||
    doc.querySelector?.("form.mini-cart, form.cart.mini-cart, #mini-cart")
  );
}

function scanDocForDrawerRoots(doc) {
  if (!doc) return false;
  if (doc.querySelector?.(DRAWER_ROOTS_QUERY)) return true;
  const all = doc.querySelectorAll("*");
  for (const el of all) {
    if (DRAWER_TAG_RE.test((el.tagName || "").toLowerCase())) return true;
    if (el.hasAttribute?.("data-cart-drawer")) return true;
    const id = el.id || "";
    if (/^(cart-?drawer|cart-?popup|mini-?cart|quick-?cart)$/i.test(id) || /CartDrawer/.test(id))
      return true;
    const cls = (el.className || "").toString();
    if (DRAWER_ATTR_RE.test(cls)) return true;
    const sectionType = el.getAttribute?.("data-section-type") || "";
    if (DRAWER_SECTION_TYPE_RE.test(sectionType)) return true;
    const xShow = el.getAttribute?.("x-show");
    if (xShow && /(?:cart[_-]?drawer|rightDrawer[^"']*cart|modals\.rightDrawer)/i.test(xShow))
      return true;
  }
  return false;
}

/** Drawer markup inside Alpine teleport templates is not in the live DOM tree — extract it. */
export function extractDrawerCandidatesFromHtml(html, source = "html") {
  if (!html) return [];
  const out = [];
  const parsed = parseHTML(html).document;
  for (const tpl of parsed.querySelectorAll("template[data-should-teleport]")) {
    const inner = tpl.innerHTML || "";
    if (inner.length < 80) continue;
    const doc = parseHTML(inner).document;
    if (scanDocForDrawerRoots(doc)) {
      out.push({ source: `${source}:teleport`, doc, html: inner });
    }
  }
  if (DRAWER_HTML_RE.test(html)) {
    for (const m of html.matchAll(
      /<div[^>]*\bdata-cart-drawer\b[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<\/template|<\/data-island|$)/gi,
    )) {
      const chunk = m[0];
      if (chunk.length < 80) continue;
      const doc = parseHTML(chunk).document;
      if (scanDocForDrawerRoots(doc)) {
        out.push({ source: `${source}:data-cart-drawer`, doc, html: chunk });
      }
    }
  }
  return out;
}

export function hasCartDrawerMarkup(doc, html = "") {
  if (scanDocForDrawerRoots(doc)) return true;
  if (html && DRAWER_HTML_RE.test(html)) return true;
  for (const cand of extractDrawerCandidatesFromHtml(html)) {
    if (scanDocForDrawerRoots(cand.doc)) return true;
  }
  return false;
}

/** Section Rendering API keys for cart UI overlays found in theme HTML. */
export function extractCartUiSectionKeys(html) {
  const keys = new Set();
  if (!html) return [];
  for (const re of [
    /id=["']shopify-section-(sections--[^"']*(?:quick-cart|cart-drawer|mini-cart|side-cart|ajax-cart|cart-items|cart-footer))["']/gi,
    /id=["']shopify-section-((?:quick-cart|cart-drawer|mini-cart|side-cart|ajax-cart|cart-items|cart-footer|cart))["']/gi,
    /data-section-id=["'](sections--[^"']*(?:quick-cart|cart-drawer|mini-cart|side-cart|ajax-cart|cart-items|cart-footer))["']/gi,
    /data-section-id=["']((?:quick-cart|cart-drawer|mini-cart|side-cart|ajax-cart|cart-items|cart-footer|cart))["']/gi,
  ]) {
    for (const m of html.matchAll(re)) keys.add(m[1]);
  }
  if (/data-cart-drawer|data-cart-items|data-cart-footer|rightDrawer/i.test(html || "")) {
    for (const fallback of ["cart", "cart-items", "cart-footer"]) keys.add(fallback);
  }
  for (const fallback of [
    "quick-cart",
    "ajax-cart",
    "cart-drawer",
    "mini-cart",
    "side-cart",
    "sections--cart-drawer",
    "sections--mini-cart",
  ]) {
    keys.add(fallback);
  }
  return [...keys];
}

const LINE_ITEM_HINTS =
  'cart-items, cart-drawer-items, [data-cart-items], [class*="line-item"], [class*="cart-item"], [class*="quick-cart__item"], [id*="CartDrawer-CartItems"], [id*="CartItem-"], li[data-key], li[data-line-item-key], input[name="updates[]"], .cart__contents';

function scoreDrawerDoc({ doc }) {
  const root = findDrawerRoot(doc);
  if (!root) return -1;
  const lineItems = root.querySelectorAll(LINE_ITEM_HINTS).length;
  // Heavily prefer populated drawer docs (section API) over empty home-page shells.
  if (lineItems === 0) return Math.min(root.outerHTML.length, 2000);
  return lineItems * 100_000 + root.outerHTML.length;
}

/**
 * One-shot crawl. Emits step events to `emit` if provided.
 * Returns { base, productUrl, homeHtml, pdpHtml, cartHtml, drawerHtml, homeDoc, pdpDoc, cartDoc, drawerDoc }.
 */
export async function crawlStorefront(storeUrl, password = "", emit = null) {
  const step = (id, status, message) =>
    emit?.({ type: "step", id, status, message, ts: Date.now() });
  const log = (message, level = "info") => emit?.({ type: "log", level, message, ts: Date.now() });

  const myshopifyBase = normalizeStoreUrl(storeUrl);
  const { fetchWithCookies } = createSession();

  step(
    "login",
    "running",
    password ? "Logging in to password-gated store..." : "Opening storefront home...",
  );
  const home = await openStoreHome(myshopifyBase, String(password || "").trim(), fetchWithCookies);
  const base = effectiveStoreBase(home.finalUrl, myshopifyBase);
  log(`Home loaded (${base}) — ${home.html?.length ?? 0} bytes`);
  step("login", "done", `Home loaded (${base})`);

  step("product", "running", "Locating first product...");
  const handle = firstProductHandle(home.html);
  if (!handle) {
    step("product", "failed", "No product link on home");
    const err = new Error("No product link found on storefront home.");
    err.statusCode = 404;
    throw err;
  }
  const productUrl = new URL(`/products/${handle}`, base).href;
  const productPage = await fetchWithCookies(productUrl);
  if (isPasswordProtected(productPage.html || "")) {
    const err = new Error("Product page still shows password gate.");
    err.statusCode = 403;
    throw err;
  }
  const productJs = await fetchWithCookies(new URL(`/products/${handle}.js`, base).href);
  log(`PDP loaded (/products/${handle}) — ${productPage.html?.length ?? 0} bytes`);
  step("product", "done", `PDP loaded (/products/${handle})`);

  step("cart-add", "running", "Adding product to cart (probe)...");
  const variantId = extractVariantId(productPage.html, productJs.json);
  let addOk = false;
  if (variantId) {
    try {
      const item = { id: variantId, quantity: 1 };
      const plan = extractSellingPlanId(productPage.html, productJs.json);
      if (plan) item.selling_plan = plan;
      const addRes = await fetchWithCookies(new URL("/cart/add.js", base).href, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ items: [item] }),
      });
      addOk = !!addRes.json && !addRes.json.status;
    } catch {
      addOk = false;
    }
  }
  step(
    "cart-add",
    addOk ? "done" : "skipped",
    addOk ? "Item added; cart/drawer rendered with content" : "Skipped (no variant or add failed)",
  );

  step("cart-page", "running", "Fetching /cart page...");
  const cartPage = await fetchWithCookies(new URL("/cart", base).href);
  log(`/cart loaded — ${cartPage.html?.length ?? 0} bytes`);
  step("cart-page", "done", "/cart loaded");

  step("drawer", "running", "Resolving cart drawer / mini-cart markup...");
  const homeDoc = parseHTML(home.html || "").document;

  // Some themes (e.g. tegen) render the drawer in home as a small empty shell
  // and inject the line-items via the Section Rendering API after add-to-cart.
  // So we ALWAYS probe the common drawer section keys after add-to-cart and
  // keep whichever doc has the most line-item-like content.
  const candidateDocs = [];
  if (hasCartDrawerMarkup(homeDoc, home.html)) {
    candidateDocs.push({ source: "home", doc: homeDoc, html: home.html || "" });
  }
  for (const cand of extractDrawerCandidatesFromHtml(home.html || "", "home")) {
    candidateDocs.push(cand);
  }
  for (const cand of extractDrawerCandidatesFromHtml(productPage.html || "", "pdp")) {
    candidateDocs.push(cand);
  }
  const sectionKeys = [
    ...extractCartUiSectionKeys(home.html),
    ...extractCartUiSectionKeys(productPage.html),
  ];
  const seenSectionKeys = new Set();
  for (const sectionKey of sectionKeys) {
    if (seenSectionKeys.has(sectionKey)) continue;
    seenSectionKeys.add(sectionKey);
    try {
      const sectionRes = await fetchWithCookies(
        new URL(`/?sections=${encodeURIComponent(sectionKey)}`, base).href,
      );
      const sectionHtml = sectionRes.json?.[sectionKey];
      if (sectionHtml && sectionHtml.length > 200) {
        const doc = parseHTML(sectionHtml).document;
        if (hasCartDrawerMarkup(doc, sectionHtml)) {
          candidateDocs.push({ source: `section:${sectionKey}`, doc, html: sectionHtml });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Pick whichever drawer doc looks most "populated" by counting line-item-like
  // descendants under the drawer root. Falls back to html size for empty shells.
  let drawerHtml = "";
  let drawerDoc = homeDoc;
  let drawerStatus = null;
  if (candidateDocs.length) {
    candidateDocs.sort((a, b) => scoreDrawerDoc(b) - scoreDrawerDoc(a));
    const best = candidateDocs[0];
    drawerHtml = best.html;
    drawerDoc = best.doc;
    drawerStatus = `done-${best.source} (score=${scoreDrawerDoc(best)}, tried=${candidateDocs.map((c) => c.source).join("|")})`;
  }
  step(
    "drawer",
    drawerStatus ? "done" : "skipped",
    drawerStatus ? `Drawer markup resolved (${drawerStatus})` : "No cart drawer / mini-cart on theme",
  );

  return {
    base,
    handle,
    productUrl,
    homeHtml: home.html || "",
    pdpHtml: productPage.html || "",
    cartHtml: cartPage.html || "",
    drawerHtml,
    homeDoc,
    pdpDoc: parseHTML(productPage.html || "").document,
    cartDoc: parseHTML(cartPage.html || "").document,
    drawerDoc,
    hasDrawer: !!drawerStatus,
  };
}
