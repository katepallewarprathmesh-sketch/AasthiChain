/**
 * Detects that a newer build has been deployed, and reloads the tab.
 *
 * WHY THIS EXISTS. A bug was fixed and deployed, yet the same broken screen
 * kept being reported. The deployed chunk provably did not contain the old
 * code, so the tab was running an older bundle — and it had no way to notice.
 *
 * Vercel serves hashed assets as immutable and keeps old ones: every previous
 * `index-<hash>.js` still returns HTTP 200. A tab opened before a deploy
 * therefore never gets a 404, never errors, and never reloads. It keeps
 * running the old code for as long as it stays open, showing bugs that were
 * fixed days ago. Retry buttons re-run the old code and fail identically,
 * which is exactly how a fixed problem looks unfixed.
 *
 * index.html is served `max-age=0, must-revalidate`, so it is always current.
 * Comparing the entry filename it references against the one actually running
 * is a reliable, dependency-free way to spot a new deploy.
 */

const RELOAD_GUARD = 'aasthi_build_reloaded';

/** Filename of the entry bundle this tab is running, e.g. "index-abc123.js". */
function runningBundle() {
  try {
    const el = document.querySelector('script[type="module"][src*="/assets/index-"]');
    if (!el) return null;
    return new URL(el.src, window.location.origin).pathname.split('/').pop();
  } catch {
    return null;
  }
}

/** Filename of the entry bundle the server currently serves. */
async function deployedBundle() {
  const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  return m ? m[1] : null;
}

/**
 * Reloads once if a newer build is live.
 *
 * The sessionStorage guard means a misconfigured deploy cannot put the tab in
 * a reload loop: after one attempt this tab will not try again.
 */
export async function reloadIfStale() {
  const running = runningBundle();
  if (!running) return false;              // dev server, or markup we do not recognise

  let deployed = null;
  try {
    deployed = await deployedBundle();
  } catch {
    return false;                          // offline: nothing to do, stay put
  }
  if (!deployed || deployed === running) return false;

  try {
    if (sessionStorage.getItem(RELOAD_GUARD) === deployed) return false;
    sessionStorage.setItem(RELOAD_GUARD, deployed);
  } catch { /* storage unavailable: still worth reloading once */ }

  window.location.reload();
  return true;
}

/**
 * Checks on a timer and whenever the tab regains focus — the moment a user
 * comes back to a tab left open across a deploy, which is precisely when the
 * stale copy would otherwise be used.
 */
export function startBuildWatcher({ intervalMs = 120000 } = {}) {
  if (typeof window === 'undefined') return () => {};

  const check = () => { reloadIfStale().catch(() => {}); };
  const onVisible = () => { if (document.visibilityState === 'visible') check(); };

  const timer = setInterval(check, intervalMs);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', onVisible);
  check();   // and once at startup, which fixes an already-stale tab on reload

  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', check);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
