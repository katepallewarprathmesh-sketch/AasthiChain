// Every route must ship a distinct, crawlable head in static HTML.
//
// The SPA used to serve one index.html for all fourteen routes and fix the
// head after React mounted. Non-rendering crawlers — Bing's, and so the
// chatbots that read its index — saw identical pages. frontend/scripts/
// prerender.mjs writes a real file per route; this checks it stays that way.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_SEO, SITE_URL, propertySeo } from '../frontend/src/lib/seo.js';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('prerender / per-route metadata');

// --- the source table, checkable without a build -------------------------
const titles = new Map();
const descs = new Map();
for (const [path, seo] of Object.entries(ROUTE_SEO)) {
  if (titles.has(seo.title)) titles.set(seo.title, titles.get(seo.title) + ', ' + path);
  else titles.set(seo.title, path);
  if (descs.has(seo.description)) descs.set(seo.description, descs.get(seo.description) + ', ' + path);
  else descs.set(seo.description, path);
}
const dupTitles = [...titles.entries()].filter(([, v]) => v.includes(','));
const dupDescs = [...descs.entries()].filter(([, v]) => v.includes(','));
t('every route has a unique title', dupTitles.length === 0, dupTitles.map(([k, v]) => `"${k}" on ${v}`).join(' | '));
t('every route has a unique description', dupDescs.length === 0, dupDescs.map(([, v]) => v).join(' | '));

const missing = Object.entries(ROUTE_SEO).filter(([, s]) => !s.title || !s.description).map(([p]) => p);
t('no route is missing title or description', missing.length === 0, missing.join(', '));

// Google truncates past roughly 60 characters. Not fatal, but the table is
// written to a limit and should stay there.
const longTitles = Object.entries(ROUTE_SEO).filter(([, s]) => s.title.length > 65).map(([p, s]) => `${p} (${s.title.length})`);
t('titles stay inside the display limit', longTitles.length === 0, longTitles.join(', '));

const privateRoutes = ['/login', '/dashboard', '/wallet', '/admin', '/regulator', '/insights'];
const indexable = privateRoutes.filter((p) => ROUTE_SEO[p] && !ROUTE_SEO[p].noindex);
t('private surfaces are noindex', indexable.length === 0, indexable.join(', '));

// --- the built output, when there is one ---------------------------------
const dist = new URL('../frontend/dist/', import.meta.url).pathname;
if (!existsSync(join(dist, 'index.html'))) {
  console.log('  skip dist checks — no build present (run: npm run build --prefix frontend)');
} else {
  const read = (p) => {
    const f = p === '/' ? join(dist, 'index.html') : join(dist, p.replace(/^\//, ''), 'index.html');
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  };
  const absent = Object.keys(ROUTE_SEO).filter((p) => read(p) === null);
  t('every route was prerendered to a file', absent.length === 0, absent.join(', '));

  const wrong = [];
  for (const [p, seo] of Object.entries(ROUTE_SEO)) {
    const html = read(p);
    if (!html) continue;
    const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
    // The table holds the raw character; the file holds it escaped.
    const expected = seo.title.replace(/&/g, '&amp;');
    if (title !== expected) wrong.push(`${p}: "${title}"`);
  }
  t('each file carries its own title', wrong.length === 0, wrong.join(' | '));

  const badCanonical = [];
  for (const p of Object.keys(ROUTE_SEO)) {
    const html = read(p);
    if (!html) continue;
    const href = (html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i) || [])[1];
    const want = SITE_URL + (p === '/' ? '/' : p);
    if (href !== want) badCanonical.push(`${p}: ${href}`);
  }
  t('each file points its canonical at itself', badCanonical.length === 0, badCanonical.join(' | '));

  const leaked = privateRoutes.filter((p) => {
    const html = read(p);
    return html && !/<meta\s+name="robots"\s+content="noindex, follow"/i.test(html);
  });
  t('noindex reaches the static HTML, not just the runtime', leaked.length === 0, leaked.join(', '));

  // One canonical tag per page, not two: duplicates split ranking signals,
  // which is the exact failure the template's hardcoded tag would cause if
  // the rewrite ever stopped matching it.
  const doubled = Object.keys(ROUTE_SEO).filter((p) => {
    const html = read(p);
    return html && (html.match(/<link\s+rel="canonical"/gi) || []).length !== 1;
  });
  t('exactly one canonical tag per page', doubled.length === 0, doubled.join(', '));

  const doubledTitle = Object.keys(ROUTE_SEO).filter((p) => {
    const html = read(p);
    return html && (html.match(/<title>/gi) || []).length !== 1;
  });
  t('exactly one title tag per page', doubledTitle.length === 0, doubledTitle.join(', '));

  const home = read('/');
  t('home page keeps the Bing verification tag', !!home && home.includes('msvalidate.01'));
  t('home page keeps its structured data', !!home && home.includes('application/ld+json'));
  t('the app bundle still loads from a nested page',
    (read('/tools/stamp-duty-calculator') || '').includes('src="/assets/'));
}

// --- listings -----------------------------------------------------------
// Nine of the twenty-eight sitemap URLs are property pages. They are built
// from the catalogue, not ROUTE_SEO, and were the last pages still shipping
// the fallback head.
const catalogue = JSON.parse(readFileSync(new URL('../frontend/api/lib/catalogue.json', import.meta.url), 'utf8'));
const listingTitles = new Set();
let dupListing = 0, cityTwice = 0, tooLong = 0;
for (const property of catalogue) {
  const seo = propertySeo(property);
  if (listingTitles.has(seo.title)) dupListing++;
  listingTitles.add(seo.title);
  const city = property.location && property.location.city;
  if (city && (seo.title.match(new RegExp(city, 'gi')) || []).length > 1) cityTwice++;
  if (seo.title.length > 65) tooLong++;
}
t('every listing gets a distinct title', dupListing === 0);
t('a listing never names its city twice', cityTwice === 0);
t('listing titles stay a sensible length', tooLong === 0);

if (existsSync(join(dist, 'index.html'))) {
  const missingListings = catalogue
    .filter((p) => !existsSync(join(dist, 'property', p.assetId, 'index.html')))
    .map((p) => p.assetId);
  t('every listing was prerendered', missingListings.length === 0, missingListings.join(', '));

  const mismatched = [];
  for (const property of catalogue) {
    const f = join(dist, 'property', property.assetId, 'index.html');
    if (!existsSync(f)) continue;
    const html = readFileSync(f, 'utf8');
    const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
    if (title !== propertySeo(property).title.replace(/&/g, '&amp;')) mismatched.push(property.assetId);
    const href = (html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i) || [])[1];
    if (href !== `${SITE_URL}/property/${property.assetId}`) mismatched.push(`${property.assetId} (canonical)`);
  }
  t('listing files match what the runtime would render', mismatched.length === 0, mismatched.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
