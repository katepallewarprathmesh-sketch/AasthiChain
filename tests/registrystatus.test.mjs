// A validated listing must not read as "pending" on the surfaces that sell it.
//
// This existed as a live bug: the property card tested `p.verified`,
// `p.verificationStatus` and `p.registryVerified`, none of which the API
// returns. The registrar writes `registrarValidationStatus`, so nineteen
// validated listings all displayed "Verification pending". Two guards here:
// the mapping itself, and the live API shape the mapping depends on.

import { readFileSync } from 'node:fs'
import { registryStatus } from '../frontend/src/lib/registryStatus.js'

const BASE = process.env.BASE || 'http://localhost:8080'
const root = new URL('../', import.meta.url)

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')) }
}

console.log('\nregistry status mapping')
ok('VALIDATED reads as verified',
  registryStatus({ registrarValidationStatus: 'VALIDATED' }).state === 'validated')
ok('VALIDATED is not toned as a warning',
  registryStatus({ registrarValidationStatus: 'VALIDATED' }).tone === 'success')
ok('PENDING reads as awaiting review',
  registryStatus({ registrarValidationStatus: 'PENDING' }).state === 'pending')
ok('REJECTED reads as rejected',
  registryStatus({ registrarValidationStatus: 'REJECTED' }).state === 'rejected')
ok('an absent record is unknown, not pending',
  registryStatus({ status: 'TOKENIZED' }).state === 'unknown')
ok('an unknown record does not claim a review is under way',
  !/pending|review/i.test(registryStatus({}).label))
ok('legacy verified flag still honoured',
  registryStatus({ verified: true }).state === 'validated')
ok('lower case is accepted',
  registryStatus({ registrarValidationStatus: 'validated' }).state === 'validated')

console.log('\nsurfaces use the shared reading')
for (const f of ['frontend/src/components/ui.jsx', 'frontend/src/pages/PropertyDetail.jsx']) {
  const src = readFileSync(new URL(f, root), 'utf8')
  ok(`${f} imports registryStatus`, /from '\.\.\/lib\/registryStatus\.js'/.test(src))
  ok(`${f} carries no hard-coded "Verification pending"`, !/Verification pending/.test(src))
}

console.log('\nlive API still carries the field the mapping reads')
try {
  const res = await fetch(`${BASE}/api/properties`)
  const body = await res.json()
  const props = body.properties || []
  ok('listings returned', props.length > 0, `got ${props.length}`)
  const validated = props.filter((p) => registryStatus(p).state === 'validated')
  ok('at least one listing reads as registrar verified',
    validated.length > 0,
    `none of ${props.length} listings mapped to validated; the API field may have been renamed`)
  ok('no validated listing is shown as pending',
    validated.every((p) => registryStatus(p).tone === 'success'))
} catch (e) {
  ok('live API reachable', false, String(e && e.message))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
