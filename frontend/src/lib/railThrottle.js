// A shared brake on rail traffic, so a throttled rail is not hammered harder.
//
// The deployed rail sits behind a host that rate-limits inbound traffic per
// service, and answers a plain-text "Too Many Requests" when it has had
// enough. Nothing in this app used to notice. Two panels polled every ten
// seconds regardless, the settlement page fanned out to two dozen endpoints
// on every load, and the error it showed told the visitor to refresh, which
// sent another two dozen. A 429 that provokes retries is self-sustaining:
// that is why the page only recovered when the service was restarted, and why
// it came back soon after.
//
// This module is the one place that knows the rail is currently refusing. A
// 429 opens the brake for a while; background polling checks it and stays
// quiet; a success closes it. The wait honours Retry-After when the host
// sends one, and otherwise backs off geometrically so a long outage costs a
// handful of requests rather than six a minute.

const FIRST_WAIT_MS = 30000
const MAX_WAIT_MS = 300000

let openUntil = 0
let consecutive = 0
const listeners = new Set()

const announce = () => { for (const fn of listeners) { try { fn() } catch { /* a bad listener is not the rail's problem */ } } }

// Retry-After is either seconds or an HTTP date. Anything unparseable, or a
// wait longer than the cap, falls back to our own backoff rather than letting
// an upstream park the UI for an hour.
function retryAfterMs(header) {
  if (!header) return 0
  const secs = Number(header)
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_WAIT_MS)
  const when = Date.parse(header)
  if (!Number.isNaN(when)) {
    const delta = when - Date.now()
    if (delta > 0) return Math.min(delta, MAX_WAIT_MS)
  }
  return 0
}

// Record how the rail answered. Called for every rail response, including the
// ones the proxy wraps: a 429 from the host arrives as a 502-ish envelope
// carrying upstreamStatus 429, so the caller passes that through too.
export function noteRailResponse({ status, upstreamStatus, retryAfter } = {}) {
  const throttled = status === 429 || upstreamStatus === 429
  if (!throttled) {
    if (consecutive || openUntil) { consecutive = 0; openUntil = 0; announce() }
    return
  }
  consecutive += 1
  const backoff = Math.min(FIRST_WAIT_MS * (2 ** (consecutive - 1)), MAX_WAIT_MS)
  const wait = retryAfterMs(retryAfter) || backoff
  const until = Date.now() + wait
  if (until > openUntil) { openUntil = until; announce() }
}

export const isRailThrottled = () => Date.now() < openUntil

export const railRetryInMs = () => Math.max(0, openUntil - Date.now())

export const railRetryInSeconds = () => Math.ceil(railRetryInMs() / 1000)

// A person pressing a button is allowed through: the brake exists to stop
// unattended polling, not to refuse someone who is waiting on an answer.
export function clearRailThrottle() {
  if (openUntil || consecutive) { openUntil = 0; consecutive = 0; announce() }
}

export function onRailThrottleChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Exported for tests, which must not depend on wall-clock backoff state left
// behind by a previous case.
export function resetRailThrottleForTests() { openUntil = 0; consecutive = 0; listeners.clear() }
