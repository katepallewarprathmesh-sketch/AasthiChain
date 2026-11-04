import React, { useCallback, useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost } from '../lib/umiFetch.js'

/**
 * Credentials, and the part that makes them worth having.
 *
 * WHY THIS PAGE EXISTS
 * The rail has issued signed, chain-anchored credentials for a long time, and
 * the only screens that touched them used one as an input to something else.
 * Nobody could see the register, nobody could revoke anything without curl,
 * and nothing exposed the feature that actually matters.
 *
 * That feature is portability. A credential verified by calling our API is
 * not a credential, it is a login: if this deployment is down, wrong or gone,
 * every document it ever issued becomes unverifiable and the holder
 * re-onboards at the next venue exactly as they would have without it. The
 * test of the claim is whether a stranger can check the document on their own
 * machine with no account here and no network.
 *
 * So the page does three things rather than one:
 *
 *   1. shows the register, and lets an issuer or supervisor revoke,
 *   2. hands the holder a presentation bundle to download, which carries the
 *      key, the anchor, the canonicalisation rule and an honest statement of
 *      what it cannot prove,
 *   3. tells them the one command that verifies it without us, and shows the
 *      revocation list that is the only part needing a network.
 *
 * The verification panel deliberately calls the rail, because that is the
 * convenient path and most visitors will use it. The page says plainly that
 * the convenient path is not the one that proves anything, and names the one
 * that does.
 */

const dt = (iso) => { try { return new Date(iso).toLocaleString('en-IN') } catch { return String(iso || '') } }

const short = (s, n = 18) => {
  const v = String(s || '')
  return v.length > n ? v.slice(0, n) + '…' : v
}

const TYPES = [
  { id: 'TitleValidationCredential', label: 'Title validation', hint: 'a registrar attesting to a property title' },
  { id: 'KYCStatusCredential', label: 'KYC status', hint: 'that a participant passed onboarding' },
  { id: 'DelegatedAuthorityCredential', label: 'Delegated authority', hint: 'what an agent may do on a principal\u2019s behalf' },
]

function Verdict({ v }) {
  if (!v) return null
  const good = v.signatureValid && v.anchorMatches && !v.revoked
  return (
    <div style={{ marginTop: 10, border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Tag tone={good ? 'live' : 'bad'}>{good ? 'verifies' : 'does not verify'}</Tag>
        <Tag tone={v.signatureValid ? 'live' : 'bad'}>signature</Tag>
        <Tag tone={v.anchorMatches ? 'live' : 'bad'}>ledger anchor</Tag>
        <Tag tone={v.revoked ? 'bad' : 'neutral'}>{v.revoked ? 'revoked' : 'not revoked'}</Tag>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12.5, color: '#4B5563', lineHeight: 1.6 }}>{v.summary}</p>
      {v.anchoredAtBlock > 0 && (
        <p style={{ margin: '6px 0 0', fontSize: 11.5, color: '#6B7280' }}>
          anchored in block #{v.anchoredAtBlock}
        </p>
      )}
    </div>
  )
}

export default function Credentials() {
  const [rows, setRows] = useState([])
  const [registry, setRegistry] = useState(null)
  const [status, setStatus] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [flash, setFlash] = useState(null)
  const [verdict, setVerdict] = useState(null)
  const [pasted, setPasted] = useState('')

  const [type, setType] = useState(TYPES[0].id)
  const [subject, setSubject] = useState('investor1')
  const [assetId, setAssetId] = useState('PROP-GREEN-VALLEY-PUNE-001')

  const load = useCallback(async () => {
    setErr('')
    const [list, statusList] = await Promise.all([
      umiFetch('/credentials?limit=50'),
      umiFetch('/credentials/status'),
    ])
    if (list.ok) {
      setRows(list.data.credentials || [])
      setRegistry(list.data.registry || null)
    } else setErr(list.data?.message || 'The credential register could not be read.')
    if (statusList.ok) setStatus(statusList.data)
  }, [])

  useEffect(() => { load() }, [load])

  const issue = async () => {
    setBusy('issue')
    try {
      const res = await umiPost('/credentials', { type, subject, assetId, claims: {} })
      if (res.ok) {
        setFlash({ ok: true, text: 'Issued and anchored. Download the bundle to verify it somewhere else.' })
        load()
      } else setFlash({ ok: false, text: res.data?.message || 'The rail refused to issue this.' })
    } finally { setBusy('') }
  }

  const revoke = async (id) => {
    setBusy(id)
    try {
      const res = await umiPost(`/credentials/${encodeURIComponent(id)}/revoke`, { reason: 'Revoked from the credential register screen.' })
      if (res.ok) {
        setFlash({ ok: true, text: 'Revoked. The status list now says so, which is what a second venue polls.' })
        load()
      } else setFlash({ ok: false, text: res.data?.message || 'Only the issuer that signed it, or a supervisor, can revoke it.' })
    } finally { setBusy('') }
  }

  const verifyStored = async (id) => {
    setBusy(id)
    try {
      const res = await umiFetch(`/credentials/${encodeURIComponent(id)}/verify`)
      setVerdict(res.data)
    } finally { setBusy('') }
  }

  const verifyPasted = async () => {
    setBusy('paste')
    try {
      let body
      try {
        const parsed = JSON.parse(pasted)
        // Accept either a bare credential or a whole presentation bundle, because
        // a holder will paste whichever file they were given.
        body = { credential: parsed.credential || parsed }
      } catch {
        setFlash({ ok: false, text: 'That is not JSON. Paste a credential or a presentation bundle.' })
        return
      }
      const res = await umiPost('/credentials/verify', body)
      setVerdict(res.data)
    } finally { setBusy('') }
  }

  const bundleURL = (id) => `/api/umi/credentials/${encodeURIComponent(id)}/presentation`

  return (
    <PageShell
      eyebrow="Verifiable credentials"
      title="Issued here, verifiable anywhere"
      lede="A registrar signs a statement, the hash is sealed into the ledger, and the holder keeps the document. The point of the exercise is the last step: anyone can check it without an account here, without our permission, and without this service being online."
      badge={<Tag tone="sim">Demo issuer key: proves integrity, not authority</Tag>}
    >
      {err && <Card><p style={{ margin: 0, fontSize: 13 }}>{err}</p></Card>}

      {flash && (
        <Card>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13 }}>{flash.text}</span>
            <button className="pg-btn" onClick={() => setFlash(null)}>Dismiss</button>
          </div>
        </Card>
      )}

      {/* 1. Portability, stated first, because it is the only part that is
          not already obvious from the word "credential". */}
      <Card
        title="Verify one without us"
        sub="Download a presentation bundle and check it on your own machine. The script has no dependency on this repository and makes no network call unless you ask it to check revocation."
      >
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8, color: '#374151' }}>
          <li>Download the bundle for any credential below. It carries the document, the issuer\u2019s public key and fingerprint, the ledger anchor, and the exact rule for rebuilding the signed bytes.</li>
          <li>Run the verifier:
            <div className="pg-mono" style={{ marginTop: 6, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 10px', fontSize: 12, overflowX: 'auto' }}>
              node scripts/verify-credential.mjs bundle.json --check-revocation
            </div>
          </li>
          <li>Steps one to three of that script work with the network unplugged. Only revocation is a fact about now, which is why it is published separately.</li>
        </ol>
      </Card>

      {/* 2. The revocation list: the half a bundle cannot carry. */}
      <Card
        title="Revocation status list"
        sub="A whole list rather than a per-credential lookup, so that checking a credential does not tell us which credential you are checking. Poll it, cache it, work from a copy."
        right={status ? <Tag tone="neutral">as of block #{status.asOfBlockHeight}</Tag> : null}
      >
        {!status ? <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Not loaded.</p> : (
          <>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: '#4B5563' }}>
              {status.count} credential{status.count === 1 ? '' : 's'} listed,{' '}
              {(status.entries || []).filter(e => e.revoked).length} revoked.
            </p>
            <a className="pg-btn" href="/api/umi/credentials/status" target="_blank" rel="noreferrer">Open the raw list</a>
          </>
        )}
      </Card>

      {/* 3. Issue. Behind the same authorisation the rail enforces. */}
      <Card
        title="Issue a credential"
        sub="A registrar or a supervisor signs; the hash is anchored in the same step. If the rail refuses you here, that is the authorisation rule working."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 10, marginBottom: 12 }}>
          <label style={{ minWidth: 0 }}>
            <span className="pg-label">Type</span>
            <select className="pg-input" value={type} onChange={e => setType(e.target.value)}>
              {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <label style={{ minWidth: 0 }}>
            <span className="pg-label">Subject</span>
            <input className="pg-input" value={subject} onChange={e => setSubject(e.target.value)} />
          </label>
          <label style={{ minWidth: 0 }}>
            <span className="pg-label">Property</span>
            <input className="pg-input" value={assetId} onChange={e => setAssetId(e.target.value)} />
          </label>
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: '#6B7280' }}>
          {TYPES.find(t => t.id === type)?.hint}
        </p>
        <button className="pg-btn pg-btn-primary" onClick={issue} disabled={busy === 'issue'}>
          {busy === 'issue' ? 'Signing…' : 'Issue and anchor'}
        </button>
      </Card>

      {/* 4. The register itself. */}
      <Card
        title="The register"
        sub="Every credential this rail has issued, with its anchor and its standing."
        right={registry ? <Tag tone="neutral">{registry.issued ?? rows.length} issued</Tag> : null}
      >
        {rows.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Nothing issued yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {rows.map(rec => {
              const c = rec.credential || {}
              const id = c.id || ''
              return (
                <div key={id} style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 650 }}>
                        {(c.type || []).filter(t => t !== 'VerifiableCredential').join(', ') || 'Credential'}
                      </div>
                      <div className="pg-mono" style={{ fontSize: 11.5, color: '#6B7280', marginTop: 2, overflowWrap: 'anywhere' }}>
                        {id}
                      </div>
                      <div style={{ fontSize: 12, color: '#4B5563', marginTop: 4 }}>
                        {c.issuer} → {(c.credentialSubject || {}).id || 'subject'} · {dt(c.issuanceDate)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Tag tone={rec.revoked ? 'bad' : 'live'}>{rec.revoked ? 'revoked' : 'active'}</Tag>
                      {rec.issuedBlock > 0 && <Tag tone="neutral">block #{rec.issuedBlock}</Tag>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    <a className="pg-btn" href={bundleURL(id)} download>Download bundle</a>
                    <button className="pg-btn" onClick={() => verifyStored(id)} disabled={busy === id}>
                      Verify here
                    </button>
                    {!rec.revoked && (
                      <button className="pg-btn" onClick={() => revoke(id)} disabled={busy === id}>
                        {busy === id ? 'Working…' : 'Revoke'}
                      </button>
                    )}
                    <span style={{ fontSize: 11.5, color: '#6B7280', alignSelf: 'center' }}>
                      hash {short(rec.hash, 14)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <Verdict v={verdict} />
      </Card>

      {/* 5. Paste one in. The convenient path, labelled as such. */}
      <Card
        title="Check a document someone handed you"
        sub="Paste a credential or a whole presentation bundle. This asks the rail, which is convenient and is not the thing that proves portability: for that, run the verifier offline."
      >
        <textarea
          className="pg-input pg-mono"
          value={pasted}
          onChange={e => setPasted(e.target.value)}
          rows={5}
          placeholder='{"@context": […], "id": "urn:aasthi:credential:…", "proof": {…}}'
          style={{ fontSize: 12, minWidth: 0, width: '100%' }}
        />
        <div style={{ marginTop: 10 }}>
          <button className="pg-btn pg-btn-primary" onClick={verifyPasted} disabled={busy === 'paste' || !pasted.trim()}>
            {busy === 'paste' ? 'Checking…' : 'Check it'}
          </button>
        </div>
      </Card>
    </PageShell>
  )
}
