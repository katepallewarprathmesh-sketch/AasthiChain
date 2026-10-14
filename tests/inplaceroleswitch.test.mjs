// "Switch to Registrar" linked to /login. For a signed-in person that is not
// a role picker: it bounced them to the marketplace and lost the listing they
// had selected, which reads as the app throwing away their work. The prompts
// now ask for the switch in place, through an event App listens for, and the
// page stays where it is.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

const app = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8')
const admin = readFileSync(new URL('../frontend/src/pages/Admin.jsx', import.meta.url), 'utf8')

check('no role prompt sends a signed-in person to /login', () => {
  assert.ok(!/to="\/login"/.test(admin), 'Admin still links to /login for a role change')
})

check('the registrar prompt asks for the switch in place', () => {
  assert.match(admin, /aasthi:switch-role'.*detail: 'Registrar'/s)
})

check('the owner prompt does the same for Originator', () => {
  assert.match(admin, /aasthi:switch-role'.*detail: 'Originator'/s)
})

check('App listens for the request and routes it through handleRoleSwitch', () => {
  assert.match(app, /addEventListener\('aasthi:switch-role'/)
  assert.match(app, /handleRoleSwitch\(target\)/)
  assert.match(app, /removeEventListener\('aasthi:switch-role'/)
})

check('the requested role is resolved against the known identities', () => {
  assert.match(app, /ROLES\.find\(\(r\) => r\.role === wanted \|\| r\.id === wanted\)/)
})

check('an unknown role is ignored rather than clearing the session', () => {
  assert.match(app, /if \(target\) handleRoleSwitch\(target\)/)
})

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
