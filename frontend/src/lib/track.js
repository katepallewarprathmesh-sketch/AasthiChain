// First-party pageview beacon.
//
// Posts to our own /api/track and nowhere else. No third-party script, no
// cookie, no fingerprinting, no IP stored server-side.
//
// The visitor id is a random value held in sessionStorage: it dies when the
// tab closes and cannot follow anyone to another site. The server hashes it
// with a daily-rotating salt before storing, so it is not linkable across days.
//
// Everything here is best-effort and silent. Analytics must never be able to
// slow down, break, or throw inside the app.

const KEY = 'aasthi_vid';

function visitorId() {
  try {
    let v = sessionStorage.getItem(KEY);
    if (!v) {
      v = (crypto.randomUUID && crypto.randomUUID()) ||
          Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(KEY, v);
    }
    return v;
  } catch {
    return 'anon'; // private mode / storage blocked
  }
}

/** True when the visitor has asked not to be tracked. We respect it. */
function optedOut() {
  try {
    const dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
    return dnt === '1' || dnt === 'yes' || navigator.globalPrivacyControl === true;
  } catch { return false; }
}

let lastPath = null;

export function trackPageview(path) {
  try {
    if (typeof window === 'undefined') return;   // SSR / smoke render
    if (optedOut()) return;

    const p = path || window.location.pathname;
    if (p === lastPath) return;                  // no double counting on re-render
    lastPath = p;

    const body = JSON.stringify({
      path: p,
      referrer: document.referrer || '',
      vid: visitorId(),
    });

    // sendBeacon survives navigation away; fetch is the fallback.
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch { /* never surface */ }
}

export default trackPageview;
