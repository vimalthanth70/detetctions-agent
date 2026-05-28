const HOST_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9_]*\.myshopify\.com$/;

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

/** Use redirect target origin so cart cookies work on custom domains. */
export function effectiveStoreBase(finalUrl, fallbackBase) {
  try {
    return `${new URL(finalUrl).origin}/`;
  } catch {
    return fallbackBase;
  }
}
