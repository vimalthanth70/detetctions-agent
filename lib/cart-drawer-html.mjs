import { parseHTML } from "linkedom";
import { normalizeStoreUrl, effectiveStoreBase } from "./discover-selector.mjs";
import { applySetCookies, openStoreHome } from "./store-session.mjs";

/** Cart drawer, cart-popup, mini-cart, and Alpine slide-in panels. */
export const CART_UI_ROOT_SELECTORS = [
  'section[x-show="cart_drawer"]',
  '[x-show="cart_drawer"].fixed',
  "cart-drawer",
  "#CartDrawer",
  ".cart-drawer",
  "cart-notification-drawer",
  "#cart-drawer",
  "mini-cart",
  ".mini-cart",
  "cart-popup",
  ".cart-popup",
  "[class*='cart-popup']",
];

export const DRAWER_ROOT_SELECTORS = CART_UI_ROOT_SELECTORS;

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
    const contentType = res.headers.get("content-type") || "";
    const isJsonLike =
      contentType.includes("application/json") ||
      contentType.includes("text/javascript") ||
      contentType.includes("application/javascript");
    if (isJsonLike) {
      return {
        json: await res.json(),
        html: null,
        finalUrl: res.url,
        status: res.status,
        location: res.headers.get("location"),
      };
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return {
          json: JSON.parse(trimmed),
          html: null,
          finalUrl: res.url,
          status: res.status,
          location: res.headers.get("location"),
        };
      } catch {
        /* fall through */
      }
    }
    return {
      html: text,
      json: null,
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

export function extractVariantIdFromPdp(html) {
  const hidden = html.match(/<input[^>]+name=["']id["'][^>]+value=["'](\d+)["']/i);
  if (hidden) return Number(hidden[1]);
  const hidden2 = html.match(/value=["'](\d+)["'][^>]+name=["']id["']/i);
  if (hidden2) return Number(hidden2[1]);
  const analytics = html.match(/"variantId"\s*:\s*(\d+)/);
  if (analytics) return Number(analytics[1]);
  const metaVariant = html.match(/"variants"\s*:\s*\[\s*\{\s*"id"\s*:\s*(\d+)/);
  if (metaVariant) return Number(metaVariant[1]);
  const urlVariant = html.match(/[?&]variant=(\d+)/);
  if (urlVariant) return Number(urlVariant[1]);
  return null;
}

export function extractSellingPlanIdFromPdp(html) {
  const m = html.match(/<input[^>]+name=["']selling_plan["'][^>]+value=["'](\d+)["']/i);
  if (m) return Number(m[1]);
  const m2 = html.match(/value=["'](\d+)["'][^>]+name=["']selling_plan["']/i);
  if (m2) return Number(m2[1]);
  const alpine = html.match(/current_variant_selling_plan_id\s*=\s*['"](\d+)['"]/);
  if (alpine) return Number(alpine[1]);
  const alloc = html.match(/"selling_plan_allocations"\s*:\s*\[\s*\{[^}]*"selling_plan_id"\s*:\s*(\d+)/);
  if (alloc) return Number(alloc[1]);
  return null;
}

export function extractSellingPlanIdFromProductJson(product) {
  const variant = product?.variants?.[0];
  const planId = variant?.selling_plan_allocations?.[0]?.selling_plan_id;
  return planId ? Number(planId) : null;
}

/** Cart add payload; includes selling_plan when the PDP requires a subscription plan. */
export function buildCartAddItems(variantId, pdpHtml, productJson = null) {
  const item = { id: variantId, quantity: 1 };
  const sellingPlan =
    extractSellingPlanIdFromPdp(pdpHtml) || extractSellingPlanIdFromProductJson(productJson);
  if (sellingPlan) item.selling_plan = sellingPlan;
  return [item];
}

export function extractCartDrawerSectionKey(html) {
  const m = html.match(/id=["']shopify-section-(sections--[^"']*cart-drawer)["']/i);
  if (m) return m[1];
  const m2 = html.match(/id=["']shopify-section-([^"']*cart-drawer)["']/i);
  if (m2) return m2[1];
  if (/shopify-section-cart-drawer|section_id=cart-drawer/i.test(html)) {
    return "cart-drawer";
  }
  return null;
}

export function hasCartDrawer(doc) {
  if (
    CART_UI_ROOT_SELECTORS.some((sel) => {
      try {
        return doc.querySelector(sel) !== null;
      } catch {
        return false;
      }
    })
  ) {
    return true;
  }
  const html = doc.documentElement?.innerHTML || "";
  return (
    /x-show=["']cart_drawer["']/i.test(html) &&
    /cart_drawer\s*=\s*true/i.test(html) &&
    /cart\.items/i.test(html)
  );
}

async function fetchCartSectionHtml(base, fetchWithCookies, sectionKey, variantId, pdpHtml) {
  const parts = [];

  if (sectionKey) {
    const addWithSection = await fetchWithCookies(new URL("/cart/add.js", base).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        items: buildCartAddItems(variantId, pdpHtml),
        sections: sectionKey,
        sections_url: "/",
      }),
    });
    const fromAdd = addWithSection.json?.sections?.[sectionKey];
    if (fromAdd) parts.push(fromAdd);

    const sectionsRes = await fetchWithCookies(
      new URL(`/?sections=${encodeURIComponent(sectionKey)}`, base).href,
    );
    if (sectionsRes.json?.[sectionKey]) {
      parts.push(sectionsRes.json[sectionKey]);
    }
  }

  const cartPageSection = await fetchWithCookies(
    new URL("/cart?section_id=cart-drawer", base).href,
  );
  if (cartPageSection.html && cartPageSection.html.length > 200) {
    parts.push(cartPageSection.html);
  }

  return parts.join("\n");
}

/**
 * Login if needed, add to cart, return document with cart drawer / cart-popup / mini-cart markup.
 */
export async function loadCartDrawerDocument(storeUrl, storePassword = "") {
  const myshopifyBase = normalizeStoreUrl(storeUrl);
  const password = String(storePassword || "").trim();
  const { fetchWithCookies } = createSession();
  const home = await openStoreHome(myshopifyBase, password, fetchWithCookies);

  const base = effectiveStoreBase(home.finalUrl, myshopifyBase);

  const homeDoc = parseHTML(home.html).document;
  if (!hasCartDrawer(homeDoc)) {
    return { hasDrawer: false, base, storeUrl: base };
  }

  const handle = firstProductHandle(home.html);
  if (!handle) {
    const err = new Error("No product link found on storefront home.");
    err.statusCode = 404;
    throw err;
  }

  const productUrl = new URL(`/products/${handle}`, base).href;
  const productPage = await fetchWithCookies(productUrl);
  const productJs = await fetchWithCookies(new URL(`/products/${handle}.js`, base).href);
  let variantId = extractVariantIdFromPdp(productPage.html);

  if (!variantId && productJs.json?.variants?.[0]?.id) {
    variantId = productJs.json.variants[0].id;
  }

  if (!variantId) {
    const err = new Error("Could not resolve variant id for cart add.");
    err.statusCode = 422;
    throw err;
  }

  const addRes = await fetchWithCookies(new URL("/cart/add.js", base).href, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      items: buildCartAddItems(variantId, productPage.html, productJs.json),
    }),
  });

  const addedItems = Array.isArray(addRes.json?.items) ? addRes.json.items : null;
  const addedCount = addedItems
    ? addedItems.length
    : addRes.json?.variant_id || addRes.json?.id
      ? 1
      : 0;
  if (!addRes.json || addRes.json.status || addedCount < 1) {
    const err = new Error(
      addRes.json?.description || addRes.json?.message || "Failed to add product to cart.",
    );
    err.statusCode = 422;
    throw err;
  }

  const sectionKey =
    extractCartDrawerSectionKey(home.html) ||
    extractCartDrawerSectionKey(productPage.html) ||
    "cart-drawer";

  // Themes that ship the drawer in the home HTML (e.g. Dawn) get duplicate
  // matches when we concatenate every snapshot. Use the home HTML alone when it
  // already contains the drawer; only fetch extra section HTML otherwise.
  let combinedHtml;
  if (hasCartDrawer(parseHTML(home.html).document)) {
    combinedHtml = home.html;
  } else {
    const sectionHtml = await fetchCartSectionHtml(
      base,
      fetchWithCookies,
      sectionKey,
      variantId,
      productPage.html,
    );
    combinedHtml = [home.html, sectionHtml].filter(Boolean).join("\n");
  }

  const { document: doc } = parseHTML(combinedHtml);

  return {
    hasDrawer: true,
    base,
    storeUrl: base,
    productUrl,
    variantId,
    document: doc,
    combinedHtml,
  };
}
