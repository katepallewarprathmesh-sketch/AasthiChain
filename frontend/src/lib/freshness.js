// A tab can keep running code that was replaced days ago.
//
// Chunk filenames are content-hashed and served immutable, so a browser that
// has the old index.html will happily keep loading the old chunks with it —
// and the person sees a screen that was fixed on the server long ago, and
// reports a bug that no longer exists. A plain reload does not always clear
// it either, because the stale thing is the cached HTML.
//
// So the running bundle carries the commit it was built from, and asks the
// server what it is serving. If they disagree, the page replaces itself —
// once, guarded by a flag, because a reload loop is worse than a stale tab.

const STAMP = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev'
const RELOAD_FLAG = 'aasthi_reloaded_for_build'

export function runningBuild() {
  return STAMP
}

export async function checkFreshness({ onStale } = {}) {
  if (STAMP === 'dev') return { stale: false, reason: 'dev build' }
  let served = ''
  try {
    const res = await fetch('/api/admin/insights/status', { cache: 'no-store' })
    if (!res.ok) return { stale: false, reason: `status ${res.status}` }
    const body = await res.json()
    served = String(body.build || '').slice(0, 12)
  } catch {
    return { stale: false, reason: 'server unreachable' }
  }
  // Only a real commit is worth comparing against. A dev server reports
  // things like "local", and reloading the page because of that would be a
  // loop with no end and no fix at the end of it.
  if (!/^[0-9a-f]{7,40}$/.test(served)) return { stale: false, served, reason: 'server build is not a commit' }
  if (served === STAMP) return { stale: false, served }

  // The deployment moved on. Reload once; if that did not take, leave it to
  // the caller to tell the person, rather than reloading forever.
  let alreadyTried = false
  try { alreadyTried = sessionStorage.getItem(RELOAD_FLAG) === served } catch { /* storage unavailable */ }

  if (!alreadyTried) {
    try { sessionStorage.setItem(RELOAD_FLAG, served) } catch { /* storage unavailable */ }
    window.location.reload()
    return { stale: true, served, reloading: true }
  }

  if (typeof onStale === 'function') onStale({ running: STAMP, served })
  return { stale: true, served, reloading: false }
}
