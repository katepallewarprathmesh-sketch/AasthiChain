/**
 * Naming a property the way a person would.
 *
 * An assetId like PROP-GREEN-VALLEY-PUNE-001 is a ledger key. It has to stay
 * exactly as it is, because the pilot ISIN is derived from it, the settlement
 * record refers to it and anything already written to the chain names it. What
 * it must not be is the thing a person reads: screens that asked somebody to
 * type one, or printed one back at them, looked like a database with a web
 * page bolted on.
 *
 * So the rule across the app is: show the title and the city, keep the key
 * nearby for traceability, and never put a key in a placeholder as if it were
 * an example of what to type.
 */

import { useEffect, useState } from 'react'

/**
 * Turn a key into something readable when the catalogue has not loaded or the
 * property is not in it. PROP-GREEN-VALLEY-PUNE-001 becomes
 * "Green Valley Pune (001)". It is a fallback, not a substitute for the title.
 */
export function prettifyAssetId(id) {
  const raw = String(id || '').trim()
  if (!raw) return 'Unnamed property'
  if (!/^PROP[-_]/i.test(raw)) return raw
  const parts = raw.replace(/^PROP[-_]/i, '').split(/[-_]/).filter(Boolean)
  if (!parts.length) return raw
  // Listings created at runtime are keyed by a UUID, which prettifies into
  // nonsense words. Say it has no name instead of inventing one.
  const looksGenerated = parts.some(p => /^[0-9a-f]{4,}$/i.test(p) && /\d/.test(p) && /[a-f]/i.test(p))
  if (looksGenerated) return `Untitled listing (${parts[0].slice(0, 6)})`
  let suffix = ''
  if (/^\d+$/.test(parts[parts.length - 1])) suffix = parts.pop()
  const words = parts
    .map(p => p.toLowerCase())
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
  return suffix ? `${words} (${suffix})` : words
}

/** The title and the city, without repeating the city when the title has it. */
export function labelForProperty(pr) {
  if (!pr) return ''
  const title = String(pr.title || '').trim()
  const city = (pr.location && (pr.location.city || pr.location.state)) || ''
  if (!title) return prettifyAssetId(pr.assetId)
  const hasCity = city && title.toLowerCase().includes(String(city).toLowerCase())
  return city && !hasCity ? `${title}: ${city}` : title
}

/** The readable name for a key, given whatever catalogue is to hand. */
export function labelFor(id, properties) {
  const pr = (properties || []).find(p => p && p.assetId === id)
  return pr ? labelForProperty(pr) : prettifyAssetId(id)
}

/**
 * The key, kept visible but subordinate. Use it as a hint under a control, not
 * as the control's own text.
 */
export function assetRef(id) {
  return id ? `Ledger reference ${id}` : ''
}

/**
 * The properties the rail knows about, for pickers. Failing quietly is
 * deliberate: a picker that cannot load its list falls back to a plain field
 * rather than blocking the page.
 */
export function useAssetCatalogue() {
  const [properties, setProperties] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    fetch('/api/properties')
      .then(r => r.json())
      .then(d => {
        if (!alive) return
        const list = (Array.isArray(d) ? d : d.properties || []).filter(x => x && x.assetId)
        setProperties(list)
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [])
  return { properties, loading }
}

export default labelFor
