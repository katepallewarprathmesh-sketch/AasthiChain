// The agent harness: what it refuses, and whether it can be stopped.
//
// An autonomous actor that moves other people's money is only as good as the
// things it declines to do, so most of this file is refusals. The policy
// module is pure on purpose, which means every one of these can be a cheap,
// deterministic unit test rather than a scenario against a live rail.
//
// The two bugs that already happened here, both found by running the thing
// rather than reasoning about it, are pinned at the bottom:
//
//   1. The register publishes a status string, not a boolean. Reading
//      passport.revoked returned undefined, so a revoked agent kept going.
//   2. The mandate's standing is keyed on the name written on the mandate.
//      Grant to a free-text name while the passport lives under a
//      pseudonym and revoking the passport never bites: the kill switch is
//      wired to a name nothing uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, findCredential, shouldStop, KNOWN_ACTIONS, POLICY_ACTION } from '../agent/policy.mjs'

const HOUR = 3600 * 1000
const NOW = Date.parse('2026-11-06T12:00:00Z')

const credential = (over = {}) => ({
  credential: {
    id: 'urn:aasthi:credential:' + 'a'.repeat(32),
    type: ['VerifiableCredential', 'TitleValidationCredential'],
    issuer: 'did:aasthi:registrar1',
    credentialSubject: { id: 'investor1', assetId: 'PROP-GREEN-VALLEY-PUNE-001' },
  },
  issuedBy: 'registrar1',
  revoked: false,
  ...over,
})

const condition = (over = {}) => ({
  conditionId: 'COND-20261106-0001',
  assetId: 'PROP-GREEN-VALLEY-PUNE-001',
  credentialType: 'TitleValidationCredential',
  asserter: 'investor1',
  status: 'OPEN',
  cashPaise: 200000,
  deadlineAt: '2026-11-07T12:00:00Z',
  ...over,
})

const state = (over = {}) => ({
  principal: 'investor1',
  conditions: [condition()],
  credentials: [credential()],
  nowMs: NOW,
  ...over,
})

const limits = (over = {}) => ({
  actions: ['RELEASE_CONDITION'],
  remainingPaise: 500000,
  assets: [],
  ...over,
})

// ---------------------------------------------------------------- the happy path

test('it releases a condition whose named credential exists and stands', () => {
  const { intents, skipped } = decide(state(), limits())
  assert.equal(skipped.length, 0)
  assert.equal(intents.length, 1)
  assert.equal(intents[0].conditionId, 'COND-20261106-0001')
  assert.equal(intents[0].action, 'RELEASE_CONDITION')
  assert.equal(intents[0].amountPaise, 200000)
  assert.match(intents[0].credentialId, /^urn:aasthi:credential:/)
})

test('RELEASE_CONDITION is the only thing this policy knows how to want', () => {
  // A caretaker that could also sell things is a different product with a
  // different risk. If that changes it should be a decision, so it is
  // pinned: the policy forms one kind of intent, whatever the rail can bound.
  assert.equal(POLICY_ACTION, 'RELEASE_CONDITION')
  assert.ok(KNOWN_ACTIONS.includes('RELEASE_CONDITION'))
  const many = decide(state({
    conditions: [condition({ conditionId: 'C1' }), condition({ conditionId: 'C2' })],
  }), limits())
  assert.ok(many.intents.every(i => i.action === 'RELEASE_CONDITION'))
})

// ---------------------------------------------------------------- the refusals

test('it will not act on a condition it was not delegated to assert', () => {
  const { intents, skipped } = decide(state({ conditions: [condition({ asserter: 'investor2' })] }), limits())
  assert.equal(intents.length, 0)
  assert.equal(skipped.length, 1)
  assert.match(skipped[0].why, /entitled to assert/i)
})

test('it will not act on a condition that is not open', () => {
  for (const status of ['RELEASED', 'REFUNDED', 'EXPIRED']) {
    const { intents } = decide(state({ conditions: [condition({ status })] }), limits())
    assert.equal(intents.length, 0, `acted on a ${status} condition`)
  }
})

test('it will not reverse an expiry the rail has already applied', () => {
  // Presenting after the deadline refunds rather than settles, so an agent
  // that tries is not being helpful: it is closing somebody's agreement on
  // the wrong terms, autonomously, after the window they agreed to.
  const past = state({ conditions: [condition({ deadlineAt: '2026-11-06T11:00:00Z' })] })
  const { intents, skipped } = decide(past, limits())
  assert.equal(intents.length, 0)
  assert.match(skipped[0].why, /deadline|passed|expire/i)
})

test('it stays inside the money it was given', () => {
  const { intents, skipped } = decide(state(), limits({ remainingPaise: 150000 }))
  assert.equal(intents.length, 0)
  assert.match(skipped[0].why, /150000|mandate has/)
})

test('it stops at the ceiling across a batch rather than spending it twice', () => {
  // Each condition passes the limit alone. Together they do not, and the
  // rail would refuse the second after the first had already moved money.
  const many = state({
    conditions: [
      condition({ conditionId: 'C1', cashPaise: 200000 }),
      condition({ conditionId: 'C2', cashPaise: 200000 }),
      condition({ conditionId: 'C3', cashPaise: 200000 }),
    ],
  })
  const { intents } = decide(many, limits({ remainingPaise: 500000 }))
  const total = intents.reduce((n, i) => n + i.amountPaise, 0)
  assert.ok(total <= 500000, `intended ${total} paise against a 500000 ceiling`)
  assert.equal(intents.length, 2)
})

test('it respects an asset allowlist on the mandate', () => {
  const { intents, skipped } = decide(state(), limits({ assets: ['PROP-SOMETHING-ELSE'] }))
  assert.equal(intents.length, 0)
  assert.match(skipped[0].why, /does not cover PROP-GREEN-VALLEY-PUNE-001/)
})

test('it does nothing at all without the action on its mandate', () => {
  const { intents, skipped } = decide(state(), limits({ actions: ['SETTLE_DVP'] }))
  assert.equal(intents.length, 0)
  assert.ok(skipped.length >= 1)
})

// ------------------------------------------------- resolving the named credential

test('a credential for the right person on the wrong asset is not the claim that was named', () => {
  const wrong = [credential({
    credential: { ...credential().credential, credentialSubject: { id: 'investor1', assetId: 'PROP-OTHER' } },
  })]
  assert.ok(!findCredential(wrong, condition()).credentialId)
})

test('a credential of the wrong type is not the claim that was named', () => {
  const wrong = [credential({
    credential: { ...credential().credential, type: ['VerifiableCredential', 'KYCCredential'] },
  })]
  assert.ok(!findCredential(wrong, condition()).credentialId)
})

test('a revoked credential is not a credential', () => {
  const found = findCredential([credential({ revoked: true })], condition())
  assert.ok(!found.credentialId)
  assert.match(found.why, /revoked/i)
})

test('when the condition names an issuer, another issuer will not do', () => {
  const cond = condition({ issuer: 'registrar2' })
  assert.ok(!findCredential([credential()], cond).credentialId)
})

test('with no issuer named, any issuer satisfies it', () => {
  assert.ok(findCredential([credential()], condition({ issuer: '' })).credentialId)
})

// ---------------------------------------------------------------- the stop rule

test('an unregistered agent does not act', () => {
  assert.equal(shouldStop({ passport: null, mandate: {}, nowMs: NOW }).stop, true)
})

test('a REVOKED status stops it, even though there is no revoked boolean to read', () => {
  // Bug 1. The view publishes status, not revoked. Reading the boolean that
  // is not there gave undefined, which is falsy, which kept a revoked agent
  // running against a live rail. Found by revoking a real passport.
  const out = shouldStop({ passport: { status: 'REVOKED' }, mandate: { revoked: false }, nowMs: NOW })
  assert.equal(out.stop, true)
  assert.match(out.why, /withdrawn/i)
})

test('an open identification request pauses it, which is stricter than the rail', () => {
  const out = shouldStop({ passport: { status: 'REVEAL_PENDING' }, mandate: { revoked: false }, nowMs: NOW })
  assert.equal(out.stop, true)
  assert.match(out.why, /identification/i)
})

test('an active passport with a live mandate keeps going', () => {
  const out = shouldStop({
    passport: { status: 'ACTIVE' },
    mandate: { revoked: false, limitPaise: 500000, spentPaise: 0, expiresAt: new Date(NOW + HOUR).toISOString() },
    nowMs: NOW,
  })
  assert.equal(out.stop, false, out.why)
})

test('a revoked or expired mandate stops it', () => {
  assert.equal(shouldStop({ passport: { status: 'ACTIVE' }, mandate: { revoked: true }, nowMs: NOW }).stop, true)
  assert.equal(shouldStop({
    passport: { status: 'ACTIVE' },
    mandate: { revoked: false, expiresAt: new Date(NOW - HOUR).toISOString() },
    nowMs: NOW,
  }).stop, true)
})

test('the local kill file stops it without needing the rail to answer', () => {
  // The rail being unreachable must never be the reason an operator cannot
  // stop their own agent.
  const out = shouldStop({ passport: { status: 'ACTIVE' }, mandate: { revoked: false }, killed: true, nowMs: NOW })
  assert.equal(out.stop, true)
})

test('the passport and the mandate must name the same identity', () => {
  // Bug 2. MandateRegistry.Authorise checks standing against the name on
  // the mandate. Grant to a free-text agent name while the passport lives
  // under its pseudonym and Standing reports unregistered, the withdrawal
  // branch never fires, and revoking the passport does not stop anything.
  const out = shouldStop({
    passport: { agentId: 'agent:aasthi:5f7f4b8557668c5c', status: 'ACTIVE' },
    mandate: {
      revoked: false, agent: 'agent-caretaker-1', limitPaise: 500000, spentPaise: 0,
      expiresAt: new Date(NOW + HOUR).toISOString(),
    },
    nowMs: NOW,
  })
  assert.equal(out.stop, true, 'a mandate naming a different identity must halt the agent')
  assert.match(out.why, /passport|mandate|identit/i)
})
