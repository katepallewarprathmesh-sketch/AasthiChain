/**
 * One place that decides what a user sees when a request fails.
 *
 * The marketplace used to render `Failed to load: ERR_UNAUTHORIZED`, which is
 * the server's internal code shown verbatim on a live page. It tells the user
 * nothing and offers no way out. The underlying cause was a session that had
 * silently become invalid, and the only fix was knowing to clear localStorage.
 *
 * Rules enforced here:
 *   1. A raw error code is never shown. Every failure maps to plain language.
 *   2. Every failure names the next action, and that action actually resolves it.
 *   3. A dead session recovers itself rather than leaving the user stuck.
 */

export const SESSION_EXPIRED_EVENT = 'aasthi:session-expired';

/** Error carrying everything the UI needs to render a useful state. */
export class ApiError extends Error {
  constructor({ status, code, serverMessage, path }) {
    super(serverMessage || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || '';
    this.serverMessage = serverMessage || '';
    this.path = path || '';
  }
}

/**
 * A signed token is `<base64url payload>.<base64url hmac>` — exactly two
 * dot-separated parts. Tokens issued before signing was introduced are plain
 * base64 with no dot; a Clerk session token has three parts.
 *
 * Anything that is neither a signed token nor a Clerk JWT cannot be used by
 * this build, so it is treated as a dead session at startup rather than being
 * sent to the server to be rejected on every single request. This is what
 * makes the "stale token" case self-heal instead of showing an error forever.
 */
export function tokenLooksUsable(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length === 2) return parts.every(Boolean);   // signed by this server
  if (parts.length === 3) return parts.every(Boolean);   // Clerk JWT
  return false;
}

/**
 * Maps a failure to what the user should read and do.
 * Returns { title, detail, action, severity }.
 *   action.kind: 'login' | 'retry' | 'back' | 'none'
 */
export function describeError(err, context = {}) {
  const what = context.what || 'this page';

  // Network / offline — fetch rejects before any response exists.
  if (!err || err.name === 'TypeError' || err.status === 0 || err.offline) {
    return {
      severity: 'warning',
      title: 'Cannot reach AasthiChain',
      detail: 'Your device appears to be offline, or the server is not responding. Nothing was changed.',
      action: { kind: 'retry', label: 'Try again' },
    };
  }

  const code = (err.code || '').toUpperCase();
  const status = err.status;

  // --- session problems -------------------------------------------------
  if (status === 401) {
    if (code === 'ERR_INVALID_TOKEN' || /expired/i.test(err.serverMessage || '')) {
      return {
        severity: 'info',
        title: 'Your session has expired',
        detail: 'Sessions last one hour. Sign in again to pick up where you left off.',
        action: { kind: 'login', label: 'Sign in again' },
      };
    }
    return {
      severity: 'info',
      title: 'Please sign in to continue',
      detail: `You need to be signed in to view ${what}.`,
      action: { kind: 'login', label: 'Sign in' },
    };
  }

  // --- permission problems ----------------------------------------------
  if (status === 403) {
    if (code === 'ERR_FORBIDDEN' && /belongs to/i.test(err.serverMessage || '')) {
      // The server says which identity owns it; surface that, it is the
      // single most useful fact for resolving a role mix-up.
      return {
        severity: 'info',
        title: 'This belongs to a different account',
        detail: `${err.serverMessage} Switch roles using the selector in the header, or sign in as that account.`,
        action: { kind: 'none' },
      };
    }
    return {
      severity: 'info',
      title: 'Your role cannot view this',
      detail: `Viewing ${what} needs a different role. Use the role selector in the header to switch.`,
      action: { kind: 'none' },
    };
  }

  // --- the thing is not there -------------------------------------------
  if (status === 404) {
    return {
      severity: 'info',
      title: 'Not found',
      detail: `We could not find ${what}. It may have been removed, or the link may be out of date.`,
      action: { kind: 'back', label: 'Go back' },
    };
  }

  // --- already done ------------------------------------------------------
  if (status === 409) {
    return {
      severity: 'info',
      title: 'Already completed',
      detail: err.serverMessage || 'This action had already been carried out, so nothing was repeated.',
      action: { kind: 'none' },
    };
  }

  // --- rejected input ----------------------------------------------------
  if (status === 400 || status === 422) {
    return {
      severity: 'warning',
      title: 'That did not go through',
      detail: err.serverMessage || 'Some of the details were not accepted. Check them and try again.',
      action: { kind: 'retry', label: 'Try again' },
    };
  }

  if (status === 429) {
    return {
      severity: 'warning',
      title: 'Too many requests',
      detail: 'Please wait a few seconds and try again.',
      action: { kind: 'retry', label: 'Try again' },
    };
  }

  // --- our fault ---------------------------------------------------------
  if (status >= 500) {
    return {
      severity: 'error',
      title: 'Something went wrong on our side',
      detail: 'This is not your fault and nothing was changed. Please try again in a moment.',
      action: { kind: 'retry', label: 'Try again' },
    };
  }

  return {
    severity: 'error',
    title: 'Something went wrong',
    detail: err.serverMessage || `We could not load ${what}. Please try again.`,
    action: { kind: 'retry', label: 'Try again' },
  };
}

/** Clears the stored session. Used on 401 and on an unusable stored token. */
export function clearSession() {
  try {
    localStorage.removeItem('aasthi_user');
    localStorage.removeItem('aasthi_token');
  } catch { /* storage may be unavailable; nothing else to do */ }
}

/**
 * Silently obtains a valid signed token for the identity the user is already
 * using, without interrupting them.
 *
 * Before tokens were signed, no token simply meant "you are investor1", so the
 * demo always worked. Hardening made that a 401 -- correct for the server, but
 * it broke the demo for anyone holding a token issued earlier, and a payment
 * part-way through would fail with a raw error.
 *
 * /api/auth/login is public, so the client can always mint a proper token.
 * Doing that automatically restores the old frictionless behaviour while the
 * server keeps refusing unsigned and forged tokens.
 *
 * Returns the new token, or null if a session genuinely cannot be established.
 */
export async function ensureSession() {
  let identityId = 'investor1';
  let role = 'Investor';
  try {
    const raw = localStorage.getItem('aasthi_user');
    if (raw) {
      const u = JSON.parse(raw);
      if (u && u.identityId) identityId = u.identityId;
      if (u && u.role) role = u.role;
    }
  } catch { /* fall back to the demo investor */ }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityId, role }),
    });
    if (!res.ok) return null;
    const { token } = await res.json();
    if (!token) return null;
    localStorage.setItem('aasthi_token', token);
    try {
      const raw = localStorage.getItem('aasthi_user');
      const u = raw ? JSON.parse(raw) : {};
      localStorage.setItem('aasthi_user', JSON.stringify({ ...u, identityId, role, token }));
    } catch { /* token alone is enough to continue */ }
    return token;
  } catch {
    return null;
  }
}

/** Tells the app a session died, so it can redirect once rather than per-call. */
export function announceSessionExpired(reason) {
  clearSession();
  try {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { reason } }));
  } catch { /* non-browser context */ }
}
