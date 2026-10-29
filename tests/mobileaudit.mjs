// Walks every route in a real browser at phone widths and reports anything
// that does not fit. Not part of the gate: it needs a running dev server and
// a Chromium download, neither of which belongs in CI here. Run it by hand:
//
//   cd frontend && npm run dev &
//   PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 node tests/mobileaudit.mjs
//
// It answers one question per route and answers it the way a phone does:
// is anything wider than the screen, and if so, what.

import { chromium } from '/home/user/.npm/_npx/8ef14e20fba81900/node_modules/playwright-core/index.mjs'

const BASE = process.env.BASE || 'http://localhost:5173'
const WIDTHS = [320, 390, 768]

const ROUTES = [
  '/', '/login', '/marketplace', '/dashboard', '/wallet', '/ledger', '/umi',
  '/admin', '/admin/ops', '/regulator', '/market', '/cbdc', '/crossborder',
  '/proof', '/verify', '/keys', '/feeds', '/cards', '/chainstate', '/token',
  '/trust', '/support', '/insights', '/explore', '/learn', '/tools',
  '/tools/rental-yield-calculator', '/tools/fractional-calculator',
  '/tools/stamp-duty-calculator', '/tools/emi-calculator',
  '/tools/rent-vs-buy-calculator', '/tools/capital-gains-calculator',
  '/learn/what-is-demat-2', '/learn/what-is-atomic-dvp', '/learn/what-is-umi',
  '/about', '/privacy', '/terms',
]

const findOverflow = () => {
  const vw = document.documentElement.clientWidth
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const style = getComputedStyle(el)
    if (style.position === 'fixed') continue
    if (r.right > vw + 1 || r.left < -1) {
      // Ignore anything inside a container that owns its own horizontal
      // scrolling: a wide ledger table inside a scrolling card is correct.
      let p = el.parentElement
      let scrolls = false
      while (p && p !== document.body) {
        const ps = getComputedStyle(p)
        if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') { scrolls = true; break }
        p = p.parentElement
      }
      if (scrolls) continue
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 40)) || '',
        text: (el.textContent || '').trim().slice(0, 40),
        right: Math.round(r.right),
        width: Math.round(r.width),
        cols: style.gridTemplateColumns.slice(0, 40),
      })
    }
  }
  // The second failure mode, and the one an overflow check cannot see: a
  // layout that fits perfectly and is still unusable, because a two-column
  // grid on a 390px screen leaves a text column 170px wide setting one word
  // per line. Anything holding a real sentence needs about 200px.
  const squeezed = []
  if (vw <= 560) {
    for (const el of document.querySelectorAll('h1, h2, h3, p')) {
      const r = el.getBoundingClientRect()
      const text = (el.textContent || '').trim()
      if (r.width === 0 || text.length < 25) continue
      if (r.width < 200) {
        squeezed.push({ tag: el.tagName.toLowerCase(), width: Math.round(r.width), text: text.slice(0, 40) })
      }
    }
  }

  // Report the outermost offenders only: a parent that overflows drags every
  // child with it, and fixing the parent fixes the list.
  return {
    squeezed: squeezed.slice(0, 4),
    docWidth: document.documentElement.scrollWidth,
    viewport: vw,
    worst: out.sort((a, b) => b.right - a.right).slice(0, 4),
    count: out.length,
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
let bad = 0

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2 })
  console.log(`\n=== ${width}px ===`)
  for (const route of ROUTES) {
    try {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(700)
      const r = await page.evaluate(findOverflow)
      const overflows = r.docWidth > r.viewport + 1 || r.count > 0
      if (r.squeezed && r.squeezed.length) {
        bad++
        console.log(`  SQUEEZED ${route}  text columns under 200px`)
        for (const sq of r.squeezed) console.log(`      ${sq.tag} w=${sq.width} "${sq.text}"`)
      }
      if (overflows) {
        bad++
        console.log(`  OVERFLOW ${route}  doc ${r.docWidth} > ${r.viewport}  (${r.count} elements)`)
        for (const w of r.worst) {
          console.log(`      ${w.tag}.${w.cls} w=${w.width} right=${w.right} cols="${w.cols}" "${w.text}"`)
        }
      } else {
        console.log(`  ok       ${route}`)
      }
    } catch (err) {
      console.log(`  ERROR    ${route}  ${err.message.split('\n')[0]}`)
    }
  }
  await page.close()
}

await browser.close()
console.log(`\n${bad} route/width combinations overflow`)
process.exit(bad === 0 ? 0 : 1)
