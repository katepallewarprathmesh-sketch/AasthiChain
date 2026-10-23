/**
 * Pictures for listings that do not have one of their own.
 *
 * A page of property cards with no photographs looks unfinished, and the
 * drawn placeholder that was here before looked deliberate but empty. So
 * there is now a set of architectural images in `public/property-images`.
 *
 * The rules, in order of importance.
 *
 * **They are labelled, always.** These are generic images, not photographs of
 * the listed buildings. A stock photograph presented silently beside a real
 * valuation implies the building shown is the building sold, which is the one
 * thing this project must not do. Every surface that renders a fallback also
 * renders the word "Representative", and `isRepresentative` below is what
 * tells it to.
 *
 * **A listing's own photograph always wins.** If the record carries an
 * `imageUrl`, that is used and no label appears, because it is the real
 * thing.
 *
 * **A warehouse or a vacant plot is never a guess.** This is the rule that
 * was missing, and it is the one that matters. Listings created through the
 * app carry no `propertyType` at all: the field is simply absent on every
 * record the live rail returns. The old fallback treated "no type" as "any
 * type" and picked from the whole set, so "Sunshine Villa" rendered as a
 * logistics shed and "Mahesh Society" rendered as bare land outside Jaipur.
 *
 * Those two categories now require the record to say so explicitly, in its
 * type or in its name. Everything else resolves to a building, because a
 * building is what is almost always being sold here, and because the cost of
 * the two mistakes is not symmetric: a flat shown as a generic apartment
 * block is a dull picture, while a flat shown as an empty field looks like
 * the platform does not know what it has listed.
 *
 * **The name is used when the type is missing.** It is the only description
 * such a record has. "Villa" means houses, "Society" means apartments,
 * "Plaza" means commercial. This is a guess and it is labelled as one, but it
 * is a far better guess than a hash of the id.
 *
 * **Each demo listing has its own picture,** pinned by ledger id in
 * `BY_ASSET`, so the nine seeded listings never share or swap images.
 *
 * **They were generated, not scraped.** Image search returned thumbnails from
 * architecture publications: copyrighted work, at low resolution, into a
 * public repository. These were generated instead, so the licence position is
 * clean. Replace any of them with real photography of the actual property by
 * setting `imageUrl` on the record: nothing else needs to change.
 */

// One image per seeded demo listing. Keyed by the ledger id, because the
// title can be edited and the id cannot.
const BY_ASSET = {
  'PROP-GREEN-VALLEY-PUNE-001': 'green-valley-villas-pune.jpg',
  'PROP-MARINE-HEIGHTS-MUM-002': 'marine-heights-mumbai.jpg',
  'PROP-CYBER-TOWERS-BLR-003': 'cyber-towers-bengaluru.jpg',
  'PROP-SALTLAKE-RETAIL-KOL-004': 'saltlake-retail-kolkata.jpg',
  'PROP-LOGIPARK-WH-CHN-005': 'logipark-warehouse-chennai.jpg',
  'PROP-ARAVALI-PLOTS-JAI-006': 'aravali-plots-jaipur.jpg',
  'PROP-HITEC-SERVICED-HYD-007': 'hitec-serviced-hyderabad.jpg',
  'PROP-RIVERFRONT-COMM-AHM-008': 'riverfront-plaza-ahmedabad.jpg',
  'PROP-COLD-CHAIN-NSK-009': 'cold-chain-nashik.jpg',
}

const HOUSES = 'row-houses.jpg'
const APARTMENTS = 'low-rise-residences.jpg'
const TOWER = 'residential-tower.jpg'
const OFFICE = 'commercial-office.jpg'
const RETAIL = 'retail-high-street.jpg'
const WAREHOUSE = 'warehouse-logistics.jpg'
const LAND = 'aravali-plots-jaipur.jpg'

// Buildings only. Nothing here can make a home look like a shed or a field,
// which is the point: this is the pool an unrecognised listing draws from.
const BUILDINGS = [APARTMENTS, TOWER, HOUSES, OFFICE]

// Read as an ordered list: the first pattern that matches a record's type or
// its name decides. Warehouse and land sit at the top because they are the
// two that must never be reached by accident, so they are only ever reached
// by an explicit word.
const RULES = [
  { re: /\b(WAREHOUSE|GODOWN|LOGISTIC|INDUSTRIAL|FACTORY|COLD[\s_-]?CHAIN|COLD[\s_-]?STORAGE|MANUFACTUR)/, file: WAREHOUSE },
  { re: /\b(LAND|PLOT|PLOTS|SITE|ACRE|HECTARE|FARM|AGRICULT)/, file: LAND },
  { re: /\b(RETAIL|SHOP|MALL|ARCADE|BAZAAR|MARKET|SHOWROOM|HIGH[\s_-]?STREET|MIXED[\s_-]?USE)/, file: RETAIL },
  { re: /\b(OFFICE|IT[\s_-]?PARK|TECH|CYBER|CORPORATE|BUSINESS|COMMERCIAL|PLAZA|WORKSPACE)/, file: OFFICE },
  { re: /\b(VILLA|BUNGALOW|ROW[\s_-]?HOUSE|ROWHOUSE|KOTHI|COTTAGE|HOUSE|DUPLEX)/, file: HOUSES },
  { re: /\b(TOWER|HEIGHT|HEIGHTS|HIGH[\s_-]?RISE|SKY|PENTHOUSE)/, file: TOWER },
  { re: /\b(APARTMENT|FLAT|RESIDENC|RESIDENTIAL|SOCIETY|ENCLAVE|NAGAR|VIHAR|COLONY|GARDEN|PARK|HOMES|GREENS|VALLEY)/, file: APARTMENTS },
]

const BASE = '/property-images/'

// A stable number from the id, so a listing keeps the same picture between
// visits and between machines. Shuffling the image on every render would make
// the page feel broken.
function seedOf(s) {
  let h = 0
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) % 100003
  return h
}

function normalise(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

/**
 * Which picture a record deserves, and how that was decided. Exported so the
 * test suite can assert on the reason and not only on the filename.
 * Returns { file, basis }.
 */
export function imageChoice(p) {
  const pinned = BY_ASSET[p.assetId]
  if (pinned) return { file: pinned, basis: 'pinned' }

  // The declared type is the strongest signal, when there is one.
  const declared = normalise(p.propertyType)
  if (declared) {
    const hit = RULES.find((r) => r.re.test(declared))
    if (hit) return { file: hit.file, basis: 'type' }
  }

  // Otherwise the name is all the record has.
  const named = normalise(p.title)
  if (named) {
    const hit = RULES.find((r) => r.re.test(named))
    if (hit) return { file: hit.file, basis: 'name' }
  }

  // Nothing recognisable. Pick a building, never a shed and never a field.
  return { file: BUILDINGS[seedOf(p.assetId || p.title || '') % BUILDINGS.length], basis: 'default' }
}

/**
 * The image to show for a property.
 * Returns { src, isRepresentative }. `isRepresentative` true means the caller
 * must label it.
 */
export function propertyImage(p) {
  if (!p) return { src: null, isRepresentative: false }
  if (p.imageUrl) return { src: p.imageUrl, isRepresentative: false }
  return { src: BASE + imageChoice(p).file, isRepresentative: true }
}

export const REPRESENTATIVE_NOTE =
  'A representative image, not a photograph of this building. Where an owner has supplied a real photograph, it is shown instead and this label disappears.'
