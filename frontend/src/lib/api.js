// Centralized API helper — handles both mock and Clerk tokens
// Adds X-Fabric-Identity header when using Clerk token so mock server can map to demo identity

export function getAuthHeaders(extra = {}) {
  const token = localStorage.getItem('aasthi_token') || ''
  const userStr = localStorage.getItem('aasthi_user')
  let identityId = 'investor1'
  try {
    if (userStr) {
      const u = JSON.parse(userStr)
      identityId = u.identityId || 'investor1'
    }
  } catch {}

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Fabric-Identity': identityId,
    ...extra
  }
  return headers
}

export async function apiFetch(url, options = {}) {
  const headers = getAuthHeaders(options.headers || {})
  const res = await fetch(url, { ...options, headers })
  return res
}

export function getStoredUser() {
  try {
    const s = localStorage.getItem('aasthi_user')
    return s ? JSON.parse(s) : null
  } catch { return null }
}
