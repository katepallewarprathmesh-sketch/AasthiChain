// Who the caller is, and what every response says about itself.
//
// TWO THINGS LIVE HERE, because they are the same question seen twice: what
// does this process believe about a request that reached it through someone
// else's network?
//
// ---------------------------------------------------------------------------
// 1. The client address
// ---------------------------------------------------------------------------
// The rate limiter on the assistant keyed anonymous callers like this:
//
//   `ip:${req.headers['x-forwarded-for'] ...}`
//
// X-Forwarded-For is a request header. Anyone can send it, and send a
// different one every time:
//
//   curl -H 'X-Forwarded-For: 1.2.3.4' ...   then 1.2.3.5, then 1.2.3.6
//
// Each request looks like a new visitor, so the limit of a handful of
// questions per window becomes no limit at all, and every question past it is
// a paid Groq call. A limiter keyed on something the caller controls is not a
// limiter; it is a formality.
//
// The fix is not to distrust the header, which would break the moment a real
// proxy is in front. It is to say *which* proxy is trusted, and to read only
// the header that proxy is known to set and to overwrite:
//
//   TRUSTED_PROXY=vercel      x-vercel-forwarded-for, then x-real-ip
//   TRUSTED_PROXY=cloudflare  cf-connecting-ip
//   TRUSTED_PROXY=none        the socket, and nothing else
//
// Those two headers are different from X-Forwarded-For in the way that
// matters: the edge sets them from the connection it terminated and replaces
// whatever the client sent. X-Forwarded-For is appended to, so a value the
// client invented is still in there.
//
// When the configured proxy's header is absent the address falls back to the
// socket. It never falls back to a header the caller could have written,
// because a fallback that can be triggered by the caller is just the original
// hole with extra steps.
//
// ---------------------------------------------------------------------------
// 2. Response headers
// ---------------------------------------------------------------------------
// Everything below is sent by this origin rather than configured at an edge,
// on purpose. An origin that depends on a CDN for its security headers loses
// them the moment someone reaches it directly, and the deployment URL of any
// Vercel or Render service is always directly reachable.

const PROXIES = {
  // header order matters: the first one present wins
  vercel: ['x-vercel-forwarded-for', 'x-real-ip'],
  cloudflare: ['cf-connecting-ip', 'true-client-ip'],
  none: [],
};

export function trustedProxy() {
  const v = String(process.env.TRUSTED_PROXY || '').trim().toLowerCase();
  if (v in PROXIES) return v;
  // Default by where we are. Vercel sets VERCEL=1 in every runtime, and its
  // edge always overwrites x-vercel-forwarded-for, so trusting it there is a
  // fact about the platform rather than a guess. Anywhere else, trust nothing.
  return process.env.VERCEL ? 'vercel' : 'none';
}

/**
 * The caller's address, as far as this process can honestly tell.
 * Returns null when it cannot tell, which callers must handle as "unknown"
 * rather than as a shared bucket everyone falls into.
 */
export function clientIp(req) {
  const headers = (req && req.headers) || {};
  for (const name of PROXIES[trustedProxy()]) {
    const raw = headers[name];
    if (!raw) continue;
    // Even a trusted header can carry a list; the left-most entry is the
    // client as the edge saw it.
    const first = String(raw).split(',')[0].trim();
    if (first) return first;
  }
  const sock = (req && (req.socket || req.connection)) || null;
  const addr = sock && sock.remoteAddress;
  if (!addr) return null;
  // ::ffff:203.0.113.4 and 203.0.113.4 are the same visitor.
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/**
 * A rate-limit bucket for a caller.
 *
 * Anonymous callers whose address cannot be established share one bucket on
 * purpose. That is deliberately strict: it means an unidentifiable flood is
 * throttled as a single caller rather than waved through as thousands. The
 * alternative, a unique bucket per unknown, is exactly the defect this file
 * exists to remove.
 */
export function rateLimitKey(req, identityId) {
  if (identityId && identityId !== 'ANONYMOUS_USER') return `id:${identityId}`;
  const ip = clientIp(req);
  return ip ? `ip:${ip}` : 'ip:unknown';
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

// Content-Security-Policy is reported, not enforced, and that is a considered
// choice rather than an unfinished one. This application sets element styles
// inline throughout, and loads Clerk and the settlement rail from other
// origins; an enforced policy written without measuring would break the site
// for real visitors in ways no build step here would catch. Report-only puts
// every violation in the browser console and at any report endpoint, which is
// how you learn the true list before turning it on. The one directive that is
// safe to assert today is frame-ancestors, and it is enforced separately
// below through X-Frame-Options.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com",
  "connect-src 'self' https: wss:",
].join('; ');

export const SECURITY_HEADERS = {
  // Downgrade protection. Two years, subdomains included, which is the value
  // a preload list requires and the only value worth sending.
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  // Stop the browser guessing a type we did not send. This is what turns an
  // uploaded file served as text into a script.
  'X-Content-Type-Options': 'nosniff',
  // Nothing here should ever be framed: a page that can be framed can be
  // clickjacked, and this one has buttons that move money.
  'X-Frame-Options': 'DENY',
  // Do not leak the path someone was on, including any identifier in it, to
  // another origin.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Hardware this application has no use for, refused up front.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  // Keep this origin out of another document's agent cluster.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Content-Security-Policy-Report-Only': CSP_REPORT_ONLY,
  // Server banners name the thing an attacker should look up a CVE for.
  'X-Powered-By': '',
};

/** Apply the headers to a response, ignoring any that are already sent. */
export function applySecurityHeaders(res) {
  if (!res || typeof res.setHeader !== 'function' || res.headersSent) return res;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    try {
      if (value === '') { if (typeof res.removeHeader === 'function') res.removeHeader(name); }
      else res.setHeader(name, value);
    } catch { /* a stream that has already started is not worth crashing over */ }
  }
  return res;
}

export const __test__ = { PROXIES, CSP_REPORT_ONLY };
