// Clerk JWT signature verification.
//
// Until now the API decoded the payload of any three-part JWT and trusted
// payload.sub. A token is not a credential unless its signature is checked, so
// anyone could hand-assemble a Clerk-shaped JWT and be whoever they liked.
//
// This verifies RS256 signatures against Clerk's published JWKS using Node's
// built-in crypto — no new dependency. Design notes:
//
//   * Opt-in via CLERK_ISSUER. Unset, nothing changes, because switching on
//     verification with the wrong issuer locks out every real user. Set it and
//     the API fails closed on anything it cannot verify.
//   * Key fetching is async, but decodeToken is synchronous and called from
//     three places. So keys are fetched and cached by an awaited call at the
//     top of the request handler, and verification itself is synchronous
//     against that cache.
//   * A stale cache is preferred to an outage. If Clerk is unreachable at
//     refresh time we keep using the keys we have; signing keys rotate rarely,
//     and locking every user out during someone else's incident is worse than
//     trusting a key for an extra hour.

import crypto from 'crypto';

const ISSUER = (process.env.CLERK_ISSUER || '').replace(/\/+$/, '');
export const clerkVerificationEnabled = ISSUER !== '';

// Clock skew allowance, seconds. Clerk mints short-lived tokens and a client
// whose clock is a few seconds fast should not be rejected.
const SKEW = 60;
const REFRESH_MS = 10 * 60 * 1000;

let keys = new Map();        // kid -> KeyObject
let fetchedAt = 0;
let inflight = null;
let everFetched = false;

function jwksUrl() {
  return `${ISSUER}/.well-known/jwks.json`;
}

async function fetchKeys() {
  const res = await fetch(jwksUrl(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new Error('JWKS response has no keys array');
  const next = new Map();
  for (const jwk of body.keys) {
    if (jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) continue;
    if (!jwk.kid) continue;
    try {
      next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // A malformed entry should not discard the rest of the key set.
    }
  }
  if (next.size === 0) throw new Error('JWKS contained no usable RSA signing keys');
  keys = next;
  fetchedAt = Date.now();
  everFetched = true;
}

// Awaited once per request at the top of the handler. Cheap after the first
// call: it returns immediately unless the cache is stale.
export async function ensureClerkKeys({ force = false } = {}) {
  if (!clerkVerificationEnabled) return;
  const stale = Date.now() - fetchedAt > REFRESH_MS;
  if (!force && !stale && keys.size > 0) return;
  if (inflight) { await inflight; return; }
  inflight = fetchKeys()
    .catch((err) => {
      // Keep serving with the keys we already have. Only a cold start with no
      // cache at all leaves us unable to verify, and that fails closed below.
      console.error('[clerk] JWKS refresh failed, using cached keys:', err.message);
    })
    .finally(() => { inflight = null; });
  await inflight;
}

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify a Clerk JWT. Synchronous: relies on keys primed by ensureClerkKeys.
 * Returns the payload, or null if the token is not trustworthy for any reason.
 * Never throws — callers treat null as "not signed in".
 */
export function verifyClerkJWT(token) {
  if (!clerkVerificationEnabled) return null;
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch { return null; }

  // "alg": "none" and HMAC algorithms are the classic JWT confusion attacks:
  // with HS256 an attacker signs using the public key as the HMAC secret.
  // Only RSA signatures are accepted.
  if (!header || header.alg !== 'RS256') return null;
  if (!header.kid) return null;

  const key = keys.get(header.kid);
  if (!key) return null;   // unknown kid — refreshed out of band, fail closed now

  let ok = false;
  try {
    ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      b64urlToBuf(sigB64),
    );
  } catch { return null; }
  if (!ok) return null;

  // A valid signature from the right issuer is still not enough: an expired
  // token, or one minted by a different Clerk instance, must be rejected.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now > payload.exp + SKEW) return null;
  if (typeof payload.nbf === 'number' && now + SKEW < payload.nbf) return null;
  if (payload.iss && payload.iss.replace(/\/+$/, '') !== ISSUER) return null;
  if (!payload.sub) return null;

  return payload;
}

/** True when a kid is absent from the cache, so the caller can force a refresh. */
export function hasUnknownKid(token) {
  if (!clerkVerificationEnabled || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    return Boolean(header.kid) && !keys.has(header.kid);
  } catch { return false; }
}

export const _internals = { get keyCount() { return keys.size; }, get everFetched() { return everFetched; } };
