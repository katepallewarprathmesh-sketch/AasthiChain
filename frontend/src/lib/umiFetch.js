// One way to call the rail.
//
// This helper used to live inside UMISettlement.jsx, where it built its own
// fetch and sent only Content-Type — no token, no identity — so every
// participant-scoped route answered ERR_UMI_NO_IDENTITY however the person
// was signed in. It is extracted here so the next page that talks to the rail
// cannot repeat that by writing its own.

import api from './api'

export async function umiFetch(path, options = {}) {
  const url = '/api/umi' + path
  const res = await fetch(url, {
    headers: { ...api.getAuthHeaders(), ...api.operatorHeaders(url) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
    method: options.body ? (options.method || 'POST') : (options.method || 'GET'),
  })
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: 'ERR_BAD_RESPONSE', message: text.slice(0, 200) } }
  return { ok: res.ok, status: res.status, data }
}

// The rail answers in machine codes. People need a sentence that says what to
// do next, so the mapping lives beside the caller rather than in each page.
export const RAIL_ERRORS = {
  ERR_UMI_NO_IDENTITY: 'The rail could not tell who is asking. Sign in, then try again — this action is recorded against a named participant.',
  ERR_UMI_NOT_YOURS: 'That record belongs to another participant. Switch to their role, or ask as a regulator.',
  ERR_UMI_NOT_SUPERVISOR: 'Only a regulator or an operator can do this — it creates money rather than moving it.',
  ERR_UMI_INSUFFICIENT_CBDC: 'There is not enough available e₹-W to cover this. Money already reserved against open work orders does not count as available.',
  ERR_WORK_NOT_FOUND: 'No work order with that reference.',
  ERR_WORK_BAD_STATE: 'That step is not possible from where this order currently stands.',
  ERR_WORK_NOT_YOURS: 'This order is between its funder and its worker. You can only act on your own side of it.',
  ERR_WORK_SELF_DEAL: 'The person paying cannot also be the person delivering — that is the point of the escrow.',
  ERR_WORK_BAD_HASH: 'A deliverable needs a real SHA-256 hash (64 hex characters) so it can be verified later.',
  ERR_WORK_MISSING_FIELD: 'Something required is missing from the order.',
  ERR_WORK_INVALID_AMOUNT: 'The fee must be a positive amount.',
}

export const explainRail = (d) => {
  const code = d && d.error
  if (code && RAIL_ERRORS[code]) return `${RAIL_ERRORS[code]} (${code})`
  const msg = d && d.message && d.message !== code ? d.message : ''
  return [code || 'Request failed', msg].filter(Boolean).join(' — ')
}

export default umiFetch
