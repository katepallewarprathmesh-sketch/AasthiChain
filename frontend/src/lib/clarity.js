// Microsoft Clarity, front end only.
//
// Scope, deliberately narrow:
//   - this file is imported by src/main.jsx and by nothing else
//   - it touches no API, so the Render rail is unaware Clarity exists
//   - it is inert unless VITE_CLARITY_PROJECT_ID is set at build time, so
//     local development, CI and the prerender pass never load the script
//
// What is kept out of recordings. Clarity replays the DOM, so anything
// rendered as text is captured unless it is masked. Its dashboard-level
// setting ("Balanced" by default) masks form field values but NOT text, and
// on this product the text is the sensitive part: balances, token counts,
// settlement amounts, wallet identifiers, document hashes and public keys
// are all rendered as ordinary text. maskSensitive() below tags those nodes
// with data-clarity-mask, which Clarity honours by replacing their content
// with placeholder characters before anything leaves the browser.

import Clarity from '@microsoft/clarity'

const PROJECT_ID = import.meta.env.VITE_CLARITY_PROJECT_ID

// Every selector here renders either money, a holding, an identifier or a
// credential. If a new screen introduces another class of sensitive text,
// add it here rather than relying on the dashboard setting.
const SENSITIVE = [
  // Figures: balances, valuations, token counts, settlement amounts.
  '.ax-num',
  '.pg-money',
  '[data-sensitive]',

  // Identifiers and credentials: hashes, public keys, transaction ids,
  // wallet addresses, VPAs. Monospace is how this codebase renders all of
  // them, which makes it a reliable handle.
  '.ax-mono',
  '.pg-mono',
  '.hash-display',
  '.hash-truncated',

  // Definition lists are the key/value readout used for account and
  // settlement detail.
  '.pg-kv dd',

  // Anything a person types. Clarity masks field values by default; this
  // makes that explicit and survives a dashboard setting being relaxed.
  'input',
  'textarea',
  'select',
]

function maskSensitive(root = document) {
  try {
    for (const el of root.querySelectorAll(SENSITIVE.join(','))) {
      if (!el.hasAttribute('data-clarity-mask')) el.setAttribute('data-clarity-mask', 'true')
    }
  } catch {
    // A selector engine failure must never take the app down with it.
  }
}

// The app is a single-page application: most of what Clarity will ever see
// is rendered long after init. A debounced observer re-tags new nodes as
// routes and panels mount.
function watchForNewNodes() {
  if (typeof MutationObserver === 'undefined') return
  let queued = false
  const observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    const run = () => { queued = false; maskSensitive() }
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 1000 })
    else setTimeout(run, 300)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

export function initClarity() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (!PROJECT_ID) return false

  // Never record a developer's own session, and never record the preview
  // deployments: the project id is a production id and mixing environments
  // makes the heatmaps meaningless.
  const host = window.location.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false

  // Honour the browser's own signal. Clarity is analytics, not function.
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return false

  try {
    // Mask before the script loads, so the first snapshot is already clean.
    maskSensitive()
    Clarity.init(PROJECT_ID)
    watchForNewNodes()
    return true
  } catch {
    // Analytics failing is not a reason for the page to fail.
    return false
  }
}

export default initClarity
