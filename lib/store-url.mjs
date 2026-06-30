const HOST_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9_]*\.myshopify\.com$/;
// Custom domains must look like a valid hostname (no path, no query)
const CUSTOM_DOMAIN_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}$/;

export function normalizeStoreUrl(input, { allowCustomDomain = false } = {}) {
  const raw = String(input || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (HOST_PATTERN.test(raw)) {
    return `https://${raw}/`;
  }
  if (allowCustomDomain && CUSTOM_DOMAIN_PATTERN.test(raw)) {
    return `https://${raw}/`;
  }
  throw new Error("Invalid store URL. Use your Shopify hostname, e.g. your-store.myshopify.com");
}

/** Use redirect target origin so cart cookies work on custom domains. */
export function effectiveStoreBase(finalUrl, fallbackBase) {
  try {
    return `${new URL(finalUrl).origin}/`;
  } catch {
    return fallbackBase;
  }
}
