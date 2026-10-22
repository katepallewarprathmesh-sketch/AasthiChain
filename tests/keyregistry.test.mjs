// Signing keys: screened on the way in, revocable in one act, public.
//
// Written the day after the October 2026 eMudhra incident, in which the
// private keys of eight intermediate certificate authorities turned out to
// be small integers, one of them the number 4, recoverable from the public
// certificates in under a second and in service for about eighteen months.
//
// The question this suite answers is the one worth asking about our own
// rail: could the same three failures happen here. A weak key entering
// service, nothing re-checking it afterwards, and no way to withdraw it
// except one credential at a time.
//
//   node tests/keyregistry.test.mjs          (BASE=http://localhost:8080)

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto'

const BASE = process.env.BASE || 'http://localhost:8080'
let passed = 0, failed = 0
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')) }
}
const headers = (id, role) => ({ 'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role })
const get = async (path, id, role) => {
  const r = await fetch(BASE + '/api/umi' + path, { headers: headers(id || 'investor1', role || 'Investor') })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const post = async (path, id, role, payload) => {
  const r = await fetch(BASE + '/api/umi' + path, { method: 'POST', headers: headers(id, role), body: JSON.stringify(payload || {}) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

// Raw 32-byte public key out of a node KeyObject.
const rawPublic = (pub) => Buffer.from(pub.export({ format: 'der', type: 'spki' })).subarray(-32).toString('hex')

// An Ed25519 private key built from a chosen 32-byte seed, which is how the
// eMudhra keys are reproduced: the seed is simply the number.
const keyFromSeed = (seedHex) =>
  createPrivateKey({
    key: Buffer.from('302e020100300506032b657004220420' + seedHex, 'hex'),
    format: 'der', type: 'pkcs8',
  })

const strongPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubHex: rawPublic(publicKey), priv: privateKey }
}

const signHex = (priv, message) => nodeSign(null, Buffer.from(message), priv).toString('hex')

async function main() {
  console.log('\nSigning key register\n')
  const tag = Date.now()

  // 1. The register is public. An operator-only register gives an outside
  //    researcher nothing to check, which is how eight bad keys survived
  //    eighteen months.
  const root = await get('/keys')
  ok('the key register is mounted and readable', root.status === 200, JSON.stringify(root.body).slice(0, 160))
  ok('the register publishes its revocation reasons', !!root.body.revocationReasons)
  ok('KEY_COMPROMISE is distinguished from an orderly rotation',
    /unattributable/i.test(root.body.revocationReasons?.KEY_COMPROMISE || '')
    && /stand/i.test(root.body.revocationReasons?.SUPERSEDED || ''))

  // 2. The exact failure: a private key that is the number 4.
  const weakSeed = '00'.repeat(31) + '04'
  const weakPriv = keyFromSeed(weakSeed)
  const weakPub = rawPublic(createPublicKey(weakPriv))

  const screened = await post('/keys/screen', 'investor1', 'Investor', { publicKey: weakPub })
  ok('a private key of 4 is screened as weak', screened.status === 200 && screened.body.screen?.passed === false,
    JSON.stringify(screened.body).slice(0, 200))
  ok('the screen names the failure rather than just failing',
    /small integer 4/i.test(JSON.stringify(screened.body.screen?.failures || [])))
  ok('the screen states what it cannot prove',
    /cannot prove/i.test(screened.body.screen?.limitation || ''))

  // A key from a real generator passes the same screen.
  const good = strongPair()
  const goodScreen = await post('/keys/screen', 'investor1', 'Investor', { publicKey: good.pubHex })
  ok('a key from a real generator passes', goodScreen.body.screen?.passed === true,
    JSON.stringify(goodScreen.body.screen?.failures || []))

  // 3. Registration requires proof of possession.
  const holder = 'originator1'
  const ch = await post('/keys/challenge', holder, 'Originator', { holder })
  ok('a challenge is issued for proof of possession', ch.status === 201 && !!ch.body.nonce,
    JSON.stringify(ch.body).slice(0, 160))

  const other = strongPair()
  const wrongSig = signHex(other.priv, ch.body.nonce || '')
  const impostor = await post('/keys', holder, 'Originator', {
    holder, use: `test-${tag}`, publicKey: good.pubHex, challengeSignature: wrongSig,
  })
  ok('a key signed by somebody else is refused', impostor.status === 403,
    `${impostor.status} ${JSON.stringify(impostor.body).slice(0, 140)}`)

  // 4. The weak key is refused even when possession is genuinely proved.
  const ch2 = await post('/keys/challenge', holder, 'Originator', { holder })
  const weakSig = signHex(weakPriv, ch2.body.nonce || '')
  const weakReg = await post('/keys', holder, 'Originator', {
    holder, use: `weak-${tag}`, publicKey: weakPub, challengeSignature: weakSig,
  })
  ok('a weak key is refused even with possession proved', weakReg.status === 422,
    `${weakReg.status} ${JSON.stringify(weakReg.body).slice(0, 160)}`)
  ok('the refusal is reported as a weak key, not a generic error',
    weakReg.body.error === 'ERR_UMI_KEY_WEAK', JSON.stringify(weakReg.body).slice(0, 140))

  // 5. The good key registers, and lands on the chain.
  const ch3 = await post('/keys/challenge', holder, 'Originator', { holder })
  const goodSig = signHex(good.priv, ch3.body.nonce || '')
  const reg = await post('/keys', holder, 'Originator', {
    holder, use: `issuer-${tag}`, publicKey: good.pubHex, challengeSignature: goodSig,
  })
  ok('a screened key with proved possession registers', reg.status === 201,
    `${reg.status} ${JSON.stringify(reg.body).slice(0, 180)}`)
  const keyId = reg.body.key?.keyId
  ok('the registration records the block it was written at', Number(reg.body.key?.registeredAtBlock) > 0,
    JSON.stringify(reg.body.key || {}).slice(0, 160))
  ok('the registration keeps the screening verdict with the key', !!reg.body.key?.screen?.checksRun?.length)

  // 6. The same key cannot be claimed by a second holder.
  const ch4 = await post('/keys/challenge', 'registrar1', 'Registrar', { holder: 'registrar1' })
  const dupSig = signHex(good.priv, ch4.body.nonce || '')
  const dup = await post('/keys', 'registrar1', 'Registrar', {
    holder: 'registrar1', use: `dup-${tag}`, publicKey: good.pubHex, challengeSignature: dupSig,
  })
  ok('one key cannot be registered to two holders', dup.status === 409,
    `${dup.status} ${JSON.stringify(dup.body).slice(0, 140)}`)

  // 7. Revocation is one act and says what it means for past signatures.
  const revoked = await post(`/keys/${encodeURIComponent(keyId)}/revoke`, 'regulator1', 'Regulator', {
    reason: 'KEY_COMPROMISE',
  })
  ok('a key can be revoked in one act', revoked.status === 200,
    `${revoked.status} ${JSON.stringify(revoked.body).slice(0, 160)}`)
  ok('KEY_COMPROMISE voids earlier signatures too',
    revoked.body.key?.signaturesRetroactivelyVoid === true)

  const after = await get('/keys')
  const entry = (after.body.keys || []).find((k) => k.keyId === keyId)
  ok('the revoked key stays in the register rather than disappearing', !!entry,
    'an append-only log that deletes entries is not append-only')
  ok('the register shows it as revoked with the reason', entry?.revoked === true && entry?.revokeReason === 'KEY_COMPROMISE')

  // 8. Re-screening keys already in service: the eighteen-month problem.
  const audit = await post('/keys/audit', 'regulator1', 'Regulator', {})
  ok('every key in service can be re-screened on demand', audit.status === 200 && Number(audit.body.audited) >= 0,
    JSON.stringify(audit.body).slice(0, 160))
  ok('a clean audit does not overclaim',
    /not proof of good entropy/i.test(audit.body.verdict || ''), audit.body.verdict)

  // 9. The posture report tells the truth about our own key.
  const posture = await get('/keys/posture')
  ok('the rail reports what it signs with', posture.status === 200 && !!posture.body.posture)
  if (posture.body.credentialIssuerSeedIsPublic === true) {
    ok('a demo issuer key is declared, not hidden',
      posture.body.posture === 'DEMO_KEY_IN_USE' && /forge/i.test(posture.body.warning || ''),
      JSON.stringify(posture.body).slice(0, 200))
  } else {
    ok('an operator seed is reported without claiming it was well generated',
      /cannot verify how it was generated/i.test(posture.body.note || ''), posture.body.note)
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
