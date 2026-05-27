# Detections Agent — Agent steps

Discover CSS selectors for a Shopify storefront. **Agent-only**: pass **store URL** and optional **password**; run discovery against the live store (no UI, no saved HTML files).

---

## Input

| Field | Required | Example |
|-------|----------|---------|
| **Store URL** | Yes | `shop-cactus-nail.myshopify.com` |
| **Password** | Only if password protected | `your-password` |

---

## Flow

1. Open `https://<store>/` (login via `/password` if needed).
2. Open first product from home (`/products/<handle>`).
3. Discover all selectors (see keys below).
4. For `cart-drawer-cvb`: POST `/cart/add.js` with one variant, then inspect cart drawer markup.
5. Write **`output.js`**.

---

## Output keys (`output.js`)

| Key | Description | Empty when |
|-----|-------------|------------|
| `product-form-selector` | Main add-to-cart `<form>` on PDP | — |
| `home-page-cvb` | First **full-width** block below navbar on home (hero/slider/banner) | — |
| `product-page-cvb` | Main product container on PDP | — |
| `cart-drawer-cvb` | Container for all cart line items in drawer | `""` if no cart drawer |
| `cart-page-discount-code` | Cart drawer footer container (not discount placeholder) | `""` if no drawer or no footer |
| `cart-page-cvb` | Line-items container on `/cart` page | `""` if no stable cart page container |
| `cart-icon` | Header control that opens cart drawer or goes to `/cart` | — |

Use stable selectors (theme classes/structure). Avoid dynamic `#shopify-section-template--…` ids.

---

## Run (agent / CLI)

```bash
cd detections-agent
node scripts/discover.mjs shop-cactus-nail.myshopify.com
node scripts/discover.mjs your-store.myshopify.com your-password
```

Or:

```bash
STORE_URL=your-store.myshopify.com STORE_PASSWORD=secret npm run discover
```

Programmatic:

```javascript
import { discoverAllSelectors } from "./lib/discover-all.mjs";
const { selectors, outputJs } = await discoverAllSelectors("your-store.myshopify.com", "");
```

---

## Verification

| Key | Home | Product page | `/cart` (after add-to-cart) |
|-----|------|----------------|----------------------------|
| `product-form-selector` | — | **1** | — |
| `home-page-cvb` | **1** | **0** | — |
| `product-page-cvb` | **0** | **1** | — |
| `cart-drawer-cvb` | — | **1** in drawer, or `""` | — |
| `cart-page-cvb` | **0** | **0** | **1**, or `""` |

---

## Files

| File | Role |
|------|------|
| [`lib/discover-all.mjs`](./lib/discover-all.mjs) | Runs all discovery |
| [`lib/discover-cart-page-cvb.mjs`](./lib/discover-cart-page-cvb.mjs) | `/cart` line-items container |
| [`lib/discover-*.mjs`](./lib/) | Other per-selector logic |
| [`scripts/discover.mjs`](./scripts/discover.mjs) | CLI entry |
| [`output.js`](./output.js) | Result |
