/**
 * One reading of "has the registrar validated this listing?".
 *
 * The card used to test `p.verified` / `p.verificationStatus` /
 * `p.registryVerified`. The API returns none of those: the field a registrar
 * actually writes is `registrarValidationStatus`, alongside `validatedBy`,
 * `validatedByMsp` and `validatedAt`. Every listing therefore read as
 * unverified and showed "Verification pending" even after validation.
 *
 * Absent is not the same as pending. A listing with no validation record at
 * all (older seeded demo rows) must not claim a review is under way, so it
 * gets a neutral "not recorded" state instead of a warning.
 */
export function registryStatus(p) {
  if (!p) return { state: 'unknown', tone: 'off', label: 'Registry status unavailable' }

  const raw = String(
    p.registrarValidationStatus ?? p.validationStatus ?? '',
  ).trim().toUpperCase()

  // Legacy/alternate shapes some callers still set.
  const legacyVerified = p.verified === true
    || p.registryVerified === true
    || String(p.verificationStatus || '').toUpperCase() === 'VERIFIED'

  if (raw === 'VALIDATED' || legacyVerified) {
    return {
      state: 'validated',
      tone: 'success',
      label: 'Registrar verified',
      by: p.validatedBy || null,
      at: p.validatedAt || null,
    }
  }
  if (raw === 'REJECTED') {
    return { state: 'rejected', tone: 'error', label: 'Registrar rejected' }
  }
  if (raw === 'PENDING' || raw === 'SUBMITTED' || raw === 'UNDER_REVIEW') {
    return { state: 'pending', tone: 'pending', label: 'Awaiting registrar review' }
  }
  return { state: 'unknown', tone: 'off', label: 'Registry status not recorded' }
}

export default registryStatus
