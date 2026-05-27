import { parseHTML } from "linkedom";
import { normalizeStoreUrl } from "./discover-selector.mjs";
import { applySetCookies, openStoreHome } from "./store-session.mjs";

const SKIP_SECTION_ID = /header|footer|announcement-bar|popup|overlay/i;

const FULL_WIDTH_CLASS_RE =
  /(?:^|\s)(?:full[-_]?width|fullwidth|w-full|tw-w-full|banner--full-width|page-width-none)(?:\s|$)/i;

const FULL_WIDTH_INNER_SELECTORS = [
  "full-width-slider",
  "[class*='full-width']",
  "[class*='full_width']",
  ".banner",
  ".slideshow",
  ".shopify-section--slideshow",
  ".hero",
  ".slide-image-wrapper",
  ".m6fr.slider-fraction",
  ".slider-fraction",
  ".media",
];

/** Stable selectors only — no #shopify-section-template--…__section_* ids. Full-width blocks first. */
const STABLE_CANDIDATES = [
  "body.index main#root > .shopify-section:first-of-type section[class*=\"group/banner\"]",
  "main#root > .shopify-section:first-of-type section[class*=\"group/banner\"]",
  "main#MainContent > .shopify-section:first-of-type full-width-slider",
  "main#MainContent full-width-slider",
  "main#MainContent > .shopify-section:first-of-type [class*='full-width']",
  "main#MainContent > .shopify-section:first-of-type .banner",
  "main#MainContent > .shopify-section:first-of-type .slideshow",
  "main#MainContent > .shopify-section:first-of-type .banner__media",
  "main#MainContent > .shopify-section:first-of-type .media",
  "main#MainContent .shopify-section--slideshow",
  "main#MainContent > div.shopify-section:first-of-type full-width-slider",
  "main#content .m6fr.slider-fraction",
  "main#content > .shopify-section:first-child .m6fr",
  "main#content .slider-fraction",
  "main#content > .shopify-section:first-child .slider-fraction",
  "main#content > .shopify-section:first-child [class*=\"slider\"]",
  "main#content > .shopify-section:first-child [class*=\"slideshow\"]",
  "main#content > .shopify-section:first-child [class*=\"hero\"]",
  "main#content .shopify-section--slideshow",
  "main .banner--desktop-transparent",
  "main#content > .shopify-section:first-child",
];

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

function firstMainSection(homeDoc) {
  const roots = ["main#root", "main#MainContent", "main#content", "main"];
  for (const rootSel of roots) {
    const main = homeDoc.querySelector(rootSel);
    if (!main) continue;
    for (const el of main.querySelectorAll(
      ":scope > .shopify-section, :scope > div.shopify-section",
    )) {
      const id = el.id || "";
      if (SKIP_SECTION_ID.test(id)) continue;
      return el;
    }
    for (const el of main.querySelectorAll(".shopify-section")) {
      const id = el.id || "";
      if (SKIP_SECTION_ID.test(id)) continue;
      return el;
    }
  }
  return null;
}

/** True when the node is (or lives in) a full-bleed hero / slider block. */
function isFullWidthElement(el) {
  if (!el || el.nodeType !== 1) return false;

  const tag = (el.tagName || "").toLowerCase();
  if (/^full[-_]?width/.test(tag)) return true;

  const cls = (el.className || "").toString();
  if (FULL_WIDTH_CLASS_RE.test(cls)) return true;

  const style = el.getAttribute("style") || "";
  if (/\bwidth\s*:\s*100%/.test(style) || /\bmax-width\s*:\s*100vw/.test(style)) {
    return true;
  }

  const section = el.closest(".shopify-section");
  if (section?.id && /full[-_]?width/i.test(section.id)) return true;

  if (/group\/banner/.test(cls)) return true;

  if (
    el.matches?.(
      ".banner, .slideshow, .shopify-section--slideshow, .hero, .slide-image-wrapper, .m6fr, .slider-fraction, section[class*='group/banner']",
    )
  ) {
    return true;
  }

  if (el.querySelector?.("img.w-full.object-cover, img.object-cover.w-full")) return true;

  if (/\bembla__slide\b/.test(cls) && /basis-\[100%\]/.test(cls)) return true;

  if (/\bmedia\b/.test(cls)) {
    return !!el.closest(
      ".banner, .slideshow, .shopify-section--slideshow, full-width-slider, .hero, .slide-image-wrapper",
    );
  }

  if (/\btw-w-full\b/.test(cls)) {
    return !!el.closest("full-width-slider, .banner, .slideshow, .slide-image-wrapper, .hero");
  }

  return false;
}

function verifyHomeOnly(homeDoc, productDoc, selector) {
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
  if (homeCount !== 1 || productCount !== 0) {
    return { ok: false, homeCount, productCount };
  }
  const el = homeDoc.querySelector(selector);
  if (!isFullWidthElement(el)) {
    return { ok: false, homeCount, productCount, rejected: "not-full-width" };
  }
  return { ok: true, homeCount, productCount };
}

/** Prefer a stable selector scoped to the first main section for a full-width node. */
function stableSelectorsForFullWidthElement(homeDoc, el, section) {
  const built = new Set();
  const main =
    homeDoc.querySelector("main#root") ||
    homeDoc.querySelector("main#MainContent") ||
    homeDoc.querySelector("main#content");
  const mainPrefix =
    main?.id === "root"
      ? "main#root"
      : main?.id === "MainContent"
        ? "main#MainContent"
        : "main#content";
  const homeScope = homeDoc.body?.classList?.contains("index")
    ? "body.index main#root"
    : mainPrefix;
  const tag = (el.tagName || "").toLowerCase();
  const cls = (el.className || "").toString();

  if (/^full[-_]?width/.test(tag)) {
    built.add(`${homeScope} > .shopify-section:first-of-type ${tag}`);
    built.add(`${mainPrefix} ${tag}`);
  }

  if (/group\/banner/.test(cls)) {
    built.add(`${homeScope} > .shopify-section:first-of-type section[class*="group/banner"]`);
    built.add(`${mainPrefix} > .shopify-section:first-of-type section[class*="group/banner"]`);
  }

  const classes = [...el.classList].filter(
    (c) =>
      c.length > 2 &&
      (FULL_WIDTH_CLASS_RE.test(c) ||
        ["banner", "slideshow", "hero", "media", "m6fr", "slider-fraction"].includes(c) ||
        c.includes("slideshow")),
  );
  if (classes.length) {
    built.add(`${mainPrefix} > .shopify-section:first-of-type .${classes.join(".")}`);
    built.add(`${mainPrefix} .${classes.join(".")}`);
  }

  if (section?.classList?.contains("shopify-section")) {
    for (const inner of FULL_WIDTH_INNER_SELECTORS) {
      if (el.matches?.(inner)) {
        built.add(`${mainPrefix} > .shopify-section:first-of-type ${inner}`);
      }
    }
  }

  return [...built];
}

function discoverFromFirstSectionFullWidth(homeDoc, productDoc) {
  const tried = [];
  const section = firstMainSection(homeDoc);
  if (!section) return { tried };

  for (const innerSel of FULL_WIDTH_INNER_SELECTORS) {
    const nodes = section.querySelectorAll(innerSel);
    for (const el of nodes) {
      if (!isFullWidthElement(el)) continue;
      for (const selector of stableSelectorsForFullWidthElement(homeDoc, el, section)) {
        const v = verifyHomeOnly(homeDoc, productDoc, selector);
        tried.push({ selector, ...v, method: "first-section-full-width" });
        if (v.ok) return { selector, tried };
      }
    }
  }
  return { tried };
}

/** Build selectors from classes on elements inside the first main section (no section id). */
function discoverFromFirstSectionClasses(homeDoc, productDoc) {
  const tried = [];
  const section = firstMainSection(homeDoc);
  if (!section) return { tried };

  const classCounts = new Map();
  for (const el of section.querySelectorAll("[class]")) {
    const classes = [...el.classList].filter(
      (c) =>
        c.length > 2 &&
        !/^(active|hidden|show|open|wide|no-controls|mobile-text-center|align-|text-|palette-|size-|block-slide)/.test(
          c,
        ),
    );
    if (classes.length === 0) continue;
    const key = classes.slice(0, 3).join(".");
    classCounts.set(key, (classCounts.get(key) || 0) + 1);
  }

  const built = new Set();
  for (const el of section.querySelectorAll("[class]")) {
    if (!isFullWidthElement(el)) continue;
    const classes = [...el.classList].filter(
      (c) =>
        ["m6fr", "slider-fraction", "slideshow", "hero", "banner"].includes(c) ||
        (c.includes("slider") && !c.includes("shopify")),
    );
    if (classes.length === 0) continue;
    const combos = [
      `main#content .${classes.join(".")}`,
      `main#content > .shopify-section:first-child .${classes.join(".")}`,
    ];
    for (const sel of combos) {
      if (built.has(sel)) continue;
      built.add(sel);
      const v = verifyHomeOnly(homeDoc, productDoc, sel);
      tried.push({ selector: sel, ...v, method: "first-section-class" });
      if (v.ok) return { selector: sel, tried };
    }
  }
  return { tried };
}

function discoverFromCandidates(homeDoc, productDoc) {
  const tried = [];
  for (const selector of STABLE_CANDIDATES) {
    const v = verifyHomeOnly(homeDoc, productDoc, selector);
    tried.push({ selector, ...v, method: "stable-candidate" });
    if (v.ok) return { selector, tried };
  }
  return { tried };
}

/**
 * Homepage block below navbar — stable CSS only (no dynamic shopify-section ids).
 */
export async function discoverHomePageCvb(storeUrl, storePassword = "") {
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

  const fullWidthTry = discoverFromFirstSectionFullWidth(homeDoc, productDoc);
  if (fullWidthTry.selector) {
    return {
      ok: true,
      storeUrl: base,
      homeUrl: base,
      productUrl,
      selector: fullWidthTry.selector,
      description: "First full-width block below navbar (hero/slider/banner).",
      tried: fullWidthTry.tried,
    };
  }

  const cand = discoverFromCandidates(homeDoc, productDoc);
  if (cand.selector) {
    return {
      ok: true,
      storeUrl: base,
      homeUrl: base,
      productUrl,
      selector: cand.selector,
      description: "First full-width block below navbar via structural selector.",
      tried: [...fullWidthTry.tried, ...cand.tried],
    };
  }

  const classTry = discoverFromFirstSectionClasses(homeDoc, productDoc);
  if (classTry.selector) {
    return {
      ok: true,
      storeUrl: base,
      homeUrl: base,
      productUrl,
      selector: classTry.selector,
      description: "First full-width block via stable theme classes.",
      tried: [...fullWidthTry.tried, ...cand.tried, ...classTry.tried],
    };
  }

  const err = new Error(
    "No stable full-width home-page selector found (home=1, product=0, full-width element).",
  );
  err.statusCode = 422;
  err.tried = [...fullWidthTry.tried, ...cand.tried, ...classTry.tried];
  throw err;
}
