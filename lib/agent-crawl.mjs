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

/** Extract unique product handles from any storefront HTML (order preserved). */
function productHandlesFromHtml(html) {
  const handles = [];
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
    handles.push(handle);
  }
  return handles;
}

function firstProductHandle(html) {
  return productHandlesFromHtml(html)[0] ?? null;
}

/** All unique product handles from home HTML (order preserved). */
function productHandlesFromHome(html) {
  return productHandlesFromHtml(html);
}

function collectionPathsFromHtml(html) {
  const paths = [];
  const seen = new Set();
  for (const m of (html || "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].trim();
    let path = "";
    if (raw.startsWith("/collections/")) path = raw.split("?")[0].split("#")[0];
    else if (raw.includes("/collections/")) path = "/" + raw.split("/collections/")[1].split("?")[0].split("#")[0];
    else continue;
    if (!path.startsWith("/collections/")) path = `/collections/${path.replace(/^\/+/, "")}`;
    const slug = path.slice("/collections/".length).split("/")[0];
    if (!slug || slug === "all" || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/** Home first; then /collections/all and linked collection pages when home has no PDP links. */
async function discoverProductHandles(homeHtml, base, fetchWithCookies) {
  const fromHome = productHandlesFromHtml(homeHtml);
  if (fromHome.length) return fromHome;

  const fallbacks = ["/collections/all", ...collectionPathsFromHtml(homeHtml)];
  const seenPaths = new Set();
  for (const path of fallbacks) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    try {
      const page = await fetchWithCookies(new URL(path, base).href);
      const handles = productHandlesFromHtml(page.html);
      if (handles.length) return handles;
    } catch {
      /* try next */
    }
  }
  return [];
}

function extractVariantId(pdpHtml, productJson) {
  const available = productJson?.variants?.find((v) => v.available);
  if (available?.id) return available.id;
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
  /(^|\s)(cart-drawer|cart-popup|mini-cart|cart-notification-drawer|drawer--cart|quick-cart|fc-drawer)(\s|$|__)/i;
const DRAWER_SECTION_TYPE_RE = /^(quick-cart|ajax-cart|side-cart|cart-drawer|mini-cart|custom-cart-drawer)$/i;
const DRAWER_HTML_RE =
  /data-cart-drawer(?:\s|>|=)|(?:id=["']FcDrawer["']|class=["'][^"']*fc-drawer)|data-section-id=["']custom-cart-drawer["']|x-show=["'][^"']*(?:cart[_-]?drawer|rightDrawer[^"']*cart|modals\.rightDrawer[^"']*cart)|class=["'][^"']*bls-minicart-wrapper/i;

/** Shared drawer / mini-cart / quick-cart root query (used by crawl + LLM verify). */
export const DRAWER_ROOTS_QUERY =
  'cart-drawer, cart-drawer-component, #CartDrawer, #FcDrawer, .cart-drawer, .fc-drawer, mini-cart, #mini-cart, cart-popup, cart-notification-drawer, form.mini-cart, form.cart.mini-cart, [x-show="cart_drawer"], .quick-cart, [data-section-type="quick-cart"], [data-section-type="ajax-cart"], [data-section-id="custom-cart-drawer"], [data-cart-drawer], [data-teleport-target][data-cart-drawer], dialog.cart-drawer__dialog, [data-testid="cart-drawer-dialog"], xo-cart-mini, .xo-cart-mini-drawer__modal, xo-modal[xo-for-cart-mini], .bls-minicart-wrapper, .bls-minicart-content, #form-mini-cart, .cart-container, .cart_content, .tos_warning.cart_content, .header-ajax-form-wrap, #shopify-section-cart-panel, #cart[data-component="Cart"], [data-component="Cart"][id="cart"], .ajaxcart-draw, .js-cart-draw, form.ajaxcart__form, #slidecarthq, .slidecarthq, .slidecarthq-overlay, hdt-cart-drawer, .hdt-mini-cart';

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
    if (/^(cart-?drawer|cart-?popup|mini-?cart|quick-?cart|FcDrawer|cart)$/i.test(id) || /CartDrawer/.test(id))
      return true;
    if (el.getAttribute?.("data-component") === "Cart" && el.querySelector?.('[data-ref="modal"], aside[data-ref="container"]'))
      return true;
    const cls = (el.className || "").toString();
    if (/\bajaxcart-draw\b|\bjs-cart-draw\b/.test(cls)) return true;
    if (/\bslidecarthq\b/.test(cls) || id === "slidecarthq") return true;
    if (/^CartDrawer$/i.test(id) || /^hdt-cart-drawer$/i.test((el.tagName || "").toLowerCase())) return true;
    if (DRAWER_ATTR_RE.test(cls)) return true;
    const sectionId = el.getAttribute?.("data-section-id") || "";
    if (/^custom-cart-drawer$/i.test(sectionId)) return true;
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
  // Venue theme: line items render from #CartTemplate into .ajaxcart-draw via JS.
  const venueTpl = html.match(/<script[^>]+id=["']CartTemplate["'][^>]*>([\s\S]*?)<\/script>/i);
  if (venueTpl?.[1] && venueTpl[1].length > 200) {
    const chunk = `<div class="ajaxcart-draw js-cart-draw">${venueTpl[1]}</div>`;
    const doc = parseHTML(chunk).document;
    if (doc.querySelector?.(".ajaxcart__products")) {
      out.push({ source: `${source}:CartTemplate`, doc, html: chunk });
    }
  }
  return out;
}

/** Impulse / Archetype ajax drawer — shell is JS-injected; line items from /cart?view=ajax. */
export function buildImpulseDrawerDoc(ajaxHtml) {
  if (!ajaxHtml || ajaxHtml.length < 80) return null;
  const html = `<div id="CartDrawer" class="drawer drawer--right"><form id="CartDrawerForm" action="/cart" method="post" data-location="cart-drawer"><div class="drawer__contents"><div class="drawer__scrollable"><div data-products="" class="cart__page-col">${ajaxHtml.trim()}</div></div><div class="drawer__footer"><div class="cart__item-sub cart__item-row"><div>Subtotal</div><div data-subtotal=""></div></div><div data-discounts="" class="cart__discounts cart__item-sub cart__item-row hide"><div>Discounts</div><div></div></div></div></div></form></div>`;
  return { doc: parseHTML(html).document, html };
}

function isImpulseAjaxDrawerTheme(homeHtml = "", pdpHtml = "") {
  return /js-drawer-open-cart|theme\.CartDrawer|CartDrawerForm|aria-controls=["']CartDrawer["']/i.test(
    `${homeHtml}${pdpHtml}`,
  );
}

/** SlideCartHQ app drawer — JS-rendered; synthesize populated markup from /cart.js. */
export function buildSlideCartHqDrawerDoc(cartJson) {
  const items = cartJson?.items || [];
  if (!items.length) return null;
  const itemsHtml = items
    .map(
      (item) =>
        `<div class="item" data-line-item-id="${item.id}" data-variant-id="${item.variant_id}" data-line-item-key="${item.key}"><div class="item-row"><span>${item.title}</span></div></div>`,
    )
    .join("");
  const total = ((cartJson.total_price || 0) / 100).toFixed(2);
  const html = `<div class="slidecarthq right light open cartOne checkpoint amp-sc"><div class="items">${itemsHtml}</div><footer class="footer"><div class="footer-row amp-sc__footer-row--subtotal"><span>Subtotal</span><div class="footer-subtotal-wrapper"><div class="footer-subtotal-prices"><span class="slidecart-subtotal">$${total}</span></div></div></div></footer></div>`;
  return { doc: parseHTML(html).document, html };
}

export function hasCartDrawerMarkup(doc, html = "") {
  if (html && /slidecarthq\.js|window\.SLIDECART|#slidecarthq/i.test(html)) return true;
  if (html && isImpulseAjaxDrawerTheme(html)) return true;
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
    /id=["']shopify-section-(sections--[^"']*(?:quick-cart|cart-drawer|mini-cart|side-cart|ajax-cart|cart-items|cart-footer|header_section|header|__cart))["']/gi,
    /id=["']shopify-section-((?:quick-cart|cart-drawer|mini-cart|side-cart|ajax-cart|cart-items|cart-footer|cart|header))["']/gi,
    /data-section-id=["'](sections--[^"']*(?:quick-cart|cart-drawer|mini-cart|side-cart|ajax-cart|cart-items|cart-footer|header_section|header|custom-cart-drawer|fc-drawer|__cart))["']/gi,
    /data-section-id=["']((?:quick-cart|cart-drawer|mini-cart|side-cart|ajax-cart|cart-items|cart-footer|cart|header|custom-cart-drawer|fc-drawer))["']/gi,
  ]) {
    for (const m of html.matchAll(re)) keys.add(m[1]);
  }
  if (/data-cart-drawer|data-cart-items|data-cart-footer|custom-cart-drawer|fc-drawer|FcDrawer|rightDrawer|xo-cart-mini|xo-for-cart-mini/i.test(html || "")) {
    for (const fallback of ["cart", "cart-items", "cart-footer", "custom-cart-drawer"]) keys.add(fallback);
  }
  for (const m of (html || "").matchAll(/shopify-section-(sections--\d+__cart)\b/gi)) {
    keys.add(m[1]);
  }
  if (/shopify-section-cart-panel|data-component=["']Cart["']/i.test(html || "")) {
    keys.add("cart-panel");
  }
  if (/hdt-cart-drawer|hdt-mini-cart|hdt-section-cart-drawer/i.test(html || "")) {
    keys.add("cart-drawer");
  }
  for (const fallback of [
    "header",
    "custom-cart-drawer",
    "quick-cart",
    "ajax-cart",
    "cart-drawer",
    "mini-cart",
    "side-cart",
    "cart-panel",
    "sections--cart-drawer",
    "sections--mini-cart",
  ]) {
    keys.add(fallback);
  }
  return [...keys];
}

const LINE_ITEM_HINTS =
  'cart-items-component, cart-items, #FcItems, .fc-item, .fc-body, cart-drawer-items, [data-cart-items], [data-products], [class*="line-item"], [class*="cart-item"], .cart__item, .cart__items, [class*="quick-cart__item"], [id*="CartDrawer-CartItems"], [id*="CartItem-"], li[data-key], li[data-line-item-key], input[name="updates[]"], .cart__contents, .cart-items__table-row, .xo-cart-mini-item, xo-product.xo-cart-mini-item, .bls-items, .bls-minicart-body .bls-items, ul.cart_items, .cart_items.js-cart_items, .ajax-cart__items, .ajaxcart__products, .ajaxcart__product, .slidecarthq .items, .slidecarthq .item, .hdt-mini-cart__items';

/** True when the storefront UX opens a cart overlay — not just dormant Horizon header markup. */
function themeUsesCartDrawer(homeDoc, pdpDoc, homeHtml = "", pdpHtml = "") {
  if (/slidecarthq\.js|window\.SLIDECART|#slidecarthq/i.test(`${homeHtml}${pdpHtml}`)) return true;
  const activeDrawerQuery =
    'cart-drawer, cart-icon, [data-testid="cart-drawer-trigger"], mini-cart, #mini-cart, #FcDrawer, .fc-drawer, .quick-cart, cart-popup, [data-section-type="quick-cart"], [data-section-id="custom-cart-drawer"], xo-cart-mini, .xo-header__right-item-cart, xo-modal-trigger.xo-header__right-item-cart, [xo-for-cart-mini], .bls-minicart-wrapper, .bls-minicart-content, a.bls-minicart-action, .cart-container, a.mini_cart, .icon-cart.mini_cart, button[data-option-target="Cart"], #cart[data-component="Cart"], .ajaxcart-draw, .js-cart-draw, a.js-cart-full, .js-cart-draw-icon, #slidecarthq, .slidecarthq, [class*="slidecarthq"], a.cart-drawer-button, .cart-drawer-button, hdt-cart-drawer, #CartDrawer, a[aria-controls="CartDrawer"]';
  for (const doc of [homeDoc, pdpDoc]) {
    if (doc?.querySelector?.(activeDrawerQuery)) return true;
  }
  return false;
}

function scoreDrawerDoc({ doc, html = "" }) {
  const root = findDrawerRoot(doc);
  if (!root) return -1;
  const lineItems = root.querySelectorAll(LINE_ITEM_HINTS).length;
  // Prefer dialog / populated drawer over header trigger shell.
  const dialog =
    doc.querySelector?.('dialog.cart-drawer__dialog cart-items-component, [data-testid="cart-drawer-dialog"] cart-items-component') ||
    root.querySelector?.("cart-items-component[data-drawer], dialog cart-items-component");
  const dialogBonus = dialog ? 500_000 : 0;
  if (lineItems === 0) {
    let score = Math.min(root.outerHTML.length, 2000) + dialogBonus;
    if ((html?.length || 0) > 50_000) score -= 10_000;
    return score;
  }
  return lineItems * 100_000 + root.outerHTML.length + dialogBonus;
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
  const handles = await discoverProductHandles(home.html, base, fetchWithCookies);
  if (!handles.length) {
    step("product", "failed", "No product link on home or collection pages");
    const err = new Error("No product link found on storefront home or collection pages.");
    err.statusCode = 404;
    throw err;
  }

  let handle = handles[0];
  let productUrl = new URL(`/products/${handle}`, base).href;
  let productPage = await fetchWithCookies(productUrl);
  if (isPasswordProtected(productPage.html || "")) {
    const err = new Error("Product page still shows password gate.");
    err.statusCode = 403;
    throw err;
  }
  let productJs = await fetchWithCookies(new URL(`/products/${handle}.js`, base).href);
  log(`PDP loaded (/products/${handle}) — ${productPage.html?.length ?? 0} bytes`);
  step("product", "done", `PDP loaded (/products/${handle})`);

  step("cart-add", "running", "Adding product to cart (probe)...");
  let addOk = false;
  for (let i = 0; i < handles.length && !addOk; i++) {
    if (i > 0) {
      handle = handles[i];
      productUrl = new URL(`/products/${handle}`, base).href;
      productPage = await fetchWithCookies(productUrl);
      productJs = await fetchWithCookies(new URL(`/products/${handle}.js`, base).href);
      log(`Trying next product (/products/${handle})`);
    }
    const variantId = extractVariantId(productPage.html, productJs.json);
    if (!variantId) continue;
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

  // Blouse / Bls themes inject mini-cart line items into home after add-to-cart.
  let homeAfterAdd = null;
  if (addOk) {
    try {
      homeAfterAdd = await fetchWithCookies(new URL("/", base).href);
    } catch {
      homeAfterAdd = null;
    }
  }

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
  if (homeAfterAdd?.html) {
    const refreshedDoc = parseHTML(homeAfterAdd.html).document;
    if (hasCartDrawerMarkup(refreshedDoc, homeAfterAdd.html)) {
      candidateDocs.push({ source: "home-after-add", doc: refreshedDoc, html: homeAfterAdd.html });
    }
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
  if (
    addOk &&
    /slidecarthq\.js|window\.SLIDECART/i.test(`${home.html || ""}${productPage.html || ""}`)
  ) {
    try {
      const cartJs = await fetchWithCookies(new URL("/cart.js", base).href);
      const built = buildSlideCartHqDrawerDoc(cartJs.json);
      if (built) {
        candidateDocs.push({ source: "slidecarthq:cart.js", doc: built.doc, html: built.html });
      }
    } catch {
      /* ignore */
    }
  }
  if (addOk && isImpulseAjaxDrawerTheme(home.html || "", productPage.html || "")) {
    try {
      const ajaxRes = await fetchWithCookies(new URL("/cart?view=ajax", base).href);
      const built = buildImpulseDrawerDoc(ajaxRes.html || "");
      if (built) {
        candidateDocs.push({ source: "impulse:cart-view-ajax", doc: built.doc, html: built.html });
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

  const pdpDoc = parseHTML(productPage.html || "").document;
  const usesDrawer = themeUsesCartDrawer(homeDoc, pdpDoc, home.html || "", productPage.html || "");

  step(
    "drawer",
    drawerStatus ? "done" : "skipped",
    drawerStatus && !usesDrawer
      ? "Header has cart-drawer markup but cart icon navigates to /cart — no overlay"
      : drawerStatus
        ? `Drawer markup resolved (${drawerStatus})`
        : "No cart drawer / mini-cart on theme",
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
    pdpDoc,
    cartDoc: parseHTML(cartPage.html || "").document,
    drawerDoc,
    hasDrawer: !!drawerStatus && usesDrawer,
  };
}
