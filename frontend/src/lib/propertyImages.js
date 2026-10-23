/**
 * Pictures for listings that do not have one of their own.
 *
 * A page of property cards with no photographs looks unfinished, and the
 * drawn placeholder that was here before looked deliberate but empty. So
 * there is now a set of architectural images in `public/property-images`.
 *
 * Four decisions behind this file, in order of importance.
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
 * **Each demo listing has its own picture.** The first version of this file
 * had six images and a seeded pick over a type pool, which went wrong in two
 * ways at once. Three of the nine demo listings landed on the same warehouse,
 * and the pool keywords were loose enough that `LAND` resolved to that
 * warehouse and an office block resolved to a retail street. A named listing
 * beside a picture of the wrong kind of building reads as carelessness about
 * the record itself. `BY_ASSET` now pins one image per demo listing, matched
 * to its type and its city, and the type pool below is only a fallback for
 * listings created at runtime.
 *
 * **They were generated, not scraped.** Image search returned thumbnails from
 * architecture publications: copyrighted work, at low resolution, into a
 * public repository. These were generated instead, so the licence position is
 * clean. A real photograph of a real identifiable building would also be the
 * more misleading choice here, because these demo listings are invented:
 * attaching a genuine Pune building to a listing called "Green Valley Villas"
 * asserts something false about a real address. Replace any of them with real
 * photography of the actual property whenever that exists, by setting
 * `imageUrl` on the record: nothing else needs to change.
 */

// One image per demo listing. Keyed by the ledger id, because the title can
// be edited and the id cannot.
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

// The fallback pool, for listings this file has never heard of. Keywords are
// deliberately narrow now: an entry claims a kind only if the picture would
// actually pass for it. Vacant land gets vacant land, not a warehouse.
const IMAGES = [
  { file: 'residential-tower.jpg', kinds: ['APARTMENT', 'FLAT', 'TOWER', 'RESIDENTIAL'] },
  { file: 'low-rise-residences.jpg', kinds: ['APARTMENT', 'RESIDENTIAL'] },
  { file: 'row-houses.jpg', kinds: ['VILLA', 'HOUSE', 'ROWHOUSE', 'BUNGALOW', 'RESIDENTIAL'] },
  { file: 'commercial-office.jpg', kinds: ['OFFICE', 'COMMERCIAL', 'IT_PARK'] },
  { file: 'retail-high-street.jpg', kinds: ['RETAIL', 'SHOP', 'MIXED_USE'] },
  { file: 'warehouse-logistics.jpg', kinds: ['WAREHOUSE', 'INDUSTRIAL', 'LOGISTICS', 'FACTORY'] },
  { file: 'aravali-plots-jaipur.jpg', kinds: ['LAND', 'PLOT', 'PLOTS', 'SITE'] },
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

/**
 * The image to show for a property.
 * Returns { src, isRepresentative }. `isRepresentative` true means the caller
 * must label it.
 */
export function propertyImage(p) {
  if (!p) return { src: null, isRepresentative: false }
  if (p.imageUrl) return { src: p.imageUrl, isRepresentative: false }

  const pinned = BY_ASSET[p.assetId]
  if (pinned) return { src: BASE + pinned, isRepresentative: true }

  const kind = String(p.propertyType || '').toUpperCase().replace(/[\s-]/g, '_')
  const matching = IMAGES.filter((img) => img.kinds.includes(kind))
  const pool = matching.length ? matching : IMAGES
  const pick = pool[seedOf(p.assetId || p.title || '') % pool.length]
  return { src: BASE + pick.file, isRepresentative: true }
}

export const REPRESENTATIVE_NOTE =
  'A representative image, not a photograph of this building. Where an owner has supplied a real photograph, it is shown instead and this label disappears.'
