import { parseHTML } from 'linkedom';
import { normalizeStoreUrl } from '../lib/discover-selector.mjs';

const HOST = 'isomers-store.myshopify.com';
const base = normalizeStoreUrl(HOST);

async function fetchHtml(path) {
  const res = await fetch(new URL(path, base).href, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36' },
    redirect: 'follow',
  });
  return res.text();
}

const homeHtml = await fetchHtml('/');
const m = homeHtml.match(/href="(\/products\/[^"?#]+)"/);
if (!m) throw new Error('no product link');
const productHtml = await fetchHtml(m[1]);

function count(html, sel) {
  const { document } = parseHTML(html);
  return document.querySelectorAll(sel).length;
}

const tests = [
  ['home-user', 'main#MainContent > .shopify-section:first-of-type:not(.section)'],
  ['prod-user', 'main#MainContent > section.shopify-section:first-of-type'],
  ['form-user', 'form[action="/cart/add"]:not(.installment):not(.sticky-atc-bar__form)'],
];
for (const [name, sel] of tests) {
  console.log(name, 'home', count(homeHtml, sel), 'product', count(productHtml, sel));
}
console.log('product', m[1]);

for (const needle of ['cart-drawer', 'CartDrawer', 'cart-items', 'role="list"']) {
  console.log('home contains', needle, homeHtml.includes(needle));
}
