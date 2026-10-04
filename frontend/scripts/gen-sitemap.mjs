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
const AUTH_GATED = new Set(['/marketplace', '/dashboard', '/wallet', '/admin', '/regulator'])

// Priority is a hint, not a ranking factor. Home first, then the pages that
// explain what the project is.
const PRIORITY = { '/': '1.0', '/ledger': '0.8', '/umi': '0.8', '/support': '0.5' }
const CHANGEFREQ = { '/': 'weekly', '/ledger': 'daily', '/umi': 'weekly', '/support': 'monthly' }

const today = new Date().toISOString().slice(0, 10)

const urls = Object.entries(ROUTE_SEO)
  .filter(([path, seo]) => !seo.noindex && !AUTH_GATED.has(path))
  .map(([path]) => path)
  .sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)))

if (urls.length === 0) throw new Error('sitemap would be empty - check ROUTE_SEO')

const body = urls
  .map((path) => {
    const loc = SITE_URL + (path === '/' ? '/' : path)
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${today}</lastmod>`,
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
void readFileSync
