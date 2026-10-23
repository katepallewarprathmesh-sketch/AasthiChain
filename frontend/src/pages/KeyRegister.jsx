import React, { useCallback, useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost } from '../lib/umiFetch.js'

/**
 * The key register, with a screen.
 *
 * WHY THIS PAGE EXISTS
 * The rail has screened registered keys for weak entropy since the eMudhra
 * intermediate CA compromise of October 2026, in which the private keys of
 * eight intermediate CAs were computable from their own public certificates
 * because of insufficient randomness. The recovered private values were the
 * small integers 4, 56, 66, 115, 155, 156, 230 and 237, and all eight were
 * recovered in under a second.
 *
 * Three failures stacked there: a weak key entered service, nothing
 * re-checked it for eighteen months, and withdrawing it required every
 * browser vendor to act. This register answers the first two. It cannot
 * answer the third, and does not pretend to.
 *
 * All of that logic lived on the rail with no way to reach it, so the best
 * security work in the project could only be demonstrated with curl. This
 * page makes it a thing a person can do: generate a key in the browser, prove
 * possession by signing a server-issued challenge, and watch the screen
 * either pass it or refuse it with a reason.
 *
 * The keypair is generated with WebCrypto in the visitor's own browser. The
 * private key never leaves it and is never sent anywhere: only the public key
 * and a signature over the challenge are posted. The deliberately weak key
 * used by the "try a weak key" control is a known bad value, generated
 * locally for the purpose of being refused.
 */

const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

const dt = (iso) => { try { return new Date(iso).toLocaleString('en-IN') } catch { return String(iso || '') } }

/** The three states a registered key can be in, and what each one means. */
const STATE_TONE = { ACTIVE: 'live', RETIRED: 'neutral', KEY_COMPROMISE: 'bad', REVOKED: 'bad' }

function ScreenResult({ screen }) {
  if (!screen) return null
  return (
    <div style={{ marginTop: 8 }}>
      <Tag tone={screen.passed ? 'live' : 'bad'}>{screen.passed ? 'screen passed' : 'screen refused'}</Tag>
      {Array.isArray(screen.checksRun) && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11.5, color: '#6B7280', lineHeight: 1.7 }}>
          {screen.checksRun.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}
    </div>
  )
}

export default function KeyRegister() {
  const [keys, setKeys] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [flash, setFlash] = useState(null)
  const [holder, setHolder] = useState('originator1')
  const [use, setUse] = useState('document-signing')

  const load = useCallback(async () => {
    const r = await umiFetch('/keys')
    if (!r.ok) { setErr((r.data && r.data.message) || 'The key register did not answer.'); return }
    setErr('')
    setKeys((r.data && r.data.keys) || [])
  }, [])

  useEffect(() => { load().catch(() => setErr('The key register is unreachable.')) }, [load])

  /**
   * Register a key, the way the rail requires it: ask for a challenge, sign
   * the challenge with the private half, send the public half plus the
   * signature. A public key on its own proves nothing, which is the point of
   * the challenge.
   */
  const register = async (weak) => {
    setBusy(weak ? 'weak' : 'good'); setFlash(null)
    try {
      const ch = await umiPost('/keys/challenge', { holder })
      if (!ch.ok) throw new Error((ch.data && ch.data.message) || 'no challenge')
      const nonce = ch.data.nonce

      let publicKeyHex, signatureHex
      if (weak) {
        // A deliberately bad key: the private scalar is the small integer 4,
        // one of the values actually recovered from the eMudhra CAs. The
        // signature cannot verify, but the screen refuses it before it ever
        // gets that far, which is what we want to show.
        const seed = new Uint8Array(32); seed[31] = 4
        publicKeyHex = toHex(seed)
        signatureHex = toHex(new Uint8Array(64))
      } else {
        const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
        const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
        publicKeyHex = toHex(raw)
        // The rail signs over the nonce hex AS ASCII, not over its bytes.
        const sig = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(nonce))
        signatureHex = toHex(sig)
      }

      const r = await umiPost('/keys', { holder, use, publicKey: publicKeyHex, challengeSignature: signatureHex })
      if (!r.ok) {
        setFlash({ kind: 'bad', text: (r.data && r.data.message) || 'The rail refused the key.', screen: r.data && r.data.screen })
      } else {
        setFlash({ kind: 'ok', text: 'Registered. The screen ran before the key was accepted.', screen: r.data && r.data.key && r.data.key.screen })
        load()
      }
    } catch (e) {
      const msg = String(e.message || e)
      setFlash({
        kind: 'bad',
        text: /Ed25519/i.test(msg)
          ? 'This browser cannot generate an Ed25519 key with WebCrypto. Chrome 137+, Safari 17+ and Firefox 129+ can. The weak-key control still works, because it needs no key generation.'
          : msg,
      })
    } finally { setBusy('') }
  }

  return (
    <PageShell
      eyebrow="Key register"
      title="Proving a key is worth trusting"
      lede="A public key on its own proves nothing: anyone can paste one. Registering here means proving possession by signing a challenge the rail issued, and passing a screen for the entropy failures that have actually broken certificate authorities. A key that passes is not proof of good randomness; it is proof that the known bad shapes are absent."
      badge={<Tag tone="sim">Demo identities on a simulated rail. The signatures and the screening are real.</Tag>}
    >
      <Card
        title="Register a key from this browser"
        sub="The keypair is generated in your browser with WebCrypto. The private half never leaves it: only the public key and a signature over the challenge are sent."
      >
        <div className="pg-kv">
          <div>Holder</div>
          <div>
            <select className="pg-input" value={holder} onChange={e => setHolder(e.target.value)}>
              {['originator1', 'investor1', 'investor2', 'registrar1', 'regulator1'].map(h => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
          <div>What it is for</div>
          <div><input className="pg-input" value={use} onChange={e => setUse(e.target.value)} /></div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="pg-btn" disabled={Boolean(busy)} onClick={() => register(false)}>
            {busy === 'good' ? 'Generating and signing...' : 'Generate a key and register it'}
          </button>
          <button className="pg-btn pg-btn-ghost" disabled={Boolean(busy)} onClick={() => register(true)}>
            {busy === 'weak' ? 'Submitting...' : 'Try a known weak key'}
          </button>
        </div>
        <p className="pg-card-sub" style={{ marginTop: 8 }}>
          The second button submits a key whose private value is the small integer 4: one of the values
          recovered from eight eMudhra intermediate CA certificates in October 2026, all of them computed in
          under a second. The register refuses it before possession is even checked.
        </p>

        {flash && (
          <div className="pg-card" style={{ marginTop: 12 }}>
            <Tag tone={flash.kind === 'ok' ? 'live' : 'bad'}>{flash.kind === 'ok' ? 'Accepted' : 'Refused'}</Tag>
            <p className="pg-card-sub" style={{ marginTop: 8 }}>{flash.text}</p>
            <ScreenResult screen={flash.screen} />
          </div>
        )}
      </Card>

      <Card
        title={`Registered keys (${keys.length})`}
        sub="Every key the rail holds, with the screen that was run against it and the block it was recorded in."
      >
        {err && <p className="pg-card-sub">{err}</p>}
        {!err && keys.length === 0 && <p className="pg-card-sub">No key has been registered yet.</p>}
        {keys.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#6B7280' }}>
                  {['Holder', 'Use', 'Fingerprint', 'Registered', 'Block', 'Screen', 'State'].map(h => (
                    <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.keyId}>
                    <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>{k.holder}</td>
                    <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6', overflowWrap: 'anywhere' }}>{k.use}</td>
                    <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6', fontFamily: 'ui-monospace, monospace' }}>{k.fingerprint}</td>
                    <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6', whiteSpace: 'nowrap' }}>{dt(k.registeredAt)}</td>
                    <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>{k.registeredAtBlock}</td>
                    <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>
                      <Tag tone={k.screen && k.screen.passed ? 'live' : 'bad'}>
                        {k.screen && k.screen.passed ? 'passed' : 'refused'}
                      </Tag>
                    </td>
                    <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>
                      <Tag tone={STATE_TONE[k.status || 'ACTIVE'] || 'neutral'}>
                        {String(k.status || 'ACTIVE').replace(/_/g, ' ').toLowerCase()}
                      </Tag>
                      {k.signaturesRetroactivelyVoid && (
                        <div style={{ fontSize: 10.5, color: '#B91C1C', marginTop: 2 }}>
                          signatures retroactively void
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="What the screen checks, and what it cannot" sub="Passing is the absence of known failures, not evidence of good randomness.">
        <div className="pg-kv">
          <div>Small scalars</div>
          <div>Private values below 8192, in either byte order. This is the class that broke the eMudhra CAs.</div>
          <div>Repeated bytes</div>
          <div>Keys made of one repeated value, the signature of a zeroed or uninitialised buffer.</div>
          <div>Low-order points</div>
          <div>The eight points of small order on the curve, which make signatures forgeable.</div>
          <div>Reuse</div>
          <div>A public key already registered to someone else is refused, not silently reassigned.</div>
        </div>
        <p className="pg-card-sub" style={{ marginTop: 12 }}>
          A key that passes every check can still have been generated badly. The eMudhra keys were produced
          on FIPS 140-2 Level 3 hardware, and a flawed ceremony still emitted a second weak set that stayed in
          service for roughly eighteen months. The lesson taken here is that screening must happen at
          registration and be repeatable afterwards, not that screening makes a key safe.
        </p>
        <p className="pg-card-sub" style={{ marginTop: 8 }}>
          Revocation marks a key <b>KEY_COMPROMISE</b>, which sets signatures retroactively void rather than
          only stopping future use. The third eMudhra failure, needing every browser vendor to act before a
          withdrawal takes effect, has no equivalent here and is not claimed.
        </p>
      </Card>
    </PageShell>
  )
}
