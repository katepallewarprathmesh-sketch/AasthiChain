import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { umiFetch as umi, umiPost, explainRail } from '../lib/umiFetch'

// Cross-ledger transfer, Cacti-framed.
//
// The two things a reviewer wants from this panel: which connectors are
// actually configured, and how many tokens are immobilised here because they
// are represented somewhere else. Both are shown before anything else, and a
// commit nobody observed is never counted next to one that was checked.
//
// It used to be a read-only card, which meant it always showed five zeroes
// and no way to make them move. The lifecycle is the interesting part, so the
// three state transitions the rail already exposes (lock, commit, abort) are
// driven from here: lock immobilises tokens in custody, commit closes the
// transfer against a counterpart leg, abort gives the tokens back.

const C = {
  navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  ok: '#047857', okBg: '#ECFDF5', warn: '#B45309', warnBg: '#FFFBEB',
  err: '#B91C1C', errBg: '#FEF2F2',
}

const n = (v) => Number(v || 0).toLocaleString('en-IN')

const btn = (tone) => ({
  padding: '6px 11px', borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
  border: `1px solid ${tone === 'primary' ? C.navy : C.line}`,
  background: tone === 'primary' ? C.navy : 'white',
  color: tone === 'primary' ? 'white' : C.navy,
})

const field = {
  padding: '6px 8px', borderRadius: 7, border: `1px solid ${C.line}`,
  fontSize: 12.5, color: C.navy, background: 'white', minWidth: 0,
}

export default function InteropPanel({ participants = [], assetIds = [] }) {
  const [d, setD] = useState(null)
  const [rows, setRows] = useState([])
  const [err, setErr] = useState(false)

  const [assets, setAssets] = useState([])
  const [assetId, setAssetId] = useState('')
  const [holders, setHolders] = useState([])
  const [holder, setHolder] = useState('')
  const [tokens, setTokens] = useState('')
  const [ledger, setLedger] = useState('')
  const [remoteAccount, setRemoteAccount] = useState('')
  const [busy, setBusy] = useState('')
  const [flash, setFlash] = useState(null)
  const [digests, setDigests] = useState({})

  // One place that reloads everything the card shows, so an action never
  // leaves half the panel describing the state before it.
  const load = useCallback(async () => {
    const [cfg, list] = await Promise.all([
      umi('/interop'),
      umi('/interop/transfers?limit=8').catch(() => null),
    ])
    // umiFetch answers {ok, status, data}. An older rail without these
    // routes answers 404 with a JSON error, which must hide the panel
    // rather than paint it with zeroes that look like real counts.
    if (!cfg.ok || !cfg.data || !Array.isArray(cfg.data.connectors)) { setErr(true); return false }
    setD(cfg.data)
    setRows((list && list.ok && list.data.transfers) || [])
    return true
  }, [])

  useEffect(() => { load().catch(() => setErr(true)) }, [load])

  useEffect(() => {
    let live = true
    umi('/assets').then((r) => {
      if (!live || !r.ok || !r.data || !Array.isArray(r.data.assets)) return
      const fromRail = r.data.assets.map((a) => (a.profile && a.profile.assetId)).filter(Boolean)
      setAssets(Array.from(new Set([...fromRail, ...assetIds])))
    }).catch(() => {})
    return () => { live = false }
  // assetIds is a prop array rebuilt on each render of the parent, so it is
  // compared by content rather than identity.
  }, [assetIds.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  // Who actually holds this asset decides who can lock it, and how much. The
  // rail refuses a lock larger than the position, so the form reads the
  // position first rather than letting someone submit a number that cannot
  // work.
  useEffect(() => {
    if (!assetId) { setHolders([]); setHolder(''); return }
    let live = true
    umi('/ownership/' + encodeURIComponent(assetId)).then((r) => {
      if (!live) return
      const hs = (r.ok && r.data && Array.isArray(r.data.holders)) ? r.data.holders : []
      const real = hs.filter((h) => h.holder !== 'interop-custody' && Number(h.tokens) > 0)
      setHolders(real)
      setHolder((cur) => (real.some((h) => h.holder === cur) ? cur : (real[0] ? real[0].holder : '')))
    }).catch(() => { if (live) setHolders([]) })
    return () => { live = false }
  }, [assetId])

  const remoteLedgers = useMemo(
    () => ((d && d.connectors) || []).filter((c) => c.ledger !== 'drunix'),
    [d],
  )
  useEffect(() => {
    if (!ledger && remoteLedgers.length) setLedger(remoteLedgers[0].ledger)
  }, [remoteLedgers, ledger])

  if (err || !d) return null
  const s = d.stats || {}
  const held = holders.find((h) => h.holder === holder)
  const maxTokens = held ? Number(held.tokens) : 0

  const act = async (key, fn, okMessage) => {
    setBusy(key); setFlash(null)
    try {
      const r = await fn()
      if (!r.ok) { setFlash({ kind: 'err', text: explainRail(r.data) }); return }
      await load()
      setFlash({ kind: 'ok', text: typeof okMessage === 'function' ? okMessage(r.data) : okMessage })
    } catch (e) {
      setFlash({ kind: 'err', text: String((e && e.message) || e) })
    } finally { setBusy('') }
  }

  const lock = () => act('lock',
    () => umiPost('/interop/lock', {
      assetId, holder, tokens: Number(tokens),
      remoteLedger: ledger, remoteAccount: remoteAccount.trim(),
    }),
    (data) => {
      const t = (data && data.transfer) || {}
      return `${t.transferId}: ${n(t.tokens)} tokens moved into custody at block ${n(t.lockBlockHeight)}. They cannot settle here until this closes.`
    })

  const commit = (t) => act('commit:' + t.transferId,
    () => umiPost(`/interop/${encodeURIComponent(t.transferId)}/commit`, {
      remoteTxRef: 'manual-' + Date.now(),
      digest: (digests[t.transferId] || '').trim(),
    }),
    (data) => {
      const x = (data && data.transfer) || {}
      return x.remoteLegVerified
        ? `${x.transferId} committed and the remote leg was observed by the connector.`
        : `${x.transferId} committed as a supervisor attestation. Nothing was observed on the other ledger, and it is counted separately.`
    })

  const abort = (t) => act('abort:' + t.transferId,
    () => umiPost(`/interop/${encodeURIComponent(t.transferId)}/abort`, { reason: 'released from the panel' }),
    `${t.transferId}: tokens returned from custody to ${t.holder}.`)

  const canLock = Boolean(assetId && holder && ledger && Number(tokens) > 0 && Number(tokens) <= maxTokens)

  return (
    <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>
        12 · Cross-ledger transfer
      </h2>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.mut, maxWidth: 790 }}>
        One connector per ledger, and one plugin that sequences a transfer across them. Tokens are locked into a
        custody account here before anything is claimed elsewhere, so a crash cannot leave the same asset on both
        ledgers.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        {(d.connectors || []).map((c) => (
          <div key={c.ledger} style={{
            flex: '1 1 300px', border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 12px',
            background: c.configured ? C.okBg : '#F8FAFC',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
              <strong style={{ color: C.navy, fontSize: 13.5 }}>{c.ledger}</strong>
              <span style={{
                fontSize: 10.5, fontWeight: 700, letterSpacing: .3, textTransform: 'uppercase',
                color: c.configured ? C.ok : C.mut,
              }}>
                {c.configured ? 'configured' : 'not configured'}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: C.mut, marginTop: 2 }}>{c.kind}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 14 }}>
        {[
          ['Locked now', n(s.locked), `${n(s.tokensLockedPending)} tokens immobilised`],
          ['Committed', n(s.committed), `${n(s.tokensRepresentedRemotely)} tokens represented elsewhere`],
          ['Verified by a connector', n(s.committedVerified), 'observed on the remote chain'],
          ['Attested only', n(s.committedAttestedOnly), 'claimed by a supervisor, not observed'],
          ['Aborted', n(s.aborted), 'tokens returned'],
        ].map(([label, value, hint]) => (
          <div key={label} style={{ minWidth: 130 }}>
            <div style={{ fontSize: 11, color: C.mut, textTransform: 'uppercase', letterSpacing: .4 }}>{label}</div>
            <div style={{ fontWeight: 700, fontSize: 19, color: C.navy, marginTop: 2 }}>{value}</div>
            <div style={{ fontSize: 10.5, color: C.mut, marginTop: 2 }}>{hint}</div>
          </div>
        ))}
      </div>

      {/* Lock. The first half of the sequence, and the only half that moves
          tokens on this ledger. */}
      <div style={{ marginTop: 16, border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 13px' }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy }}>Lock tokens for a transfer out</div>
        <div style={{ fontSize: 11.5, color: C.mut, marginTop: 3, maxWidth: 760 }}>
          Tokens move from the holder into the custody account on this ledger. Nothing is claimed anywhere else
          until the transfer is committed, and an abort returns them.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 9, marginTop: 11 }}>
          <label style={{ display: 'grid', gap: 3, fontSize: 11, color: C.mut }}>
            Asset
            <select style={field} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">Choose an asset</option>
              {assets.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 3, fontSize: 11, color: C.mut }}>
            Holder
            <select style={field} value={holder} onChange={(e) => setHolder(e.target.value)} disabled={!holders.length}>
              {!holders.length && <option value="">No position on this asset</option>}
              {holders.map((h) => (
                <option key={h.holder} value={h.holder}>{h.holder} ({n(h.tokens)})</option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 3, fontSize: 11, color: C.mut }}>
            Tokens {maxTokens > 0 ? `(up to ${n(maxTokens)})` : ''}
            <input
              style={field} type="number" min="1" max={maxTokens || undefined} value={tokens}
              onChange={(e) => setTokens(e.target.value)} placeholder="0"
            />
          </label>

          <label style={{ display: 'grid', gap: 3, fontSize: 11, color: C.mut }}>
            Remote ledger
            <select style={field} value={ledger} onChange={(e) => setLedger(e.target.value)}>
              {remoteLedgers.map((c) => (
                <option key={c.ledger} value={c.ledger}>
                  {c.ledger}{c.configured ? '' : ' (not configured)'}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 3, fontSize: 11, color: C.mut }}>
            Remote account (optional)
            <input style={field} value={remoteAccount} onChange={(e) => setRemoteAccount(e.target.value)} placeholder="0x..." />
          </label>
        </div>

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" style={{ ...btn('primary'), opacity: canLock && !busy ? 1 : .5 }}
            disabled={!canLock || Boolean(busy)} onClick={lock}>
            {busy === 'lock' ? 'Locking...' : 'Lock tokens'}
          </button>
          {Number(tokens) > maxTokens && maxTokens > 0 && (
            <span style={{ fontSize: 11.5, color: C.warn }}>
              {holder} holds {n(maxTokens)}, so the rail would refuse this.
            </span>
          )}
          {participants.length > 0 && holders.length === 0 && assetId && (
            <span style={{ fontSize: 11.5, color: C.mut }}>Nobody holds a position in this asset yet.</span>
          )}
        </div>
      </div>

      {flash && (
        <div style={{
          marginTop: 11, padding: '9px 12px', borderRadius: 9, fontSize: 12.5,
          background: flash.kind === 'ok' ? C.okBg : C.errBg,
          border: `1px solid ${flash.kind === 'ok' ? '#A7F3D0' : '#FECACA'}`,
          color: flash.kind === 'ok' ? C.ok : C.err,
        }}>
          {flash.text}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: C.mut }}>
                {['Transfer', 'Asset', 'Tokens', 'To', 'State', 'Evidence', 'Close it'].map((h) => (
                  <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.line}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.transferId}>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}`, fontWeight: 600, color: C.navy }}>{t.transferId}</td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>{t.assetId}</td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>{n(t.tokens)}</td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>{t.remoteLedger}</td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>
                    {t.status}
                    {t.status === 'COMMITTED' && (
                      <span style={{ marginLeft: 6, fontSize: 10.5, color: t.remoteLegVerified ? C.ok : C.warn }}>
                        {t.remoteLegVerified ? 'verified' : 'attested'}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}`, color: C.mut, maxWidth: 280 }}>
                    {t.remoteLegEvidence}
                  </td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>
                    {t.status === 'LOCKED' ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                          style={{ ...field, fontSize: 11, width: 150 }}
                          placeholder="digest (optional)"
                          value={digests[t.transferId] || ''}
                          onChange={(e) => setDigests((m) => ({ ...m, [t.transferId]: e.target.value }))}
                        />
                        <button type="button" style={btn('primary')} disabled={Boolean(busy)} onClick={() => commit(t)}>
                          {busy === 'commit:' + t.transferId ? '...' : 'Commit'}
                        </button>
                        <button type="button" style={btn()} disabled={Boolean(busy)} onClick={() => abort(t)}>
                          {busy === 'abort:' + t.transferId ? '...' : 'Abort'}
                        </button>
                      </div>
                    ) : (
                      <span style={{ fontSize: 11, color: C.mut }}>closed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: C.mut, marginTop: 7, maxWidth: 790 }}>
            A digest is what a configured connector checks on the remote chain. Supply one and the commit is refused
            unless that chain holds it. Leave it empty and the commit is recorded as a supervisor attestation, which
            is counted separately and never as an observation. Committing needs a regulator or an operator.
          </div>
        </div>
      )}
    </section>
  )
}
