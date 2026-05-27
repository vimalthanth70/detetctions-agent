/**
 * Agent / CLI entry: discover selectors from live storefront.
 *
 *   node scripts/discover.mjs <store.myshopify.com> [password]
 *   STORE_URL=... STORE_PASSWORD=... node scripts/discover.mjs
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAllSelectors } from "../lib/discover-all.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const storeUrl = process.argv[2]?.trim() || process.env.STORE_URL?.trim();
const storePassword = process.argv[3] ?? process.env.STORE_PASSWORD ?? "";

if (!storeUrl) {
  console.error("Usage: node scripts/discover.mjs <store.myshopify.com> [password]");
  process.exit(1);
}

try {
  const result = await discoverAllSelectors(storeUrl, String(storePassword).trim());
  const host = storeUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const header = `/** ${host} */\n`;
  writeFileSync(join(ROOT, "output.js"), header + result.outputJs + "\n", "utf8");
  console.log(result.outputJs);
  console.error(`Wrote output.js (${result.productUrl})`);
} catch (e) {
  console.error(e.message || e);
  if (e.tried) console.error(JSON.stringify(e.tried, null, 2));
  process.exit(e.statusCode || 1);
}
