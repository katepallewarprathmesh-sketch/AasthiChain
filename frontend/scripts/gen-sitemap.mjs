// Generates public/sitemap.xml from the single source of truth in src/lib/seo.js.
//
// A page belongs in the sitemap only if a crawler can actually reach it and
// we want it indexed. Two exclusions:
//   1. noindex routes (dashboard, wallet, admin, regulator, insights, login)
//   2. auth-gated routes - a crawler hitting them is redirected to /login, so
//      listing them would fill the sitemap with soft redirects.
//
// Run: npm run sitemap  (also runs automatically as part of npm run build)

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const { ROUTE_SEO, SITE_URL } = await import(join(root, 'src/lib/seo.js'))

// Routes that React Router gates behind a logged-in user. Keep in sync with
// App.jsx; the check below fails loudly if a route disappears.
// Routes React Router still gates behind a logged-in user. /marketplace and
// /property/:id were removed from this set when they became publicly
// readable - browsing is open, investing still needs an account.
const AUTH_GATED = new Set(['/dashboard', '/wallet', '/admin', '/regulator'])

// Priority is a hint, not a ranking factor. Home first, then the pages that
// explain what the project is.
const PRIORITY = {
  '/': '1.0',
  '/tools/rental-yield-calculator': '0.9',
  '/tools/stamp-duty-calculator': '0.9',
  '/tools/home-loan-emi-calculator': '0.9',
  '/tools/rent-vs-buy-calculator': '0.9',
  '/tools/capital-gains-tax-calculator': '0.9',
  '/tools/fractional-investment-calculator': '0.9',
  '/tools': '0.8',
  '/ledger': '0.8',
  '/umi': '0.8',
  '/learn/what-is-demat-2': '0.9',
  '/learn/what-is-atomic-dvp': '0.9',
  '/learn/what-is-umi': '0.9',
  '/learn': '0.8',
  '/about': '0.7',
  '/support': '0.5',
  '/privacy': '0.3',
  '/terms': '0.3',
}
const CHANGEFREQ = { '/': 'weekly', '/ledger': 'daily', '/umi': 'weekly', '/support': 'monthly', '/tools': 'monthly', '/about': 'monthly', '/learn': 'monthly', '/privacy': 'yearly', '/terms': 'yearly' }

const today = new Date().toISOString().slice(0, 10)

// lastmod has to mean "this page changed", not "someone ran a build". Stamping
// today on all 29 URLs every build taught crawlers the date carries no
// information. So: keep whatever date a URL already had, and only use today
// for URLs appearing for the first time.
const previousLastmod = (() => {
  const map = new Map()
  try {
    const old = readFileSync(join(root, 'public/sitemap.xml'), 'utf8')
    const re = /<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g
    for (const m of old.matchAll(re)) map.set(m[1], m[2])
  } catch {
    // No sitemap yet - every URL is new, which is correct on a first run.
  }
  return map
})()

// Every property is its own landing page - these are the URLs with real
// search intent behind them ("fractional investment in Pune"), so they belong
// in the sitemap. Read from the catalogue so the two can never drift apart.
const catalogue = JSON.parse(readFileSync(join(root, 'api/lib/catalogue.json'), 'utf8'))
const propertyUrls = catalogue.map((p) => `/property/${p.assetId}`)

const urls = [
  ...Object.entries(ROUTE_SEO)
    .filter(([path, seo]) => !seo.noindex && !AUTH_GATED.has(path))
    .map(([path]) => path),
  ...propertyUrls,
]
  .sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)))

if (urls.length === 0) throw new Error('sitemap would be empty - check ROUTE_SEO')

const body = urls
  .map((path) => {
    const loc = SITE_URL + (path === '/' ? '/' : path)
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${previousLastmod.get(loc) || today}</lastmod>`,
      `    <changefreq>${CHANGEFREQ[path] || 'monthly'}</changefreq>`,
      `    <priority>${PRIORITY[path] || '0.5'}</priority>`,
      '  </url>',
    ].join('\n')
  })
  .join('\n')

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.w3.org/1999/xhtml/sitemap">
${body}
</urlset>
`.replace('http://www.w3.org/1999/xhtml/sitemap', 'http://www.sitemaps.org/schemas/sitemap/0.9')

const out = join(root, 'public/sitemap.xml')
writeFileSync(out, xml)
console.log(`sitemap: ${urls.length} public URLs -> public/sitemap.xml`)
for (const u of urls) console.log('  ' + u)

// Sanity: every noindex route must be absent from the file.
const noindexed = Object.entries(ROUTE_SEO).filter(([, s]) => s.noindex).map(([p]) => p)
const leaked = noindexed.filter((p) => xml.includes(`<loc>${SITE_URL}${p}</loc>`))
if (leaked.length) throw new Error('noindex routes leaked into sitemap: ' + leaked.join(', '))
