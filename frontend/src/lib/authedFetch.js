import { ensureSession } from './apiError'

/**
 * fetch() that keeps the session alive by itself.
 *
 * Several components -- the payment flow in particular -- call fetch directly
 * rather than going through ApiClient, so they did not benefit from its
 * retry. A token issued before token signing would make a payment fail
 * part-way through with a raw error, which is the worst possible moment.
 *
 * On a 401 this mints a fresh signed token for the identity already in use
 * and replays the request once. /api/auth/login is public, so this always
 * works for a demo identity; the server still refuses unsigned and forged
 * tokens, so nothing is weakened by it.
 */
export async function authedFetch(path, options = {}, _retried = false) {
  let token = ''
  let identityId = 'investor1'
  try {
    token = localStorage.getItem('aasthi_token') || ''
    const raw = localStorage.getItem('aasthi_user')
    if (raw) identityId = JSON.parse(raw).identityId || 'investor1'
  } catch { /* defaults are fine */ }

  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Fabric-Identity': identityId,
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  })

  if (res.status === 401 && !_retried && path !== '/api/auth/login') {
    const fresh = await ensureSession()
    if (fresh) return authedFetch(path, options, true)
  }
  return res
}
