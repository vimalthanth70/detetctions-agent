# Detections context for agents

Discover eight theme-native CSS selectors from a live Shopify storefront and write **`output.js`**.

## Output

```javascript
/** store.myshopify.com */
export default {
  'product-form-selector':     '<css>',
  'home-page-cvb':             '<css>',
  'product-page-cvb':          '<css>',
  'cart-drawer-cvb':           '<css or "">',
  'cart-page-discount-code':   '<css>',
  'cart-page-cvb':             '<css>',
  'cart-icon':                 '<css>',
  'cart-drawer-discount-code': '<css or "">',
};
```

Single quotes in `output.js`. All eight keys, this order.

### Required keys

| Key | Rule |
|-----|------|
| `product-form-selector`, `home-page-cvb`, `product-page-cvb`, `cart-page-discount-code`, `cart-page-cvb`, `cart-icon` | **Always non-empty** |
| `cart-drawer-cvb`, `cart-drawer-discount-code` | **Non-empty when the theme has a cart drawer / mini-cart / quick-cart overlay**; otherwise `''` |

Only the two drawer keys may be `''`, and only when there is no cart overlay markup.

---

## Hard rules

1. **Theme-native only.** Reject app-injected ids (`mr-div-embedded*`, `shopify-block-Aa*upsell_monk*`). Keep searching; do not emit `''` except allowed drawer keys.
2. **No dynamic ids** in selectors (`shopify-section-template--<digits>__…`).
3. **Keys 5 and 8 are totals-wrapper selectors** — the element that contains the subtotal/total block (or checkout + money amount), not a block found by `discount` / `coupon` keywords.
4. **Single quotes** in output; double quotes inside CSS attribute values in JSON replies.

---

## Keys (verify with `querySelectorAll` counts)

### 1. `product-form-selector`
PDP=1, home=0. `<form>` with `action` containing `/cart/add`. Disambiguate duplicate forms with `:not([id*="installment"])` etc.

### 2. `home-page-cvb`
home=1, PDP=0. First full-width hero / slideshow / banner under the header.

### 3. `product-page-cvb`
home=0, PDP=1. Main product container wrapping gallery + title + variants + cart-add form (must contain `form[action*="cart/add"]`).

### 4. `cart-drawer-cvb`
Inside drawer root only (`cart-drawer`, `#CartDrawer`, `.cart-drawer`, `[data-cart-drawer]`, `mini-cart`, `.quick-cart`, `[data-section-type="quick-cart"]`, Alpine `[x-show*="cart"]` / right-drawer modals, etc.). drawer=1; no matches outside drawer on home/PDP/cart main content. `''` only if no drawer.

Line-items container only — not checkout footer. On mini-cart themes, `#mini-cart .drawer__content form` often matches **multiple** nested forms (recommendations); prefer the **direct-child** line-items form: `#mini-cart .drawer__content > form`, or a line-item table/list wrapper.

### 5. `cart-page-discount-code`
cart=1, home=0, PDP=0. Totals wrapper on `/cart` — the block above subtotal/total with checkout. Often inside `form[action="/cart"]`, but on many modern themes checkout/totals sit **outside** the line-items form as a sibling in `main` (e.g. `main [class*='border-t-section']`, wrapper around `input[name='checkout']`). Must not match site footer or drawer overlay. Qualifies via totals class/text, or checkout control + money amount.

### 6. `cart-page-cvb`
cart=1, home=0, PDP=0. Line-items container on `/cart`.

On split-layout cart pages (e.g. Focal / Pureness), `form[action="/cart"]` is often the **`.cart__recap` checkout sidebar**, not line items. Prefer `.cart`, `.cart__content`, `.line-item-table`, or `cart-items`.

### 7. `cart-icon`
home=1, PDP=1. Header cart control (`<a>`, `<button>`, or `<cart-icon>`). Links to `/cart` or opens drawer; never `/cart/add`; not inside drawer. If desktop+mobile duplicate links (count 2), use `:first-of-type` or row-specific scope.

### 8. `cart-drawer-discount-code`
Same as key 5, scoped inside drawer. `''` only if no drawer.

Do **not** return the drawer `<footer>` root (e.g. `footer.mini-cart__drawer-footer`). Pick the **inner block inside the footer above the price/recap/checkout area** — e.g. `#mini-cart footer .mini-cart__actions`, `div.cart__recap-block` (drawer equivalent when present).

---

## Drawer detection

Cart UI may be `<cart-drawer>`, `<mini-cart>`, `.quick-cart`, `[data-cart-drawer]`, Alpine right-drawer modals (`x-show` with `$store.modals.rightDrawer` / cart), `data-island[data-cart-items]` / `[data-cart-footer]`, or injected via `/?sections=<drawer-section>` after add-to-cart. Some themes park drawer markup inside `<template data-should-teleport="…">` — still counts as a drawer. Probe section keys (`cart`, `cart-items`, `cart-footer`, `quick-cart`, etc.) after `POST /cart/add.js`.

---

## Password-protected stores

Use `lib/store-session.mjs` with `redirect: "manual"`, apply cookies from the 302, then follow `Location`.

---

## Agent

```bash
npm run serve   # POST /api/discover — discover agent + verifier agent pipeline
```

Pipeline: **Discover agent** proposes 8 selectors from compacted HTML → **Verifier agent** DOM-checks each key and retries failed keys (up to 5 attempts per key) until all pass or progress stops.

Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-4-6`), `PORT`.

Optional **`feedback`** in the request body — corrections or hints for a run. When present, the agent first updates this file with **generalizable** rules learned from the feedback, then re-runs discovery. Pass **`previousSelectors`** when re-running after a bad result so the agent knows what to fix.
