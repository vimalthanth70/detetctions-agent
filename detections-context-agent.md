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

When a page is **Cloudflare-blocked** (CF challenge page returned instead of real content), the agent sets affected keys to `❌ CF blocked`:
- PDP blocked → `product-form-selector`, `product-page-cvb`
- Home blocked → `home-page-cvb`, `cart-icon`
- Cart blocked → `cart-page-discount-code`, `cart-page-cvb`
- Drawer keys (`cart-drawer-cvb`, `cart-drawer-discount-code`) always default to `''` when blocked (can't confirm drawer exists)

---

## Hard rules

1. **Theme-native only.** Reject app-injected ids (`mr-div-embedded*`, `shopify-block-Aa*upsell_monk*`). Keep searching; do not emit `''` except allowed drawer keys.
2. **No dynamic ids** in selectors (`shopify-section-template--<digits>__…`).
3. **Keys 5 and 8 are inner totals-row selectors** — the **child block inside** the recap/summary/footer container that holds subtotal/total + checkout (or money amount). **Never emit the outer wrapper root** (`.cart-recap`, `.mini-cart__recap`, `.cart-page__summary`, `.cart-drawer__summary`, `.bls-cart-summary`, etc.). Always scope: `<outer-container> <inner-totals-row>`.
4. **Single quotes** in output; double quotes inside CSS attribute values in JSON replies.

---

## Keys (verify with `querySelectorAll` counts)

### 1. `product-form-selector`
PDP=1, home=0. `<form>` with `action` containing `/cart/add`. Disambiguate duplicate forms with `:not([id*="installment"])` or `.product-form` class when PDP has a separate installment/BNPL form (e.g. `form[action*="/cart/add"].product-form`).

**`id$="__main"` pattern (Prestige / Dawn and many other themes)**: Many Shopify themes generate form IDs in the pattern `product-form-main-{variant_id}-{section_id}__main`. The IDs **end** with `__main`. Always use `id$="__main"` (ends-with), never `id^="product-form-main-"` (starts-with):
- ✅ Correct: `form[id$="__main"]:not([id*="installment"])`
- ❌ Wrong: `form[id^="product-form-main-"]` — this matches both the main form AND the installment form; too broad
- The `id^=` approach also matches quick-buy forms from other sections that happen to start with the same prefix

**Cross-sell / recommendation forms**: Many themes load `<product-recommendations>` or similar elements dynamically via JS inside the product page. These inject additional `form[action*="/cart/add"]` elements that are invisible in the static crawl HTML but present in the live browser. Always scope `product-form-selector` to exclude these:
- Prefer `[data-block-type="buy-buttons"] form[action*="/cart/add"]:not([id*="installment"])` when the theme uses `data-block-type="buy-buttons"` on the main ATC block.
- Or scope to a container that does NOT include recommendations: `.product-info > form`, `.product__form form`, `[data-section-type="product-page"] > … form` — but avoid broad wrappers like `.product-info form` that also wrap `<product-recommendations>`.
- Never use a selector that would match quick-add forms inside `.product-card`, `.product-recommendations`, `.cross-sell`, or `recently-viewed-products`.

### 2. `home-page-cvb`
home=1, PDP=0. First full-width hero / slideshow / banner under the header (e.g. `.banner`, `.fastslider-section`, `slide-show`).

**CVB must be inside `<main>`, not the header**: The `home-page-cvb` is always the first full-width content section inside `<main>` (or the main content area). Hero elements, video banners, or slideshow wrappers that appear inside `<header>` are NOT the CVB. Even if they look like a hero, skip them — check `<main>` for the first prominent section.

**Always use the first HERO/BANNER section in `<main>`**: The CVB is the first full-width hero, slideshow, banner, or branded marquee section immediately inside `<main>`. **Skip collection/product listing sections** even if they appear before the hero in the DOM — `data-section-type="collection-template"`, `data-section-type="featured-collection"`, `#CollectionSection` are NOT heroes. Do NOT jump to a `.hero` element in a LATER section when a brands marquee or other non-hero section precedes it — in that case the non-hero first section IS the CVB. The DOM hints will tell you if the first section is a collection (skip it) or a brands marquee (use it).

**Two-tier decision: outer section class vs. inner branded element**:

Step 1 — look at the outer section div's classes:
- **If it has a unique/branded class** beyond the generic Shopify ones (e.g. `class="shopify-section container-background-image"`) → **use that class** (`.container-background-image`). Do NOT dig into inner elements. Even if `slideshow-component` or other custom elements appear inside, ignore them — the section's own branded class is the selector.
- **If it only has generic classes** (`shopify-section`, `section`, `shopify-section--TYPE`) → look inside for the theme's branded content element.

Step 2 — when looking inside (generic outer class only):
- Custom element tag wrapping inner div: when `<slideshow-component class="homepgae--banner-slider ...">` wraps `<div class="slideshow banner ...">`, pick the **inner semantic div** (`.slideshow`), NOT the custom element's own classes. Custom element classes like `homepgae--banner-slider`, `slider-mobile-gutter`, `mobile-text-below` are layout utilities — ignore them in favour of the semantic content class.
- `<x-slideshow class="slideshow">` → correct: `.slideshow`
- `<section class="shopify-section">` → `<div class="wt-slider wt-brands__container">` → correct: `.wt-brands__container`

**Concrete examples** (exact HTML → correct selector):

```html
<!-- shopdartisan: outer section has branded class → use it, ignore inner slideshow-component -->
<div class="shopify-section container-background-image">
  <slideshow-component style="--slideshow-timeline: ...">...</slideshow-component>
</div>
→ .container-background-image   ✅
→ slideshow-component            ❌ (inner element, ignore)
```

```html
<!-- moroccantan: outer section is generic, custom element wraps semantic div → use inner .slideshow -->
<section class="shopify-section section">
  <slideshow-component class="homepgae--banner-slider slider-mobile-gutter mobile-text-below">
    <div class="slideshow banner banner--medium grid grid--1-col slider">...</div>
  </slideshow-component>
</section>
→ .slideshow                          ✅ (inner semantic div)
→ slideshow-component                 ❌ (custom element tag)
→ .homepgae--banner-slider            ❌ (layout utility class on custom element)
```

```html
<!-- Dawn/vorsteiner: outer section generic → use inner x-slideshow's .slideshow class -->
<section class="shopify-section shopify-section--slideshow">
  <x-slideshow class="slideshow">...</x-slideshow>
</section>
→ .slideshow   ✅
→ section.shopify-section--slideshow  ❌ (generic outer)
```

```html
<!-- shoptinkr: first section in <main> is brands marquee, not a hero → use it -->
<main id="root">
  <section class="shopify-section">  <!-- FIRST section -->
    <div class="wt-slider wt-brands__container wt-brands__container--marquee">...</div>
  </section>
  <section class="shopify-section">  <!-- LATER section with hero inside — skip! -->
    <div class="hero hero--video-background">...</div>
  </section>
</main>
→ .wt-brands__container   ✅ (first section's inner element)
→ .hero                   ❌ (found in a later section, not first)
```

**Use `section.shopify-section--slideshow:first-of-type` only** as a last resort when there are multiple slideshow sections and no unique inner element to disambiguate them.

**Non-slideshow CVB**: Some stores use a different first section as the CVB — a brands marquee (`.wt-brands__container`), a video section, or a featured collection. Always pick the FIRST prominent full-width content section immediately below the header, whatever its type.

**When the inner class is shared across multiple sections (home > 1 match)**: If the first section's inner element uses a class that also appears in later sections (e.g. `hero-banner` used in both the hero AND featured product cards), that class returns home > 1 and fails verification. In this case, look at the OUTER section element's classes instead:
- Some themes use a unique class modifier on the home first-section that does NOT appear on the PDP first-section. E.g. `<section class="shopify-section section">` on home, but `<div class="shopify-section">` (no `section` class) on PDP.
- In that case: `#MainContent > .section:first-child` works as home=1, pdp=0 because `.section` is home-specific.
- Pattern: inspect the outer section tag's full class list. If any class is home-only (not present on PDP's first section), use `#MainContent > .<that-class>:first-child`.
- Example (memorablxs): home first section = `<section class="shopify-section section">`, PDP first section = `<div class="shopify-section">` → use `#MainContent > .section:first-child` ✅

**Branded hero reused on PDP**: Some themes inject the same full-width hero/video wrapper (e.g. `.roova-video-wrapper`) into both the home page and the PDP as a custom liquid section. The verifier will reject it (home=1, pdp=1), but it is still the correct `home-page-cvb` — use it. Prefer the hero element over a fallback section lower on the page (e.g. a shipping marquee) whenever the hero is immediately below the header.

### 3. `product-page-cvb`
home=0, PDP=1. Main product container wrapping gallery + title + variants + cart-add form (must contain `form[action*="cart/add"]`). Often `.product`, `.product-information`, or `.product-details`.

**Do not over-scope with inner child selectors**: The `product-page-cvb` should be the section/container element itself — NOT a child inside it. If `[data-section-type="product-template"]` matches PDP=1, home=0, that IS the correct selector. Do not add child scoping like `[data-section-type="product-template"] .product-single` — the outer element IS the CVB. The verifier checks that the selected element contains the product form; picking an inner child just makes the selector unnecessarily fragile.
- ✅ `[data-section-type="product-template"]`
- ❌ `[data-section-type="product-template"] .product-single` — over-scoped inner child

### 4. `cart-drawer-cvb`
Inside drawer root only (`cart-drawer`, `#CartDrawer`, `.cart-drawer`, `[data-cart-drawer]`, `mini-cart`, `.quick-cart`, `[data-section-type="quick-cart"]`, Alpine `[x-show*="cart"]` / right-drawer modals, etc.). drawer=1; no matches outside drawer on home/PDP/cart main content. `''` only if no drawer.

Line-items container only — not checkout footer. On mini-cart themes, `#mini-cart .drawer__content form` often matches **multiple** nested forms (recommendations); prefer the **direct-child** line-items form: `#mini-cart .drawer__content > form`, or a line-item table/list wrapper. Concept / custom-element themes: `<cart-items>` inside `<cart-drawer>` (`cart-drawer cart-items`); fetch `/?sections=cart-drawer` after add-to-cart for populated markup.

**Scroll-body pattern (`cart-modal` / custom-element drawers)**: Some themes use a `<cart-modal>` custom element with a scroll body (`#CartModal-ScrollBody`) that contains the drawer header/title, the items list, and optionally a product-recommendations section. The scroll body is too broad — scope to the items-only child: `#CartModal-ScrollBody > div:not(.modal-header):not([class*="recommendation"]):not([class*="complementary"])`. When the theme has no recommendation section, `#CartModal-ScrollBody > div:not(.modal-header)` also works. For `cart-drawer-discount-code`, target the first child of the footer sibling: `#CartModal-ScrollBody + div > div:first-child` (the Total row), not the whole footer wrapper `#CartModal-ScrollBody + div`.

**`cart-items-component` is a broad wrapper — prefer the inner items container**: Some themes wrap both the drawer header/title block AND the items list inside `cart-items-component`. In that case, `cart-items-component` is too broad for `cart-drawer-cvb`. Look one level deeper for the items-only child: `.cart-items__wrapper`, `.cart-items`, or a `<table>`/`<ul>` line-item list. Prefer the selector that contains only the product rows, not the drawer title ("Tu carrito", "Your cart", etc.).

**`cart-drawer__items` vs `cart-items__wrapper`**: Some themes (e.g. Prestige/Symmetry) use a two-level nesting inside `cart-drawer-component`:
```html
<cart-drawer-component class="cart-drawer">
  <dialog>
    <div class="cart-drawer__items">         ← outer layout wrapper (too broad)
      <div class="cart-items__wrapper">      ← correct items-only container ✅
        <form action="/cart" class="cart-form">
          <div class="cart-items">...</div>
        </form>
      </div>
    </div>
  </dialog>
</cart-drawer-component>
```
When BOTH `.cart-drawer__items` and `.cart-items__wrapper` exist, always prefer `.cart-items__wrapper` — it is the items-only container. `.cart-drawer__items` is the layout wrapper that may also contain other UI (empty-cart message, recommendations, etc.).
- ✅ `cart-drawer-component .cart-items__wrapper`
- ❌ `cart-drawer-component .cart-drawer__items` — outer layout div, too broad

**HaloTheme / Belle Doll (`[data-cart-wrapper][data-ajax-enabled]`)**: This theme embeds the entire AJAX mini-cart drawer inline in every page's HTML using `[data-cart-wrapper][data-ajax-enabled]`. The same attribute wraps the cart page's main content on `/cart` too. Structure:
- Drawer HTML (home/PDP): `<div class="has-items hide" data-cart-wrapper data-section-type="cart-template" data-ajax-enabled="true">` → contains `<form class="cart cart-form">` → `<div class="cart-quickview__table"><table><tbody data-cart-line-items>`
- Cart page HTML: same `[data-cart-wrapper][data-ajax-enabled]` wraps everything including `.cart__table` and `.cart__footer`
- Cart icon: uses `href="javascript:void(0)"` with `data-cart-pc` attribute (NOT `a[href="/cart"]`) — use `a[data-cart-pc]`
- Correct selectors:
  - `cart-drawer-cvb`: `[data-cart-wrapper] [data-cart-line-items]` (the `<tbody>` items container)
  - `cart-drawer-discount-code`: `[data-cart-wrapper] .cart-quickview__footer` (footer div with subtotal + checkout — contains `[data-cart-subtotal]`)
  - `cart-page-cvb`: `[data-section-type="cart-template"] .cart__table` (table of line items on `/cart`)
  - `cart-page-discount-code`: `[data-section-type="cart-template"] .cart__footer` (right-side summary on `/cart`)
  - `cart-icon`: `a[data-cart-pc]`
- **NEVER use `#t4s-mini_cart`** selectors — that is a synthetic wrapper created internally; it does NOT exist in the real browser DOM.

**Impulse / Archetype themes**: The crawl fetches `/cart?view=ajax` → renders `#CartDrawerForm` with `[data-products]` — this is **not** what the browser DOM sees. The browser loads the drawer via `/?sections=cart-drawer` which renders the real drawer structure. **NEVER output `#CartDrawerForm` or `#CartDrawerForm [data-products]` selectors — these only exist in the AJAX shell, not the live DOM, and will always fail in production even if the verifier passes them against the crawl HTML.**

Two structural variants exist depending on which version of the theme is installed:

- **Standard Impulse/Archetype** (`<cart-drawer>` custom element from sections API): line items → `cart-drawer cart-items`; totals → `cart-drawer .drawer__footer-body .totals`
- **Custom/modified Impulse** (`#CartDrawer` section ID, no `<cart-drawer>` custom element — sections API renders `<section id="CartDrawer" data-section-type="cart-template">`): line items → `#CartDrawer .cart-drawer__section--items`; totals → `#CartDrawer .cart-drawer__footer-main` (the `js-cart-subtotal` div). Recognition signal: drawer section has `data-section-type="cart-template"` and `data-section-modification="drawer"`, items container has class `cart-drawer__section--items`, footer totals has class `cart-drawer__footer-main js-cart-subtotal`.

### 5. `cart-page-discount-code`
cart=1, home=0, PDP=0. **Inner totals row inside the cart recap/summary container** — not the outer wrapper.

**Wrong (outer root):** `.cart-recap`, `.cart-page__summary`, `.cart__sidebar`, `.cart__footer`

**Right (inner child):** `.cart-recap .cart-recap__price-line`, `.cart-page__summary .cart__summary-totals`, `.cart-page__summary .totals`, `.cart__sidebar .totals`, or checkout + money wrapper inside `main`.

If the outer recap is a `<form>`, still pick the **inner price-line / totals row** inside it, not the form root.

**Multiple discount-code widgets on cart page (Aurora theme)**: Some themes (e.g. Aurora) render two `cart-discount-code` elements in main content — one inside an order-notes block and one beside the subtotal. This causes cart=2 for `cart-discount-code` or `.cart-order-notes__discount-code`. Scope to the subtotal-adjacent one: `cart-page cart-subtotal-block .cart-subtotal__totals`. The `cart-page` custom element is the main cart container (excludes drawer); `cart-subtotal-block` is the totals/subtotal block inside it.

**Duplicate totals widget (top-bar / sticky-header mini-cart)**: Some themes render the cart subtotal element (e.g. `.cart_subtotal`, `.js-cart_subtotal`) in **two places** — once inside a persistent top-bar or sticky-header mini-cart widget (which also renders on home/PDP), and once inside the real cart summary. This causes cart=2 (or cart=2 home=1 pdp=1). Do NOT use the bare subtotal selector. Instead, scope to the **real cart summary ancestor** that is cart-page-only. Walk parent chains to find a unique ancestor (e.g. `.subtotal .cart_subtotal`, `div.one-third .cart_subtotal`, `.cart__wrapper .cart_subtotal`). The inspection data will flag this with "✓ <scoped-selector> → cart=1 home=0 pdp=0 ← USE THIS".

### 6. `cart-page-cvb`
cart=1, home=0, PDP=0. Line-items container on `/cart`.

On split-layout cart pages (e.g. Focal / Pureness), `form[action="/cart"]` is often the **`.cart__recap` checkout sidebar**, not line items. Prefer `.cart`, `.cart__content`, `main-cart.cart__content`, `.line-item-table`, `<cart-items>`, or `cart-items-component`.

**Do not over-scope**: Use the theme's named line-items wrapper directly. Do not prepend an extra parent scope when the named class is already unique. E.g.:
- ✅ `.cart-page__items` — unique cart-page-only class, use directly
- ❌ `.cart-page .cart-items__wrapper` — unnecessarily scoped; also picks the inner child instead of the outer named container

### 7. `cart-icon`
home=1 or 2, PDP=same count. Header cart control that **opens the drawer** or navigates to `/cart`. Never `/cart/add`; not a generic footer/mobile duplicate unless it is the real header trigger.

**Prefer theme-specific toggle classes over bare `a[href="/cart"]`.** Bare `a[href="/cart"]` often matches footer links, mobile duplicates, or hidden nodes — use a scoped header selector instead.

| Theme / pattern | Preferred selector |
|-----------------|-------------------|
| Dawn / OS 2.0 | `.header__icons .header__buttons a[href="/cart"]` (count 2 = desktop + mobile is OK) |
| Horizon | `cart-icon` or `cart-icon.header-actions__cart-icon` |
| Pebble / Horizon drawer | `a.cart-drawer-button`; line items `cart-drawer-component cart-items-component .cart-items__wrapper` |
| Warehouse | `.header__action-item-link.header__cart-toggle` |
| Bento | `button[data-option-target="Cart"]` |
| Blouse | `a.bls-minicart-action` |
| Venue | `a.header-trigger__link--cart` (opens `.ajaxcart-draw` overlay) |
| Impulse / Archetype | `a.js-drawer-open-cart` (opens `#CartDrawer` ajax drawer) |
| HaloTheme / Belle Doll | `a[data-cart-pc]` (desktop); cart trigger uses `href="javascript:void(0)"` — `a[href="/cart"]` returns 0 matches |

Count **2 is valid** only when desktop + mobile header rows both match the **same header cart trigger** — do not use `:first-of-type` to force 1 if both are real header controls. If count > 2 or matches outside header, narrow the selector.

### 8. `cart-drawer-discount-code`
Same as key 5, scoped inside drawer. `''` only if no drawer.

Do **not** return the drawer `<footer>` / `.fc-footer` / `.drawer__footer` / `.cart-drawer__summary` / `.mini-cart__recap` **container root**. Pick the **inner totals row** inside it.

**Single-child footer pattern**: When the drawer footer/summary has exactly one meaningful child block that contains the subtotal + discount code area (e.g. `div.cart-summary.cart-drawer-summary` as the sole child of `.cart-drawer__summary`), prefer scoping directly to that first child: `cart-drawer-component .cart-drawer__summary > :first-child` or `cart-drawer-component .cart-drawer-summary`. Do not go deeper than necessary — the first child of the footer IS the correct totals slot.

| Theme / pattern | Preferred selector |
|-----------------|-------------------|
| Warehouse | `.mini-cart__recap .mini-cart__recap-price-line` |
| Warehouse (cart page recap) | `.cart-recap .cart-recap__price-line` (key 5) |
| Horizon | `cart-drawer-component .cart-drawer__summary .cart-totals` or inner `.totals` |
| Concept / Tailwind | `cart-drawer .drawer__footer .grid.grid-cols-2.gap-4` |
| SUPR fc-drawer | `.fc-drawer .fc-footer-inner .fc-subtotal-row` |
| Blouse | `.bls-cart-summary .bls-subtotal` |
| Bento | `#cart form.shopify-cart-form` |
| Venue ajax cart | `.ajaxcart__footer .ajaxcart__footer-total` (inside `#CartTemplate` / `.ajaxcart-draw`) |
| SlideCartHQ app | `.footer-row.amp-sc__footer-row--subtotal` (subtotal row with label + price inside `.slidecarthq`) |
| popup-cart theme | `cart-drawer-cvb`: `.popup-cart .popup-cart__items` (AJAX-populated shell, empty in static HTML — accepted); `cart-drawer-discount-code`: `.popup-cart__footer .popup-cart__subtotal`; drawer root: `.popup-cart.js-popup-cart-ajax` |
| Impulse / Archetype (standard) | `cart-drawer .drawer__footer-body .totals` (totals row inside `<cart-drawer>` sections-API structure — **not** `#CartDrawerForm` which is the `/cart?view=ajax` shell, not the browser DOM) |
| Impulse / Archetype (custom, `#CartDrawer` section) | `#CartDrawer .cart-drawer__footer-main` (the `js-cart-subtotal` div — **not** `#CartDrawerForm`) |
| HaloTheme / Belle Doll (`[data-cart-wrapper]`) | `[data-cart-wrapper] .cart-quickview__footer` (contains `[data-cart-subtotal]` — **not** `.cart-quickview__footer .cart-subtotal` which matches 2) |

---

## Drawer detection

Cart UI may be `<cart-drawer>`, `<cart-drawer-component class="cart-drawer">` (Horizon), `#CartDrawer` / `#CartDrawerForm` (Impulse — JS-injected shell; line items fetched from `/cart?view=ajax` into `[data-products]` after add-to-cart), `#FcDrawer.fc-drawer` / `data-section-id="custom-cart-drawer"` (custom section API — fetch `/?sections=custom-cart-drawer` after add-to-cart), `<mini-cart>` / `form.mini-cart` (Warehouse), `.ajaxcart-draw` / `#CartTemplate` (Venue theme native ajax cart — **not** the drawer when SlideCartHQ app is installed), `.slidecarthq` / `#slidecarthq` (SlideCartHQ app — JS-rendered; synthesize from `/cart.js` after add-to-cart), `.quick-cart`, `[data-cart-drawer]`, `#cart[data-component="Cart"]` (Bento slide-out panel — fetch `/?sections=cart-panel` after add-to-cart), Alpine right-drawer modals (`x-show` with `$store.modals.rightDrawer` / cart), `data-island[data-cart-items]` / `[data-cart-footer]`, or injected via `/?sections=<drawer-section>` after add-to-cart. Horizon themes: cart icon is `<cart-icon>`, line items are `<cart-items-component>`, drawer totals inner block inside `.cart-drawer__summary`. Warehouse: line items `.mini-cart__line-item-list` or `.line-item-table` on `/cart`; drawer recap `.mini-cart__recap .mini-cart__recap-price-line`; cart icon `.header__action-item-link.header__cart-toggle`. Venue: drawer root `.ajaxcart-draw`; line items `.ajaxcart__products`; drawer totals `.ajaxcart__footer .ajaxcart__footer-total`; cart icon `a.header-trigger__link--cart`. **SlideCartHQ** (often on Venue stores): real drawer is `.slidecarthq` (classes like `right light open cartOne checkpoint`); line items `.slidecarthq .items`; totals row `.footer-row.amp-sc__footer-row--subtotal` (container with subtotal label + price — not `.slidecart-subtotal` alone). SUPR-style fc-drawer: line items `#FcItems`, totals `.fc-footer-inner .fc-subtotal-row`. Some themes park drawer markup inside `<template data-should-teleport="…">` — still counts as a drawer. Probe section keys (`header`, `custom-cart-drawer`, `cart`, `cart-items`, `cart-footer`, `cart-panel`, `mini-cart`, `quick-cart`, etc.) after `POST /cart/add.js`.

---

## Password-protected stores

Use `lib/store-session.mjs` with `redirect: "manual"`, apply cookies from the 302, then follow `Location`.

---

## Agent

```bash
npm run serve   # POST /api/discover — crawl, discover agent, DOM verify
```

Pipeline: **Discover agent** proposes 8 selectors from compacted HTML → host **DOM-verifies** each key on the crawled pages.

Env (required on server): `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `PORT`.

Optional **`feedback`** in the request body — corrections or hints for a run. When present, the agent first updates this file with **generalizable** rules learned from the feedback, then re-runs discovery. Pass **`previousSelectors`** when re-running after a bad result so the agent knows what to fix.

**Explicit selectors in feedback** are parsed and DOM-verified directly (not only sent to the LLM). Use any of:

- `cart-page-discount-code: '#main-cart-footer .totals'`
- `cart-page-discount-code should be #main-cart-footer .totals`
- `use #main-cart-footer .totals for cart-page-discount-code`
- A ```json fence with key → selector pairs

Or pass **`selectorOverrides`** in the request body: `{ "cart-page-discount-code": "#main-cart-footer .totals" }`.

Failed keys trigger up to **2 correction passes** with the LLM; verified user hints are applied after each pass.
