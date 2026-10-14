// Transport-level limits that nothing else covers.
//
// The local server read a request body until the client stopped sending, with
// no ceiling, so one POST could grow the process until it fell over. No route
// in this repository has any use for a megabyte of JSON. Over the limit the
// request is now refused with 413 before anything is buffered.
//
// CORS is the other half: the read surface is public on purpose, so the
// default stays open, but a deployment must be able to close it without
// editing code. These assertions pin the behaviour and the escape hatch.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const API = process.env.API || 'http://localhost:8080'
let pass = 0, fail = 0
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`) }
}

// ---- an oversized body is refused, not buffered
const huge = JSON.stringify({ x: 'a'.repeat(2 * 1024 * 1024) })
const big = await fetch(API + '/api/properties', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Identity-Id': 'originator1', 'X-Identity-Role': 'Originator' },
  body: huge,
})
let bigBody = {}
try { bigBody = await big.json() } catch { bigBody = {} }
t('a body over the limit is refused with 413', big.status === 413, String(big.status))
t('the refusal names the reason', bigBody.error === 'ERR_BODY_TOO_LARGE', JSON.stringify(bigBody).slice(0, 120))

// ---- the server is still alive afterwards, which is the actual point
const health = await fetch(API + '/api/health')
t('the server survives an oversized request', health.status === 200, String(health.status))

// ---- a normal body still works
const ok = await fetch(API + '/api/properties')
t('an ordinary request is unaffected', ok.status === 200, String(ok.status))

// ---- the limit is configurable rather than hardcoded in a handler
const srv = readFileSync('server.js', 'utf8')
t('the limit is a named constant', /MAX_BODY_BYTES/.test(srv))
t('the limit can be set from the environment', /process\.env\.MAX_BODY_BYTES/.test(srv))
t('oversized chunks are dropped rather than accumulated',
  /chunks\.length = 0/.test(srv) || /over = true/.test(srv))

// ---- CORS: open by default, closeable without a code change
const edge = readFileSync('frontend/api/index.js', 'utf8')
t('CORS has an allowlist escape hatch', /CORS_ALLOW_ORIGIN/.test(edge))
t('an allowlisted response varies on Origin', /Vary['"]?,\s*['"]Origin/.test(edge))
const corsRes = await fetch(API + '/api/health', { headers: { Origin: 'https://example.invalid' } })
t('the default deployment still answers a cross-origin read',
  corsRes.headers.get('access-control-allow-origin') === '*',
  String(corsRes.headers.get('access-control-allow-origin')))

// ---- the documented default matches the code
const envExample = readFileSync('.env.example', 'utf8')
t('.env.example documents the body limit', /MAX_BODY_BYTES=1048576/.test(envExample))
t('.env.example ships no real credential',
  !/PAYU_SALT=\S/.test(envExample) && !/ADMIN_DASHBOARD_KEY=\S/.test(envExample) && !/GROQ_API_KEY=\S/.test(envExample))

console.log(`\ntransporthardening: ${pass} passed, ${fail} failed`)
assert.equal(fail, 0)
