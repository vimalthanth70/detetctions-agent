# Detections context for agents

Full context for the **detections-agent** project. Discovers Shopify storefront CSS selectors from the live store and writes **`detections-agent/output.js`** with eight keys. No UI, no HTML fixtures.

## TL;DR

```bash
cd detections-agent
node scripts/discover.mjs <store.myshopify.com> [password]
```

Writes `output.js`:

```javascript
/** store-hostname.myshopify.com */
export default {
  'product-form-selector':     '<css selector>',
  'home-page-cvb':             '<css selector>',
  'product-page-cvb':          '<css selector>',
  'cart-drawer-cvb':           '<css selector or "">',
  'cart-page-discount-code':   '<css selector or "">',
  'cart-page-cvb':             '<css selector or "">',
  'cart-icon':                 '<css selector>',
  'cart-drawer-discount-code': '<css selector or "">',
};
```

Use single quotes. Always emit all eight keys in this order. Use `''` when a key has no stable theme-native selector.

---

## Hard rules

1. **Theme-native only.** Reject app-injected selectors. Specifically: ids starting with `mr-div-embedded`, or `shopify-block-Aa…` containing `upsell_monk` / `monk_stage` / `monk_*`. If an element exists only because an app injected it, emit `''` instead.
2. **No dynamic ids.** Reject anything matching `shopify-section-template--<digits>__…` (changes per deploy).
3. **`cart-page-discount-code` and `cart-drawer-discount-code` are *totals-wrapper* selectors.** They mark the slot *above the total price* where a discount UI would render. Discovery must NOT search by `discount` / `coupon` / `footer` keywords — it must locate the element that **contains** a totals/subtotal block (`.totals`, `.totals__subtotal`, `[data-cart-total]`, or visible text `Subtotal` / `Estimated total` / `Order total`), scoped to the correct surface.
4. **Single quotes** in `output.js`; use double quotes inside CSS attribute values.

---

## Output keys

Every key follows the same shape: a CSS selector that's unique on its surface and theme-native. Counts below mean `document.querySelectorAll(selector).length`.

### 1. `product-form-selector` — main add-to-cart `<form>` on PDP

- **Verify:** PDP=1; matched node is `<form>`, `action` includes `/cart/add`, has add control (`button[name="add"]`, `input[name="add"]`, or `button[type="submit"]`).
- **Avoid:** unscoped `form[data-type="add-to-cart-form"]` or `form[action*="/cart/add"]` — recommendation forms collide.
- **Patterns:** see `lib/discover-selector.mjs` `CANDIDATES`. Common: `product-form form[data-type="add-to-cart-form"]`, `form[id^="product-form-template"][data-type="add-to-cart-form"]`, `form[action="/cart/add"]:not(.installment):not(.sticky-atc-bar__form)`.

### 2. `home-page-cvb` — first full-width content block under the navbar (home only)

- **Verify:** home=1, PDP=0. Element is full-bleed: custom tag `full-width-slider`, or class `full-width` / `full_width` / `w-full` / `tw-w-full` / `.banner` / `.slideshow` / `.hero`. `.media` only inside hero/banner/slideshow. Section wrappers alone are rejected unless known full-bleed.
- **Patterns:**
  - Dawn / Horizon: `main#MainContent > .shopify-section:first-of-type .banner`
  - Cactus: `main#MainContent > .shopify-section:first-of-type .media.w-full`
  - Boxo / Xtra: `main#content .m6fr.slider-fraction`
  - Isomers: `main#MainContent > .shopify-section:first-of-type full-width-slider`

### 3. `product-page-cvb` — main product container on PDP

- **Verify:** home=0, PDP=1. Wraps gallery + title + variants + form (not the form itself).
- `data-update-url="true"` separates full PDP from home **featured product** blocks.
- **Patterns:**
  - Dawn: `product-info[data-update-url="true"]` or `main#MainContent product-info`
  - Boxo / F8: `article#main-product`
  - Isomers: `main#MainContent > section.shopify-section:first-of-type`
  - Horizon: `.product-information`

### 4. `cart-drawer-cvb` — line-items container inside cart drawer / mini-cart / cart-popup

- **Prep:** `POST /cart/add.js` with first variant id.
- **Verify:** count=1 inside drawer root (`cart-drawer`, `#CartDrawer`, `.cart-drawer`, `mini-cart`, `cart-popup`, `section[x-show="cart_drawer"]`).
- **No cart UI on the theme** → `''`.
- **Patterns:**
  - Cactus: `cart-drawer cart-items ul[role="list"]`
  - Dawn: `cart-drawer #CartDrawer-CartItems`
  - Isomers (mini-cart): `.mini-cart .product-cards-container`

### 5. `cart-page-discount-code` — totals wrapper on `/cart` (above-total slot)

- **Prep:** add an item to cart, then `GET /cart` so totals render.
- **Verify:** `/cart`=1, home=0, PDP=0. Element scoped to `form#cart` / `form[action="/cart"]` / `body.cart` / `body.template-cart`, **not** inside any cart drawer / mini-cart, and **contains** a totals block.
- **No stable wrapper** → `''`.
- **Patterns:**
  - Dawn: `.cart__blocks` (parent of `.totals` inside `.cart__footer`) or scoped `form#cart .cart__blocks`
  - Vintage: `form[action="/cart"] .cart__totals`
  - Horizon: `.cart-page__totals` / `.cart-page__summary`

### 6. `cart-page-cvb` — line-items container on `/cart`

- **Verify:** `/cart`=1, home=0, PDP=0. Matched node is `cart-items`, `#main-cart-items`, or `.js-contents` inside `form#cart` / `.cart__contents`. Id must not start with `mr-div-embedded`.
- **No line-items container** → `''`.
- **Patterns:**
  - Dawn / Isomers: `cart-items #main-cart-items`
  - Dawn alternate: `form#cart #main-cart-items`

### 7. `cart-icon` — header cart control

- **Verify:** home=1 and PDP=1. Element is `<a>` / `<button>` / `<cart-icon>`. Opens drawer (`aria-controls="CartDrawer"` / `cart-drawer`) or links to `/cart` (never `/cart/add`). Not inside the drawer itself.
- **Patterns:**
  - Cactus: `a.cart-drawer-button[aria-controls="CartDrawer"]`
  - Dawn: `a[href="/cart"].header__icon--cart`, `a#cart-icon`, `header a[href="/cart"]:has(svg)`
- **Avoid:** `a[href="/cart"]:not([href*="/cart/add"])` when it matches multiple links (e.g. header + "View cart" in drawer).

### 8. `cart-drawer-discount-code` — totals wrapper inside cart drawer / mini-cart (above-total slot)

- Same rule as key 5, scoped inside the drawer.
- **No drawer** or **no totals wrapper inside it** → `''`.
- **Patterns:**
  - Dawn / Cactus: `cart-drawer .cart-drawer__footer` (or `#CartDrawer .drawer__footer`)
  - Alpine slide-in: `section[x-show="cart_drawer"] aside`
  - Isomers (mini-cart): `mini-cart ul.ctas`

> Names like `.cart-drawer__footer` are accepted because the theme happens to use that class for the totals wrapper. The discovery rule is "wrapper containing totals", not "find the word footer".

---

## Password-protected stores

`GET /password` → extract `authenticity_token` → `POST /password` with `redirect: "manual"` → apply `Set-Cookie` from the 302 → follow `Location` → continue.

**Critical:** Shopify's password POST returns **302** with the session cookie. If you let the client auto-follow (`redirect: "follow"`) before applying cookies, the home fetch still sees the gate. Always use `lib/store-session.mjs#loginStore` (which does this correctly) instead of hand-rolled flows.

| Situation | Action |
|-----------|--------|
| Password gate, no password provided | Stop: *Store is password protected. Password is required.* |
| Wrong password | Stop: *Password incorrect.* |
| Store opens without gate | Omit password |

---

## Example outputs

### vimal-sanity.myshopify.com (Dawn, password `root`)

```javascript
export default {
  'product-form-selector':     'product-form form[data-type="add-to-cart-form"]',
  'home-page-cvb':             'main#MainContent > .shopify-section:first-of-type .banner',
  'product-page-cvb':          'main#MainContent product-info',
  'cart-drawer-cvb':           'cart-drawer #CartDrawer-CartItems',
  'cart-page-discount-code':   '.cart__blocks',
  'cart-page-cvb':             'cart-items #main-cart-items',
  'cart-icon':                 'header a[href="/cart"]:has(svg)',
  'cart-drawer-discount-code': 'cart-drawer .cart-drawer__footer',
};
```

### shop-cactus-nail.myshopify.com

```javascript
export default {
  'product-form-selector':     'form[id^="product-form-template"][data-type="add-to-cart-form"]',
  'home-page-cvb':             'main#MainContent > .shopify-section:first-of-type .media.w-full',
  'product-page-cvb':          'product-info[data-update-url="true"]',
  'cart-drawer-cvb':           'cart-drawer cart-items ul[role="list"]',
  'cart-page-discount-code':   '.cart__blocks',
  'cart-page-cvb':             'cart-items #main-cart-items',
  'cart-icon':                 'a.cart-drawer-button[aria-controls="CartDrawer"]',
  'cart-drawer-discount-code': 'cart-drawer .cart-drawer__footer',
};
```

### isomers-store.myshopify.com (mini-cart popup + cart-drawer section)

```javascript
export default {
  'product-form-selector':     'form[action="/cart/add"]:not(.installment):not(.sticky-atc-bar__form)',
  'home-page-cvb':             'main#MainContent > .shopify-section:first-of-type full-width-slider',
  'product-page-cvb':          'main#MainContent > section.shopify-section:first-of-type',
  'cart-drawer-cvb':           '.mini-cart .product-cards-container',
  'cart-page-discount-code':   '',
  'cart-page-cvb':             'cart-items #main-cart-items',
  'cart-icon':                 'header a[href="/cart"]:has(svg)',
  'cart-drawer-discount-code': 'mini-cart ul.ctas',
};
```

### shapeshifter-fish-and-friends.myshopify.com (no cart drawer)

```javascript
export default {
  'product-form-selector':     'product-form form[data-type="add-to-cart-form"]',
  'home-page-cvb':             'main#MainContent > .shopify-section:first-of-type .banner',
  'product-page-cvb':          'product-info[data-update-url="true"]',
  'cart-drawer-cvb':           '',
  'cart-page-discount-code':   '',
  'cart-page-cvb':             '',
  'cart-icon':                 'header a[href="/cart"]:has(svg)',
  'cart-drawer-discount-code': '',
};
```

### boxo-usa.myshopify.com (F8 theme)

```javascript
export default {
  'product-form-selector':     'form.f8pr-buy-button[action="/cart/add"]',
  'home-page-cvb':             'main#content .m6fr.slider-fraction',
  'product-page-cvb':          'article#main-product',
  'cart-drawer-cvb':           '',
  'cart-page-discount-code':   '',
  'cart-page-cvb':             '',
  'cart-icon':                 'header a[href="/cart"]:has(svg)',
  'cart-drawer-discount-code': '',
};
```

---

## When automation fails

1. Run the CLI and read the `tried` array in the error output for per-candidate counts.
2. Fetch home + one PDP (+ `/cart` if relevant) with `fetch` / `curl`.
3. Use `linkedom` or DevTools `querySelectorAll` on each surface to pick the most specific stable selector that satisfies the count rules above.
4. Write `output.js` manually with the correct header comment. Never save HTML to `fixtures/` — the project does not use snapshots.

---

## Project layout

```
detections-agent/
├── detections-context-agent.md            ← this file
├── output.js                              ← deliverable (generated)
├── package.json                           ← npm run discover
├── scripts/
│   ├── discover.mjs                       ← CLI entry
│   └── debug-login.mjs                    ← password-flow debug helper
└── lib/
    ├── discover-all.mjs                       ← runs all 8 discoveries
    ├── discover-selector.mjs                  ← key 1
    ├── discover-home-cvb.mjs                  ← key 2
    ├── discover-product-page-cvb.mjs          ← key 3
    ├── discover-cart-drawer-cvb.mjs           ← key 4
    ├── discover-cart-page-discount-code.mjs   ← key 5
    ├── discover-cart-page-cvb.mjs             ← key 6
    ├── discover-cart-icon.mjs                 ← key 7
    ├── discover-cart-drawer-discount-code.mjs ← key 8
    ├── cart-drawer-html.mjs                   ← cart-drawer HTML loader
    ├── store-session.mjs                      ← shared login (redirect: "manual")
    └── format-output.mjs                      ← serialize output.js
```

---

## Pre-finish checklist

- [ ] Store URL is `*.myshopify.com`; password used iff store is gated (via `loginStore`).
- [ ] `output.js` has all 8 keys in the canonical order, single-quoted.
- [ ] Counts: key 1 PDP=1; key 2 home=1, PDP=0; key 3 home=0, PDP=1; keys 5/6 cart=1, home=0, PDP=0; key 7 home=1, PDP=1.
- [ ] Keys 5 and 8 are wrappers that **contain** a totals/subtotal block (no `discount` / `footer` keyword matching).
- [ ] No dynamic `#shopify-section-template--…` ids.
- [ ] No app-injected ids (`mr-div-embedded*`, `shopify-block-Aa*upsell_monk*`).

---

## One-line prompt

> Read `detections-agent/detections-context-agent.md`, then run `node scripts/discover.mjs <STORE_URL> [PASSWORD]` in `detections-agent/` and return the contents of `output.js`. If discovery fails, follow the manual rules in that doc and still produce a valid `output.js`.

---

## Feedback log (append-only)

Append one line per piece of user feedback that changed how detection works. Format: `date — store — lesson`.

- 2026-05-27 — vimal-sanity — Always emit **8** keys (added `cart-drawer-discount-code`); the old `cart-page-discount-code` slot previously held the drawer wrapper, which was wrong.
- 2026-05-27 — vimal-sanity — Reject **app-injected ids** (`mr-div-embedded*`, `shopify-block-Aa*upsell_monk*`). Emit `''` instead of falling back to them.
- 2026-05-27 — vimal-sanity — Password login must use `redirect: "manual"` and apply `Set-Cookie` from the 302 before following. Use `lib/store-session.mjs#loginStore`.
- 2026-05-27 — vimal-sanity — When the home HTML already contains the drawer, use home HTML alone for drawer probing; only concatenate section HTML when the drawer is injected post-add-to-cart.
- 2026-05-27 — vimal-sanity — Keys 5 and 8 are *totals-wrapper* selectors. Find the element containing `.totals` / Subtotal text in the correct scope; do NOT search by `discount` / `coupon` / `footer` strings.
