// The picture beside a listing has to be the right kind of building.
//
// This suite exists because it was missing, and its first version then tested
// the wrong thing, which is worth recording.
//
// The first bug: six images were spread across nine seeded listings by a hash
// of the id, so three listings shared one warehouse photograph and vacant
// land rendered as a warehouse.
//
// The second bug, found only by looking at the deployed rail: every listing
// created through the app has NO propertyType at all. The field is absent.
// The fallback treated "no type" as "any type" and drew from the whole set,
// so "Sunshine Villa" rendered as a logistics shed and "Mahesh Society"
// rendered as bare land outside Jaipur. The first version of this suite
// passed throughout, because it only ever fed in catalogue.json records,
// which all carry a type. A fixture that is tidier than production is not a
// fixture, it is a way of not finding out.
//
// So the primary fixture here is the shape the live rail actually returns:
// a title, an id, and nothing else.
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

const { propertyImage, imageChoice, REPRESENTATIVE_NOTE } =
  await import(join(FRONTEND, 'src', 'lib', 'propertyImages.js'))
const catalogue = JSON.parse(readFileSync(join(FRONTEND, 'api', 'lib', 'catalogue.json'), 'utf8'))

const fileOf = (src) => String(src || '').replace('/property-images/', '')
const INDUSTRIAL = /warehouse|logistic|cold-chain/i
const VACANT = /plots|land/i

// The shape the deployed rail actually returns: no propertyType, no imageUrl.
// Titles taken from the live listings, plus the kinds of name a person types.
const LIVE_SHAPED = [
  { assetId: 'PROP-d984ad9e-6ebe-4fb3-867a-dad03e31a8b1', title: 'Mahesh Society' },
  { assetId: 'PROP-1e8596fe-7a93-4c25-877c-e757226f3171', title: 'Mint Scope Probe' },
  { assetId: 'PROP-129270ce-d109-4313-aba2-8de03f14465a', title: 'Sunshine Villa' },
  { assetId: 'PROP-a1d23e7b-290f-442e-9820-8d3fadabc884', title: 'Shanti Residency' },
  { assetId: 'PROP-bd5be28a-34df-490c-9c75-311d572e2595', title: 'Lake View Heights' },
  { assetId: 'PROP-11111111-0000-0000-0000-000000000001', title: 'Flat 302, Kothrud' },
  { assetId: 'PROP-22222222-0000-0000-0000-000000000002', title: '' },
  { assetId: 'PROP-33333333-0000-0000-0000-000000000003', title: 'Untitled' },
]

// 1. THE RULE THAT WAS MISSING. A record that does not say it is industrial
// or vacant must never be shown as either. This is the check that would have
// caught what shipped.
for (const p of LIVE_SHAPED) {
  const f = fileOf(propertyImage(p).src)
  ok(`a listing with no type is not shown as a shed or a field: ${p.title || '(no title)'}`,
    !INDUSTRIAL.test(f) && !VACANT.test(f), f)
}

// 2. The name is used when the type is absent, because it is all there is.
const byName = [
  ['Sunshine Villa', /row-houses/],
  ['Mahesh Society', /low-rise-residences/],
  ['Lake View Heights', /residential-tower/],
  ['Nirman Business Plaza', /commercial-office/],
  ['Ganesh Retail Arcade', /retail-high-street/],
]
for (const [title, want] of byName) {
  const c = imageChoice({ assetId: 'PROP-NAME-TEST', title })
  ok(`"${title}" is read as what it says it is`,
    want.test(c.file) && c.basis === 'name', c.file + ' (' + c.basis + ')')
}

// 3. Industrial and vacant are still reachable, but only on an explicit word.
// A rule that can never fire is not a rule, it is dead code.
ok('an explicitly industrial listing still gets an industrial image',
  INDUSTRIAL.test(imageChoice({ assetId: 'X', propertyType: 'Industrial' }).file),
  imageChoice({ assetId: 'X', propertyType: 'Industrial' }).file)
ok('an explicitly vacant plot still gets vacant land',
  VACANT.test(imageChoice({ assetId: 'X', propertyType: 'Land' }).file),
  imageChoice({ assetId: 'X', propertyType: 'Land' }).file)
ok('a warehouse named in the title is recognised without a type',
  INDUSTRIAL.test(imageChoice({ assetId: 'X', title: 'Bhiwandi Warehouse Unit 3' }).file))
ok('plots named in the title are recognised without a type',
  VACANT.test(imageChoice({ assetId: 'X', title: 'NA Plots at Wagholi' }).file))

// 4. A declared type outranks the name, because it is the stronger claim.
const conflicting = imageChoice({ assetId: 'X', propertyType: 'Land', title: 'Sunshine Villa' })
ok('a declared type beats a name that disagrees with it',
  VACANT.test(conflicting.file) && conflicting.basis === 'type',
  conflicting.file + ' (' + conflicting.basis + ')')

// 5. The seeded catalogue: one image each, all present on disk.
const resolved = catalogue.map((p) => ({ p, r: propertyImage(p) }))
const missing = resolved.filter(({ r }) => !existsSync(join(IMAGE_DIR, fileOf(r.src))))
ok('every catalogue listing resolves to an image file that exists',
  catalogue.length > 0 && missing.length === 0,
  missing.map(({ p, r }) => p.assetId + ' -> ' + r.src).join(', '))

const counts = new Map()
for (const { r } of resolved) counts.set(fileOf(r.src), (counts.get(fileOf(r.src)) || 0) + 1)
const shared = [...counts].filter(([, n]) => n > 1)
ok('no two catalogue listings share the same image',
  shared.length === 0, shared.map(([f, n]) => f + ' used ' + n + ' times').join(', '))

ok('vacant land in the catalogue is shown as vacant land',
  VACANT.test(fileOf(propertyImage(catalogue.find((p) => /PLOTS/.test(p.assetId))).src)))

// 6. Every fallback file the resolver can emit actually exists. A rule that
// points at a missing file renders as a broken frame.
const everyFile = new Set()
for (const p of [...LIVE_SHAPED, ...catalogue]) everyFile.add(fileOf(propertyImage(p).src))
for (const t of ['Land', 'Industrial', 'Retail', 'Office', 'Villa', 'Tower', 'Apartment', 'Houseboat'])
  everyFile.add(imageChoice({ assetId: 'PROP-T-' + t, propertyType: t }).file)
const absent = [...everyFile].filter((f) => !existsSync(join(IMAGE_DIR, f)))
ok('every image the resolver can choose is on disk', absent.length === 0, absent.join(', '))

// 7. The honesty rule. A generic image must be labelled; a real photograph
// supplied by the owner must not be, because it is the building.
ok('every generic image is marked representative, so the UI labels it',
  [...LIVE_SHAPED, ...catalogue].every((p) => propertyImage(p).isRepresentative === true))

const withOwnPhoto = propertyImage({
  assetId: 'PROP-GREEN-VALLEY-PUNE-001',
  title: 'Green Valley Villas - Pune',
  imageUrl: 'https://example.invalid/the-actual-building.jpg',
})
ok("a listing's own photograph wins over the pinned image",
  withOwnPhoto.src === 'https://example.invalid/the-actual-building.jpg', withOwnPhoto.src)
ok("a listing's own photograph is not labelled representative",
  withOwnPhoto.isRepresentative === false, String(withOwnPhoto.isRepresentative))
ok('the representative label says the building shown is not the building sold',
  /not a photograph of this building/i.test(REPRESENTATIVE_NOTE))

// 8. Stability and safety.
ok('the same listing resolves to the same image every time',
  propertyImage(LIVE_SHAPED[0]).src === propertyImage(LIVE_SHAPED[0]).src)
ok('an unrecognised name still gets an image rather than an empty frame',
  !!propertyImage({ assetId: 'PROP-ODD', title: 'Houseboat' }).src)
ok('a missing property is handled rather than throwing',
  propertyImage(null).src === null)

console.log('\n  ' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
