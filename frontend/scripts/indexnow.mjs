// IndexNow ping: tells Bing (and Yandex, Seznam, Naver) that URLs changed,
// instead of waiting for a recrawl. Bing's index is what a lot of AI chatbot
// web search reads from, so being indexed there is how the project becomes
// citable in chatbot answers.
//
// Setup, once:
//   1. node scripts/indexnow.mjs --init     -> writes public/<key>.txt
//   2. deploy, so https://<host>/<key>.txt is reachable
//   3. node scripts/indexnow.mjs            -> submits every sitemap URL
//
// The key file is how IndexNow verifies you own the host: the key you submit
// must match the contents of that file. No account or API token needed.

import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pub = join(here, '../public')
const HOST = process.env.INDEXNOW_HOST || 'aasthi-chain.vercel.app'

function findKey() {
  if (!existsSync(pub)) return null
  const f = readdirSync(pub).find((n) => /^[0-9a-f]{32}\.txt$/.test(n))
  return f ? f.replace('.txt', '') : null
}

if (process.argv.includes('--init')) {
  const existing = findKey()
  if (existing) {
    console.log(`IndexNow key already present: ${existing}`)
    console.log(`Verify after deploy: https://${HOST}/${existing}.txt`)
    process.exit(0)
  }
  mkdirSync(pub, { recursive: true })
  const key = randomUUID().replace(/-/g, '')
  writeFileSync(join(pub, `${key}.txt`), key)
  console.log(`IndexNow key created: public/${key}.txt`)
  console.log('Deploy, then run: node scripts/indexnow.mjs')
  process.exit(0)
}

const key = findKey()
if (!key) {
  console.error('No IndexNow key file. Run: node scripts/indexnow.mjs --init')
  process.exit(1)
}

// Read the URLs straight from the sitemap so the two can never disagree.
const sitemap = join(pub, 'sitemap.xml')
if (!existsSync(sitemap)) {
  console.error('public/sitemap.xml missing. Run: npm run sitemap')
  process.exit(1)
}
const urlList = [...readFileSync(sitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
if (!urlList.length) {
  console.error('sitemap contained no URLs')
  process.exit(1)
}

const payload = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList }

const res = await fetch('https://api.indexnow.org/IndexNow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
})

// 200 = accepted, 202 = accepted but key still being validated. Both are fine.
if (res.status === 200 || res.status === 202) {
  console.log(`IndexNow: submitted ${urlList.length} URLs (HTTP ${res.status})`)
  urlList.forEach((u) => console.log('  ' + u))
} else {
  console.error(`IndexNow: HTTP ${res.status} — ${await res.text()}`)
  console.error('403 usually means the key file is not reachable at ' + payload.keyLocation)
  process.exit(1)
}
