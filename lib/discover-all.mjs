import { discoverProductFormSelector } from "./discover-selector.mjs";
import { discoverHomePageCvb } from "./discover-home-cvb.mjs";
import { discoverProductPageCvb } from "./discover-product-page-cvb.mjs";
import { discoverCartDrawerCvb } from "./discover-cart-drawer-cvb.mjs";
import { discoverCartPageDiscountCode } from "./discover-cart-page-discount-code.mjs";
import { discoverCartDrawerDiscountCode } from "./discover-cart-drawer-discount-code.mjs";
import { discoverCartIcon } from "./discover-cart-icon.mjs";
import { discoverCartPageCvb } from "./discover-cart-page-cvb.mjs";
import { formatOutputJs } from "./format-output.mjs";

/**
 * Discover all storefront selectors for a Shopify store.
 * @param {string} storeUrl - hostname or URL (*.myshopify.com)
 * @param {string} [storePassword]
 * @returns {Promise<{ selectors: Record<string, string>, outputJs: string, productUrl: string, homeUrl: string }>}
 */
export async function discoverAllSelectors(storeUrl, storePassword = "") {
  const product = await discoverProductFormSelector(storeUrl, storePassword);
  const home = await discoverHomePageCvb(storeUrl, storePassword);
  const productPage = await discoverProductPageCvb(storeUrl, storePassword);
  const cartDrawer = await discoverCartDrawerCvb(storeUrl, storePassword);
  const cartPageDiscount = await discoverCartPageDiscountCode(storeUrl, storePassword);
  const cartDrawerDiscount = await discoverCartDrawerDiscountCode(storeUrl, storePassword);
  let cartIcon;
  try {
    cartIcon = await discoverCartIcon(storeUrl, storePassword);
  } catch {
    cartIcon = { selector: "" };
  }

  const cartPageCvb = await discoverCartPageCvb(storeUrl, storePassword);

  const selectors = {
    "product-form-selector": product.selector,
    "home-page-cvb": home.selector,
    "product-page-cvb": productPage.selector,
    "cart-drawer-cvb": cartDrawer.selector,
    "cart-page-discount-code": cartPageDiscount.selector,
    "cart-page-cvb": cartPageCvb.selector,
    "cart-icon": cartIcon.selector,
    "cart-drawer-discount-code": cartDrawerDiscount.selector,
  };

  return {
    selectors,
    outputJs: formatOutputJs(selectors),
    productUrl: product.productUrl,
    homeUrl: home.homeUrl,
    storeUrl: product.storeUrl,
  };
}
