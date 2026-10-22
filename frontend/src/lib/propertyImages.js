/**
 * Pictures for listings that do not have one of their own.
 *
 * A page of property cards with no photographs looks unfinished, and the
 * drawn placeholder that was here before looked deliberate but empty. So
 * there is now a small set of architectural images in `public/property-images`.
 *
 * Three decisions behind this file, in order of importance.
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
 * **They were generated, not scraped.** Image search returned thumbnails from
 * architecture publications: copyrighted work, at 320 pixels, into a public
 * repository. These were generated instead, so the licence position is clean
 * and the resolution is usable. Replace them with real photography of the
 * actual properties whenever that exists: nothing else needs to change.
 */

const IMAGES = [
  { file: 'residential-tower.jpg', kinds: ['APARTMENT', 'RESIDENTIAL', 'FLAT', 'TOWER'] },
  { file: 'low-rise-residences.jpg', kinds: ['APARTMENT', 'RESIDENTIAL', 'PLOT'] },
  { file: 'row-houses.jpg', kinds: ['VILLA', 'HOUSE', 'ROWHOUSE', 'BUNGALOW', 'RESIDENTIAL'] },
  { file: 'commercial-office.jpg', kinds: ['OFFICE', 'COMMERCIAL', 'IT_PARK'] },
  { file: 'retail-high-street.jpg', kinds: ['RETAIL', 'SHOP', 'COMMERCIAL', 'MIXED_USE'] },
  { file: 'warehouse-logistics.jpg', kinds: ['WAREHOUSE', 'INDUSTRIAL', 'LOGISTICS', 'LAND'] },
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

  const kind = String(p.propertyType || '').toUpperCase().replace(/[\s-]/g, '_')
  const matching = IMAGES.filter((img) => img.kinds.includes(kind))
  const pool = matching.length ? matching : IMAGES
  const pick = pool[seedOf(p.assetId || p.title || '') % pool.length]
  return { src: BASE + pick.file, isRepresentative: true }
}

export const REPRESENTATIVE_NOTE =
  'A representative image, not a photograph of this building. Where an owner has supplied a real photograph, it is shown instead and this label disappears.'
