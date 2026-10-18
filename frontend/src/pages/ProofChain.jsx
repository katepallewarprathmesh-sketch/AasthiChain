import React, { useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'

/**
 * The chain above the token: attestation, credential, delegated authority.
 *
 * These three layers were built on the rail and had no screen at all, which
 * meant the most interesting part of the system was reachable only with
 * curl. Everything here reads from the rail through the normal proxy; the
 * page computes nothing of its own, because a number this page invented
 * would be exactly the kind of claim the layer exists to prevent.
 */

const j = async (path, init) => {
  const r = await fetch(path, init)
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { ok: r.ok, status: r.status, body }
}

function Rupees({ paise }) {
  const n = Number(paise || 0) / 100
  return <span className="tabular">₹{n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
}

/* ---------------- credentials ---------------- */

function Credentials({ onInspect }) {
  const [list, setList] = useState(null)
  const [err, setErr] = useState('')
  const [verifying, setVerifying] = useState('')
  const [results, setResults] = useState({})

  useEffect(() => {
    let alive = true
    j('/api/umi/credentials?limit=50').then(({ ok, body }) => {
      if (!alive) return
      if (!ok) { setErr(body.message || 'The credential registry did not answer.'); return }
      setList(body.credentials || [])
    }).catch(() => alive && setErr('The credential registry is unreachable.'))
    return () => { alive = false }
  }, [])

  const verify = async (id) => {
    setVerifying(id)
    const { body } = await j('/api/umi/credentials/' + encodeURIComponent(id) + '/verify')
    setResults(r => ({ ...r, [id]: body }))
    setVerifying('')
  }

  if (err) return <div className="pg-card pg-empty">{err}</div>
  if (!list) return <div className="pg-card pg-empty">Loading…</div>
  if (!list.length) {
    return (
      <div className="pg-card pg-empty">
        No credentials have been issued yet. A registrar issues one against a listing, and it appears here.
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {list.map(rec => {
        const c = rec.credential || {}
        const subject = c.credentialSubject || {}
        const res = results[c.id]
        return (
          <Card
            key={c.id}
            title={(c.type || []).filter(t => t !== 'VerifiableCredential')[0] || 'Credential'}
            sub={`Signed by ${c.issuer} on block ${rec.issuedBlock}`}
            right={rec.revoked ? <Tag tone="bad">Withdrawn</Tag> : <Tag tone="live">Standing</Tag>}
          >
            <dl className="pg-kv">
              <dt>Subject</dt><dd>{subject.id || '-'}</dd>
              {subject.assetId && (<><dt>Asset</dt><dd className="pg-mono">{subject.assetId}</dd></>)}
              <dt>Issued</dt><dd>{c.issuanceDate}</dd>
              <dt>Anchor</dt><dd className="pg-mono">{rec.hash}</dd>
            </dl>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="pg-btn" onClick={() => verify(c.id)} disabled={verifying === c.id}>
                {verifying === c.id ? 'Checking…' : 'Check this credential'}
              </button>
              {subject.assetId && (
                <button className="pg-btn pg-btn-ghost" onClick={() => onInspect(c.id)}>
                  What rests on it
                </button>
              )}
            </div>
            {res && (
              <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Tag tone={res.signatureValid ? 'live' : 'bad'}>
                  Signature {res.signatureValid ? 'valid' : 'invalid'}
                </Tag>
                <Tag tone={res.anchorMatches ? 'live' : 'bad'}>
                  Anchor {res.anchorMatches ? 'matches' : 'does not match'}
                </Tag>
                <Tag tone={res.revoked ? 'bad' : 'neutral'}>{res.revoked ? 'Withdrawn' : 'Not withdrawn'}</Tag>
                <Tag tone={res.issuerKnown ? 'neutral' : 'bad'}>
                  Issuer {res.issuerKnown ? 'known' : 'unknown'}
                </Tag>
              </div>
            )}
            {res && (
              <p className="pg-card-sub" style={{ marginTop: 10 }}>
                These are four separate facts. A withdrawn credential still carries a valid signature: what changed
                is that the issuer no longer stands behind it.
              </p>
            )}
          </Card>
        )
      })}
    </div>
  )
}

/* ---------------- attestation impact ---------------- */

function Impact({ credentialId, setCredentialId }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (id) => {
    if (!id) return
    setBusy(true); setErr(''); setData(null)
    const { ok, body, status } = await j('/api/umi/attestations/' + encodeURIComponent(id))
    setBusy(false)
    if (!ok) { setErr(status === 404 ? 'No attestation with that id.' : (body.message || 'That lookup failed.')); return }
    setData(body.impact)
  }

  useEffect(() => { if (credentialId) load(credentialId) }, [credentialId])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card
        title="Who vouched, and who is exposed"
        sub="A token is only as good as the attestation under it. Paste a credential id, or come here from the credentials tab."
      >
        <label className="pg-field" htmlFor="credid">Credential id</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            id="credid"
            className="pg-input"
            style={{ flex: '1 1 320px' }}
            value={credentialId}
            placeholder="urn:aasthi:credential:…"
            onChange={e => setCredentialId(e.target.value)}
          />
          <button className="pg-btn" onClick={() => load(credentialId)} disabled={busy || !credentialId}>
            {busy ? 'Looking…' : 'Look it up'}
          </button>
        </div>
        {err && <p className="pg-card-sub" style={{ color: 'var(--error-rust)', marginTop: 10 }}>{err}</p>}
      </Card>

      {data && (
        <>
          <Card
            title={data.assetId || 'Not about a specific asset'}
            sub={data.accountability}
            right={data.withdrawn ? <Tag tone="bad">Withdrawn</Tag> : <Tag tone="live">Standing</Tag>}
          >
            <dl className="pg-kv">
              <dt>Attestor</dt><dd>{data.attestor}</dd>
              <dt>Issued</dt><dd>{data.issuedAt} (block {data.issuedBlock})</dd>
              {data.withdrawn && (<>
                <dt>Withdrawn by</dt><dd>{data.withdrawnBy} (block {data.withdrawnBlock})</dd>
                <dt>Reason given</dt><dd>{data.withdrawnReason || 'none recorded'}</dd>
              </>)}
              <dt>Holders</dt><dd>{data.holderCount}</dd>
              <dt>Tokens outstanding</dt><dd className="tabular">{(data.tokensOutstanding || 0).toLocaleString('en-IN')}</dd>
              <dt>Trades that relied on it</dt><dd>{data.tradeCount}</dd>
              <dt>Value settled meanwhile</dt><dd><Rupees paise={data.valueSettledPaiseWhileStanding} /></dd>
            </dl>
            <p className="pg-card-sub" style={{ marginTop: 14 }}><strong>Recourse:</strong> {data.recourse}</p>
          </Card>

          {!!(data.holders || []).length && (
            <Card title="Holders downstream of this attestation">
              <div style={{ display: 'grid', gap: 8 }}>
                {data.holders.map(h => (
                  <div key={h.holder} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13.5 }}>
                    <span>{h.holder}</span>
                    <span className="tabular">{h.tokens.toLocaleString('en-IN')} tokens</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {!!(data.tradesWhileStanding || []).length && (
            <Card title="Trades that settled while it stood" sub="Trades that settled before it was issued did not rely on it and are not counted.">
              <div style={{ display: 'grid', gap: 10 }}>
                {data.tradesWhileStanding.map(t => (
                  <div key={t.instructionId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
                    <span className="pg-mono">{t.instructionId}</span>
                    <span>{t.seller} to {t.buyer}, {t.tokens} tokens</span>
                    <span className="tabular"><Rupees paise={t.cashPaise} /></span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <p className="pg-card-sub">{data.disclaimer}</p>
        </>
      )}
    </div>
  )
}

/* ---------------- attestor record ---------------- */

function Attestor() {
  const [id, setId] = useState('registrar1')
  const [rec, setRec] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    const { body } = await j('/api/umi/attestors/' + encodeURIComponent(id))
    setRec(body.attestor || null)
    setBusy(false)
  }
  useEffect(() => { load() }, [])

  return (
    <Card title="Attestor record" sub="An attestation is worth what the attestor's record is worth, and a record nobody can read is not a record.">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <input className="pg-input" style={{ flex: '1 1 220px' }} value={id} onChange={e => setId(e.target.value)} />
        <button className="pg-btn" onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Look up'}</button>
      </div>
      {rec && (
        <>
          <dl className="pg-kv">
            <dt>Identity</dt><dd className="pg-mono">{rec.did}</dd>
            <dt>Attestations</dt><dd>{rec.issued} issued, {rec.standing} standing</dd>
            <dt>Withdrawn</dt><dd>{rec.withdrawalRate}</dd>
            <dt>Assets covered</dt><dd>{rec.assetsAttested}</dd>
            <dt>Tokens resting on it</dt><dd className="tabular">{(rec.tokensRestingOnThisAttestor || 0).toLocaleString('en-IN')}</dd>
            <dt>Signing key</dt><dd className="pg-mono">{rec.publicKey || 'not published'}</dd>
          </dl>
          <p className="pg-card-sub" style={{ marginTop: 14 }}>{rec.accountability}</p>
        </>
      )}
    </Card>
  )
}

/* ---------------- mandates ---------------- */

function Mandates() {
  const [list, setList] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    j('/api/umi/mandates?limit=50').then(({ ok, body, status }) => {
      if (!alive) return
      if (!ok) {
        setErr(status === 401 || status === 403
          ? 'Sign in to see the authority granted from your own account. A mandate spends somebody\'s wallet, so the book is not public.'
          : (body.message || 'The mandate registry did not answer.'))
        return
      }
      setList(body.mandates || [])
    }).catch(() => alive && setErr('The mandate registry is unreachable.'))
    return () => { alive = false }
  }, [])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card title="Delegated authority" sub="A principal gives an agent bounded authority: which actions, up to how much, on which assets, until when. The rail enforces every bound on the settlement path and counts the spend itself.">
        <Tag tone="sim">No autonomous agent runs here</Tag>
        <p className="pg-card-sub" style={{ marginTop: 10 }}>
          This is the authority layer such an actor would need. Nothing on this deployment acts on its own.
        </p>
      </Card>

      {err && <div className="pg-card pg-empty">{err}</div>}
      {!err && !list && <div className="pg-card pg-empty">Loading…</div>}
      {!err && list && !list.length && (
        <div className="pg-card pg-empty">No authority has been delegated from this account.</div>
      )}
      {(list || []).map(m => {
        const remaining = (m.limitPaise || 0) - (m.spentPaise || 0)
        const pct = m.limitPaise ? Math.min(100, Math.round(((m.spentPaise || 0) / m.limitPaise) * 100)) : 0
        return (
          <Card
            key={m.mandateId}
            title={m.agent}
            sub={m.purpose || 'No purpose stated'}
            right={m.revoked ? <Tag tone="bad">Revoked</Tag> : <Tag tone="live">Active</Tag>}
          >
            <dl className="pg-kv">
              <dt>Granted by</dt><dd>{m.principal}</dd>
              <dt>May</dt><dd>{(m.actions || []).join(', ')}</dd>
              <dt>Assets</dt><dd>{(m.assets || []).length ? m.assets.join(', ') : 'any listed asset'}</dd>
              <dt>Expires</dt><dd>{m.expiresAt}</dd>
              <dt>Used</dt><dd>{m.uses || 0} times</dd>
              <dt>Budget</dt>
              <dd>
                <Rupees paise={m.spentPaise} /> of <Rupees paise={m.limitPaise} /> spent, <Rupees paise={remaining} /> left
                <div style={{ height: 6, borderRadius: 4, background: 'var(--ink-8)', marginTop: 7, overflow: 'hidden' }}>
                  <div style={{ width: pct + '%', height: '100%', background: pct > 85 ? 'var(--error-rust)' : 'var(--registry-navy)' }} />
                </div>
              </dd>
            </dl>
          </Card>
        )
      })}
    </div>
  )
}

/* ---------------- page ---------------- */

const TABS = [
  { id: 'credentials', label: 'Credentials' },
  { id: 'impact', label: 'What rests on it' },
  { id: 'attestor', label: 'Attestor record' },
  { id: 'mandates', label: 'Agent authority' },
]

export default function ProofChain() {
  const [tab, setTab] = useState('credentials')
  const [credentialId, setCredentialId] = useState('')

  const inspect = (id) => { setCredentialId(id); setTab('impact') }

  return (
    <PageShell
      eyebrow="Proof chain"
      title="Above the token"
      lede="Minting is the easy part. What decides whether a tokenised asset means anything is the chain above it: a real asset, somebody who attests to it, a credential anyone can check, and only then a token. These screens show that chain, including who is exposed when an attestation is withdrawn."
      badge={<Tag tone="sim">Attestors here are demo identities on a simulated rail</Tag>}
    >
      <div className="pg-tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className="pg-tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'credentials' && <Credentials onInspect={inspect} />}
      {tab === 'impact' && <Impact credentialId={credentialId} setCredentialId={setCredentialId} />}
      {tab === 'attestor' && <Attestor />}
      {tab === 'mandates' && <Mandates />}
    </PageShell>
  )
}
