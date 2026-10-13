import React, { useEffect, useState } from 'react'
import { umiFetch as umi } from '../lib/umiFetch'

// Cross-ledger transfer, Cacti-framed.
//
// The two things a reviewer wants from this panel: which connectors are
// actually configured, and how many tokens are immobilised here because they
// are represented somewhere else. Both are shown before anything else, and a
// commit nobody observed is never counted next to one that was checked.

const C = {
  navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  ok: '#047857', okBg: '#ECFDF5', warn: '#B45309', warnBg: '#FFFBEB',
}

const n = (v) => Number(v || 0).toLocaleString('en-IN')

// The rail describes its connectors in prose, and for a hosted JSON-RPC
// provider that prose contains the endpoint, whose path or query is the API
// key. The rail and the proxy both strip it now, but a deployment can lag
// behind either of them, so the component refuses to paint a URL it was
// handed: scheme and host at most, never a path.
function safeStatus(text) {
  if (typeof text !== 'string') return text
  return text.replace(/https?:\/\/\S+/g, (raw) => {
    try {
      const u = new URL(raw)
      return u.origin
    } catch { return 'the configured endpoint' }
  })
}

export default function InteropPanel() {
  const [d, setD] = useState(null)
  const [rows, setRows] = useState([])
  const [err, setErr] = useState(false)

  useEffect(() => {
    let live = true
    // umiFetch answers {ok, status, data}. An older rail without these
    // routes answers 404 with a JSON error, which must hide the panel
    // rather than paint it with zeroes that look like real counts.
    Promise.all([umi('/interop'), umi('/interop/transfers?limit=8').catch(() => null)])
      .then(([cfg, list]) => {
        if (!live) return
        if (cfg.ok && cfg.data && Array.isArray(cfg.data.connectors)) setD(cfg.data)
        else { setErr(true); return }
        setRows((list && list.ok && list.data.transfers) || [])
      })
      .catch(() => { if (live) setErr(true) })
    return () => { live = false }
  }, [])

  if (err || !d) return null
  const s = d.stats || {}

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
            <div style={{ fontSize: 11.5, color: '#334155', marginTop: 6 }}>{safeStatus(c.status)}</div>
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

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: C.mut }}>
                {['Transfer', 'Asset', 'Tokens', 'To', 'State', 'Evidence'].map((h) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </section>
  )
}
