// The picture beside a listing has to be the right kind of building.
//
// This suite exists because it was missing. Six images were being spread
// across nine demo listings by a seeded pick over a keyword pool, and three
// separate things went wrong without anything failing: three listings shared
// one warehouse photograph, an office block rendered as a retail street, and
// "Aravali Residency Plots", which is vacant land, rendered as a warehouse.
//
// A wrong photograph beside a valuation and a ledger id is not a cosmetic
// bug. It is the record saying something false about the asset.
//
//   node tests/propertyimages.test.mjs

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FRONTEND = join(ROOT, 'frontend')
const IMAGE_DIR = join(FRONTEND, 'public', 'property-images')

let passed = 0, failed = 0
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')) }
}

const { propertyImage, REPRESENTATIVE_NOTE } =
  await import(join(FRONTEND, 'src', 'lib', 'propertyImages.js'))
const catalogue = JSON.parse(readFileSync(join(FRONTEND, 'api', 'lib', 'catalogue.json'), 'utf8'))

const fileOf = (src) => String(src || '').replace('/property-images/', '')

// 1. Every listing resolves to an image that is actually on disk. A 404 here
// renders as a broken frame on the marketplace, which no build step catches.
const resolved = catalogue.map((p) => ({ p, r: propertyImage(p) }))
const missing = resolved.filter(({ r }) => !existsSync(join(IMAGE_DIR, fileOf(r.src))))
ok('every catalogue listing resolves to an image file that exists',
  catalogue.length > 0 && missing.length === 0,
  missing.map(({ p, r }) => p.assetId + ' -> ' + r.src).join(', '))

// 2. Distinct listings get distinct pictures. Nine cards showing the same
// three buildings reads as placeholder art, not as a catalogue.
const counts = new Map()
for (const { r } of resolved) counts.set(fileOf(r.src), (counts.get(fileOf(r.src)) || 0) + 1)
const shared = [...counts].filter(([, n]) => n > 1)
ok('no two catalogue listings share the same image',
  shared.length === 0,
  shared.map(([f, n]) => f + ' used ' + n + ' times').join(', '))

// 3. The specific failure that shipped: vacant land shown as a warehouse.
// Asserted positively, on the filename, rather than as "not a warehouse".
// A negative check here passes by accident whenever the pool happens to pick
// something else, which is exactly how the original bug survived.
const landLike = (t) => /LAND|PLOT|SITE/.test(String(t).toUpperCase())
const looksLikeLand = (f) => /plot|land/i.test(f)
const builtLike = /warehouse|office|tower|retail|residences|houses|villas|plaza|apartment|chain/i
for (const { p, r } of resolved.filter(({ p }) => landLike(p.propertyType))) {
  ok(`vacant land is shown as vacant land: ${p.assetId}`,
    looksLikeLand(fileOf(r.src)) && !builtLike.test(fileOf(r.src)),
    p.propertyType + ' -> ' + r.src)
}

// 4. And the same rule for a listing type invented at runtime, which is where
// the keyword pool is still in charge.
const runtimeLand = propertyImage({ assetId: 'PROP-RUNTIME-LAND-1', propertyType: 'Land' })
ok('a runtime land listing falls back to land, not to a warehouse',
  looksLikeLand(fileOf(runtimeLand.src)) && !builtLike.test(fileOf(runtimeLand.src)),
  runtimeLand.src)

const runtimeOffice = propertyImage({ assetId: 'PROP-RUNTIME-OFFICE-1', propertyType: 'Office' })
ok('a runtime office listing falls back to an office',
  /office/i.test(fileOf(runtimeOffice.src)), runtimeOffice.src)

// 5. The honesty rule. A generic image must be labelled; a real photograph
// supplied by the owner must not be, because it is the building.
ok('every generic image is marked representative, so the UI labels it',
  resolved.every(({ r }) => r.isRepresentative === true),
  resolved.filter(({ r }) => !r.isRepresentative).map(({ p }) => p.assetId).join(', '))

const withOwnPhoto = propertyImage({
  assetId: 'PROP-GREEN-VALLEY-PUNE-001',
  propertyType: 'Residential',
  imageUrl: 'https://example.invalid/the-actual-building.jpg',
})
ok("a listing's own photograph wins over the pinned image",
  withOwnPhoto.src === 'https://example.invalid/the-actual-building.jpg',
  withOwnPhoto.src)
ok("a listing's own photograph is not labelled representative",
  withOwnPhoto.isRepresentative === false, String(withOwnPhoto.isRepresentative))

ok('the representative label says the building shown is not the building sold',
  /not a photograph of this building/i.test(REPRESENTATIVE_NOTE), REPRESENTATIVE_NOTE)

// 6. The picture has to stay put between renders, or the page looks broken.
const twice = [propertyImage(catalogue[0]), propertyImage(catalogue[0])]
ok('the same listing resolves to the same image every time',
  twice[0].src === twice[1].src, twice.map((t) => t.src).join(' vs '))

// 7. Nothing renders without a picture at all.
ok('an unknown property type still gets an image rather than an empty frame',
  !!propertyImage({ assetId: 'PROP-RUNTIME-ODD-1', propertyType: 'Houseboat' }).src)
ok('a missing property is handled rather than throwing',
  propertyImage(null).src === null)

console.log('\n  ' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
