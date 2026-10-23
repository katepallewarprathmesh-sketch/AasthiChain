// Signed feeds: the supported way an outside fact enters the rail.
//
// The point of these checks is that the feed refuses. A number that arrives
// unsigned, late, twice, backdated, from the wrong holder, or under a key
// nobody registered has to be turned away, and the refusal has to say which
// of those it was. A feed that answers "88.50" to all of them is a variable
// with a REST API in front of it.
//
//   node tests/oracle.test.mjs          (RAIL=http://localhost:21100)

import { generateKeyPairSync, sign as nodeSign } from 'node:crypto'

const RAIL = process.env.RAIL || 'http://localhost:21100'
let passed = 0, failed = 0
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')) }
}

// Every call site names its method explicitly, including GET. It costs a few
// characters and it lets scripts/coverage-rail.mjs prove what this suite
// touches instead of marking it "possible".
const rail = async (path, init) => {
  const r = await fetch(RAIL + path, { method: 'GET', ...init })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, body }
}
const post = (path, payload, headers = {}) => rail(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(payload),
})

// An ed25519 keypair, and the raw 32 byte public key the rail registers: the
// last 32 bytes of the SPKI DER export.
const newKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return { privateKey, publicHex: Buffer.from(spki.subarray(spki.length - 32)).toString('hex') }
}
const signHex = (privateKey, message) =>
  Buffer.from(nodeSign(null, Buffer.from(message), privateKey)).toString('hex')

// The exact message the rail verifies. Written out here rather than imported,
// so a change to the signing format on the Go side fails this suite instead
// of silently accepting a different one.
const feedMessage = (feedId, value, observedAt, nonce) =>
  ['aasthi-feed', 'v1', feedId, String(value), observedAt, nonce].join('|')

// The canonical timestamp: UTC, always exactly three decimals. A publisher
// that lets its own library trim trailing zeros signs a different string.
const iso = (d) => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z')

// The key register requires an identified caller and proof of possession:
// a signature over the challenge nonce, sent as challengeSignature.
const asHolder = (holder) => ({ 'X-Identity-Id': holder })

const registerKey = async (holder) => {
  const key = newKey()
  const ch = await post('/umi/keys/challenge', { holder }, asHolder(holder))
  const nonce = ch.body?.nonce
  if (!nonce) return null
  const reg = await post('/umi/keys', {
    holder, use: 'oracle', publicKey: key.publicHex,
    challengeSignature: signHex(key.privateKey, nonce),
  }, asHolder(holder))
  if (reg.status !== 201 && reg.status !== 200) {
    console.log('       key registration said ' + reg.status + ' ' + JSON.stringify(reg.body).slice(0, 200))
    return null
  }
  return key
}

const run = async () => {
  const stamp = Date.now()
  const FEED = `FX.TEST.${stamp}`

  // 1. The contract is mandatory.
  const noContract = await post('/umi/oracle/feeds', {
    feedId: `${FEED}.bad`, publishers: ['registrar1'],
  })
  ok('a feed without a freshness contract is refused',
    noContract.status === 400 && /maxStalenessSec/.test(JSON.stringify(noContract.body)),
    JSON.stringify(noContract.body))

  const noPublishers = await post('/umi/oracle/feeds', {
    feedId: `${FEED}.bad2`, maxStalenessSec: 60,
  })
  ok('a feed with nobody allowed to publish is refused',
    noPublishers.status === 400, JSON.stringify(noPublishers.body))

  // 2. A real feed, with a registered publisher key.
  const key = await registerKey('registrar1')
  ok('the publisher has a registered signing key', !!key)
  if (!key) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1) }

  const made = await post('/umi/oracle/feeds', {
    feedId: FEED, description: 'test rate', unit: 'INR per USD',
    publishers: ['registrar1'], maxStalenessSec: 300, minPublishers: 1, maxDeviationPct: 5,
  }, { 'X-Identity-Id': 'regulator1' })
  ok('a feed with a contract is registered', made.status === 201, JSON.stringify(made.body).slice(0, 200))
  ok('registering a feed is recorded with its contract',
    made.body?.feed?.maxStalenessSec === 300 && made.body?.feed?.registeredAtBlock > 0,
    JSON.stringify(made.body?.feed))

  // 3. Before any reading, the feed says it has none. It does not invent one.
  const empty = await rail(`/umi/oracle/feeds/${FEED}`, { method: 'GET' })
  ok('an unpublished feed reports no data rather than a default',
    empty.body?.value?.usable === false && empty.body?.value?.state === 'NO_DATA',
    JSON.stringify(empty.body?.value))

  // 4. Unsigned and wrongly signed readings are refused.
  const at = iso(new Date())
  const unsigned = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex, signature: '', value: 88.4,
    observedAt: at, nonce: 'u1',
  })
  ok('an unsigned reading is refused', unsigned.status === 401 || unsigned.status === 400,
    JSON.stringify(unsigned.body))

  const tampered = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(FEED, 88.4, at, 't1')),
    value: 99.9, observedAt: at, nonce: 't1',
  })
  ok('changing the value after signing is refused',
    tampered.status === 401 && tampered.body?.code === 'ERR_UMI_FEED_SIGNATURE',
    JSON.stringify(tampered.body))

  // 5. A key nobody registered is not a weaker source, it is no source.
  const stranger = newKey()
  const strangerAt = iso(new Date())
  const unknownKey = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'registrar1', publicKey: stranger.publicHex,
    signature: signHex(stranger.privateKey, feedMessage(FEED, 88.4, strangerAt, 's1')),
    value: 88.4, observedAt: strangerAt, nonce: 's1',
  })
  ok('a signature from an unregistered key is refused',
    unknownKey.status === 403 && unknownKey.body?.code === 'ERR_UMI_FEED_KEY',
    JSON.stringify(unknownKey.body))

  // 6. A holder who is not a publisher on this feed.
  const notPublisher = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'investor1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(FEED, 88.4, strangerAt, 'p1')),
    value: 88.4, observedAt: strangerAt, nonce: 'p1',
  })
  ok('a holder who is not a publisher on the feed is refused',
    notPublisher.status === 403, JSON.stringify(notPublisher.body))

  // 7. A good reading, and the value it produces.
  const goodAt = iso(new Date())
  const good = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(FEED, 88.42, goodAt, 'g1')),
    value: 88.42, observedAt: goodAt, nonce: 'g1',
  })
  ok('a correctly signed reading is accepted', good.status === 201, JSON.stringify(good.body).slice(0, 200))
  ok('the feed now has a usable value with its provenance',
    good.body?.value?.usable === true && good.body?.value?.value === 88.42 &&
    (good.body?.value?.sources || []).some((s) => s.startsWith('registrar1:')),
    JSON.stringify(good.body?.value))
  ok('the reading is on the ledger', good.body?.observation?.block > 0,
    JSON.stringify(good.body?.observation?.block))

  // 8. Replay and backdating.
  const replay = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(FEED, 88.42, goodAt, 'g1')),
    value: 88.42, observedAt: goodAt, nonce: 'g1',
  })
  ok('replaying the same signed reading is refused',
    replay.status === 409 && replay.body?.code === 'ERR_UMI_FEED_REPLAY',
    JSON.stringify(replay.body))

  const backAt = iso(new Date(Date.now() - 60000))
  const backdated = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(FEED, 88.0, backAt, 'b1')),
    value: 88.0, observedAt: backAt, nonce: 'b1',
  })
  ok('a reading timestamped before the publisher\'s last one is refused',
    backdated.status === 409, JSON.stringify(backdated.body))

  const aheadAt = iso(new Date(Date.now() + 15 * 60000))
  const future = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(FEED, 88.0, aheadAt, 'f1')),
    value: 88.0, observedAt: aheadAt, nonce: 'f1',
  })
  ok('a reading timestamped in the future is refused, because it would never go stale',
    future.status === 422 && future.body?.code === 'ERR_UMI_FEED_CLOCK',
    JSON.stringify(future.body))

  // 9. Staleness: a short-lived feed refuses instead of serving the last value.
  const SHORT = `FX.SHORT.${stamp}`
  await post('/umi/oracle/feeds', {
    feedId: SHORT, unit: 'INR per USD', publishers: ['registrar1'],
    maxStalenessSec: 1, minPublishers: 1,
  }, { 'X-Identity-Id': 'regulator1' })
  const shortAt = iso(new Date())
  await post(`/umi/oracle/feeds/${SHORT}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(SHORT, 77.7, shortAt, 'sh1')),
    value: 77.7, observedAt: shortAt, nonce: 'sh1',
  })
  await new Promise((r) => setTimeout(r, 2200))
  const stale = await rail(`/umi/oracle/feeds/${SHORT}`, { method: 'GET' })
  ok('a feed past its freshness contract refuses rather than returning the last value',
    stale.body?.value?.usable === false && stale.body?.value?.state === 'STALE' &&
    stale.body?.value?.value === 0,
    JSON.stringify(stale.body?.value))
  ok('the staleness refusal says what the contract was',
    /stops being usable/.test(stale.body?.value?.reason || ''), stale.body?.value?.reason)

  // 10. Quorum.
  const QUORUM = `FX.QUORUM.${stamp}`
  const q = await post('/umi/oracle/feeds', {
    feedId: QUORUM, unit: 'INR per USD', publishers: ['registrar1', 'regulator1'],
    maxStalenessSec: 300, minPublishers: 2,
  }, { 'X-Identity-Id': 'regulator1' })
  ok('a quorum feed can be declared', q.status === 201, JSON.stringify(q.body).slice(0, 160))
  const qAt = iso(new Date())
  await post(`/umi/oracle/feeds/${QUORUM}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(QUORUM, 88.0, qAt, 'q1')),
    value: 88.0, observedAt: qAt, nonce: 'q1',
  })
  const oneOfTwo = await rail(`/umi/oracle/feeds/${QUORUM}`, { method: 'GET' })
  ok('one publisher short of quorum is not a usable value',
    oneOfTwo.body?.value?.usable === false && oneOfTwo.body?.value?.state === 'NO_QUORUM',
    JSON.stringify(oneOfTwo.body?.value))

  const key2 = await registerKey('regulator1')
  ok('a second publisher can register a key', !!key2)
  if (key2) {
    const q2At = iso(new Date())
    await post(`/umi/oracle/feeds/${QUORUM}/observations`, {
      publisher: 'regulator1', publicKey: key2.publicHex,
      signature: signHex(key2.privateKey, feedMessage(QUORUM, 88.2, q2At, 'q2')),
      value: 88.2, observedAt: q2At, nonce: 'q2',
    })
    const both = await rail(`/umi/oracle/feeds/${QUORUM}`, { method: 'GET' })
    ok('with the quorum met the feed produces the median of its publishers',
      both.body?.value?.usable === true && both.body?.value?.value === 88.1 &&
      both.body?.value?.observers === 2,
      JSON.stringify(both.body?.value))
    ok('the spread between publishers is reported, not hidden',
      (both.body?.value?.spreadPct ?? 0) > 0, JSON.stringify(both.body?.value))
  }

  // 11. The list is public, so a reader can see every feed and its contract
  // without holding any credential.
  const list = await rail('/umi/oracle/feeds', { method: 'GET' })
  const listed = (list.body?.feeds || [])
    .map((entry) => entry.feed || entry)
    .find((f) => f.feedId === FEED)
  ok('the feed register is readable and carries each freshness contract',
    list.status === 200 && !!listed && listed.maxStalenessSec === 300,
    JSON.stringify(listed || list.body).slice(0, 200))

  // 12. The posture is honest about what this is not.
  const posture = await rail('/umi/oracle/posture', { method: 'GET' })
  ok('the posture publishes the trust rules',
    (posture.body?.rules || []).length >= 5, JSON.stringify(posture.body?.rules || []).slice(0, 160))
  ok('the posture says this is not a decentralised oracle network',
    /not a decentralised oracle network/.test(JSON.stringify(posture.body?.limits || [])),
    JSON.stringify(posture.body?.limits || []).slice(0, 200))

  // 13. The first consumer: the cross-border quote says where its rate came from.
  const rules = await rail('/umi/crossborder/rules', { method: 'GET' })
  const prov = rules.body?.rateProvenance
  ok('the cross-border rate declares its provenance',
    !!prov && typeof prov.signed === 'boolean', JSON.stringify(prov))
  ok('an unsigned rate is labelled as the indicative constant, not as a quote',
    prov?.signed === true || prov?.source === 'INDICATIVE_CONSTANT', JSON.stringify(prov))

  // 14. Readings are public, so an outside reader can audit the provenance.
  const obs = await rail(`/umi/oracle/feeds/${FEED}/observations?limit=5`, { method: 'GET' })
  ok('observations are readable with their signer and timestamp',
    Array.isArray(obs.body?.observations) && obs.body.observations.length > 0 &&
    !!obs.body.observations[0].keyId && !!obs.body.observations[0].observedAt,
    JSON.stringify(obs.body?.observations?.[0] || {}).slice(0, 200))

  // 15. Retirement.
  const retired = await post(`/umi/oracle/feeds/${SHORT}/retire`, { reason: 'test' },
    { 'X-Identity-Id': 'regulator1' })
  ok('a feed can be retired', retired.status === 200 && retired.body?.feed?.retired === true,
    JSON.stringify(retired.body).slice(0, 160))
  const afterRetire = await rail(`/umi/oracle/feeds/${SHORT}`, { method: 'GET' })
  ok('a retired feed produces nothing', afterRetire.body?.value?.state === 'RETIRED',
    JSON.stringify(afterRetire.body?.value))

  // 16. The ablation. The rail ships with FX.INR.USD declared and unpublished,
  // so the quote falls back to the indicative constant and says so. Publish one
  // signed reading at a different number: the quote has to move to it and
  // relabel itself. If the number does not move, the feed is decoration.
  const before = await rail('/umi/crossborder/rules', { method: 'GET' })
  const beforeRate = before.body?.rateINRPerUSD
  // On a freshly started rail this is the indicative constant, which is the
  // interesting half of the ablation. On a re-run against the same process an
  // earlier pass has already published, so accept either, but insist the
  // label and the signed flag agree: a quote that says SIGNED_FEED while
  // signed is false would be the exact dishonesty this feed exists to remove.
  const beforeProv = before.body?.rateProvenance || {}
  ok('before this pass publishes, the rate says truthfully where it came from',
    (beforeProv.source === 'INDICATIVE_CONSTANT' && beforeProv.signed === false) ||
    (beforeProv.source === 'SIGNED_FEED' && beforeProv.signed === true),
    JSON.stringify(beforeProv))
  if (beforeProv.source === 'SIGNED_FEED') {
    console.log('       (note: this rail already holds a signed reading from an earlier pass;')
    console.log('        restart the gateway to see the indicative-constant fallback)')
  }

  const liveAt = iso(new Date())
  const target = Number((beforeRate + 1.25).toFixed(2))
  const pub = await post(`/umi/oracle/feeds/${encodeURIComponent('FX.INR.USD')}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage('FX.INR.USD', target, liveAt, 'live' + stamp)),
    value: target, observedAt: liveAt, nonce: 'live' + stamp,
  })
  ok('a signed rate can be published to the feed the quote reads',
    pub.status === 201, JSON.stringify(pub.body).slice(0, 200))

  const after = await rail('/umi/crossborder/rules', { method: 'GET' })
  ok('the published rate replaces the constant in the cross-border rules',
    after.body?.rateINRPerUSD === target, 'got ' + after.body?.rateINRPerUSD + ', wanted ' + target)
  ok('and the rules now say the rate is signed, naming the publisher',
    after.body?.rateProvenance?.signed === true &&
    JSON.stringify(after.body?.rateProvenance?.sources || []).includes('registrar1'),
    JSON.stringify(after.body?.rateProvenance))

  // The same number has to reach an actual quote, not just the rules card.
  const quote = await post('/umi/crossborder', {
    assetId: 'PROP-ORCHARD-NASHIK-001', amountINR: 50000, stablecoin: 'USDC',
    network: 'ETHEREUM', buyerStatus: 'NRI', nationality: 'INDIAN', kycRef: 'KYC-TEST-1',
    originator: { name: 'Test Buyer', address: '1 Test Road', country: 'AE', account: 'acct-1' },
    beneficiary: { name: 'AasthiChain Escrow', address: 'Pune', country: 'IN', account: 'acct-2' },
  }, asHolder('investor1'))
  if (quote.status === 200 || quote.status === 201) {
    const intent = quote.body?.intent
    ok('a live quote prices at the signed rate',
      intent?.rateINRPerUnit === target,
      JSON.stringify({ rate: intent?.rateINRPerUnit, target }))
    ok('a live quote carries the provenance of the rate it used, naming the feed',
      intent?.rateProvenance?.signed === true && intent?.rateProvenance?.feedId === 'FX.INR.USD',
      JSON.stringify(intent?.rateProvenance))
    ok('the human readable rate source stops claiming the rate is configured on the rail',
      !/indicative, configured on the rail/.test(intent?.rateSource || ''), intent?.rateSource)
  } else {
    ok('a live quote prices at the signed rate',
      false, 'quote refused: ' + quote.status + ' ' + JSON.stringify(quote.body).slice(0, 300))
  }

  // A round millisecond is the case a trimming timestamp format gets wrong.
  const roundAt = iso(new Date(Math.floor(Date.now() / 1000) * 1000))
  const round = await post(`/umi/oracle/feeds/${FEED}/observations`, {
    publisher: 'registrar1', publicKey: key.publicHex,
    signature: signHex(key.privateKey, feedMessage(FEED, 88.61, roundAt, 'round' + stamp)),
    value: 88.61, observedAt: roundAt, nonce: 'round' + stamp,
  })
  ok('a reading timestamped on a round millisecond verifies',
    round.status === 201, JSON.stringify(round.body).slice(0, 200))

  // 17. Unknown feeds are a 404, not an empty value.
  const missing = await rail('/umi/oracle/feeds/NOPE.NOT.A.FEED', { method: 'GET' })
  ok('an unknown feed is a 404 rather than a blank value', missing.status === 404,
    JSON.stringify(missing.body))

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

run().catch((e) => { console.error(e); process.exit(1) })
