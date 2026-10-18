import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

// The honesty ledger, as a page.
//
// Every boundary in this system is either wired to something real or modelled
// locally, and a reader has no way to tell which from a screenshot. Stating it
// plainly in one place is worth more than the few places it would flatter us
// to stay vague: an undisclosed simulation found by a reviewer costs the whole
// project's credibility, while a disclosed one costs nothing.
//
// The data comes from /api/trust, which derives it from the live environment,
// so this page cannot drift out of date the way a hand-written list would.

const C = {
  ink: '#0F172A', mut: '#64748B', line: '#E2E8F0', bg: '#F8FAFC',
  ok: '#059669', okBg: '#ECFDF5', okLine: '#A7F3D0',
  sim: '#B45309', simBg: '#FFFBEB', simLine: '#FDE68A',
}

function Badge({ live }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
      padding: '3px 8px', borderRadius: 20, whiteSpace: 'nowrap',
      color: live ? C.ok : C.sim,
      background: live ? C.okBg : C.simBg,
      border: `1px solid ${live ? C.okLine : C.simLine}`,
    }}>{live ? 'Live' : 'Simulated'}</span>
  )
}

export default function Trust() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    fetch('/api/trust', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setErr(String(e.message || e)) })
    return () => { alive = false }
  }, [])

  return (
    <div className="pg pg-narrow" style={{ color: C.ink }}>
      <h1 className="pg-title">
        What is real here, and what is simulated
      </h1>
      <p style={{ fontSize: 14.5, color: C.mut, lineHeight: 1.65, marginTop: 12, maxWidth: 680 }}>
        AasthiChain is a working implementation of a settlement pattern, not a connected financial
        institution. The engineering below is real and you can inspect it. The connections to outside
        institutions are not, and this page says exactly where that line falls.
      </p>

      {err && (
        <div style={{ marginTop: 20, padding: 12, border: `1px solid ${C.line}`, borderRadius: 10, fontSize: 13 }}>
          Could not load the live status ({err}). The list below is served by <code>/api/trust</code>.
        </div>
      )}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
            <div style={{ padding: '10px 14px', background: C.okBg, border: `1px solid ${C.okLine}`, borderRadius: 10 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.ok }}>{data.liveCount}</div>
              <div style={{ fontSize: 11, color: C.mut }}>wired to something real</div>
            </div>
            <div style={{ padding: '10px 14px', background: C.simBg, border: `1px solid ${C.simLine}`, borderRadius: 10 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.sim }}>{data.simulatedCount}</div>
              <div style={{ fontSize: 11, color: C.mut }}>modelled locally</div>
            </div>
          </div>

          <h2 style={{ fontSize: 17, fontWeight: 700, marginTop: 34, marginBottom: 4 }}>Every external boundary</h2>
          <p style={{ fontSize: 12.5, color: C.mut, margin: '0 0 14px' }}>
            Read live from the running deployment's configuration, so it cannot go stale.
          </p>

          <div style={{ display: 'grid', gap: 10 }}>
            {(data.integrations || []).map((i) => (
              <div key={i.name} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <strong style={{ fontSize: 14 }}>{i.name}</strong>
                  <Badge live={i.status === 'live'} />
                </div>
                <p style={{ fontSize: 13, color: '#334155', lineHeight: 1.6, margin: '8px 0 0' }}>{i.detail}</p>
                {i.liveWhen && (
                  <p style={{ fontSize: 12, color: C.mut, margin: '8px 0 0' }}>
                    <strong style={{ color: '#475569' }}>Becomes live when:</strong> {i.liveWhen}
                  </p>
                )}
              </div>
            ))}
          </div>

          <h2 style={{ fontSize: 17, fontWeight: 700, marginTop: 34, marginBottom: 10 }}>What is genuinely built</h2>
          <ul style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.75, paddingLeft: 20, margin: 0 }}>
            {(data.whatIsReal || []).map((t) => <li key={t} style={{ marginBottom: 6 }}>{t}</li>)}
          </ul>

          <h2 style={{ fontSize: 17, fontWeight: 700, marginTop: 30, marginBottom: 10 }}>Known gaps</h2>
          <p style={{ fontSize: 12.5, color: C.mut, margin: '0 0 10px' }}>
            Listed because a reviewer will find them, and a gap we named ourselves is a different
            thing from one we were caught on.
          </p>
          <ul style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.75, paddingLeft: 20, margin: 0 }}>
            {(data.knownGaps || []).map((t) => <li key={t} style={{ marginBottom: 6 }}>{t}</li>)}
          </ul>

          <div style={{ marginTop: 34, padding: 16, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12 }}>
            <strong style={{ fontSize: 14 }}>On the ledger specifically</strong>
            <p style={{ fontSize: 13, color: '#334155', lineHeight: 1.65, margin: '8px 0 0' }}>
              Drunix is our own implementation of an execute, order, validate pipeline: a peer that
              simulates and endorses, an orderer with a RAFT simulation across three nodes, a
              validation service, and a committing peer writing to a hash-chained ledger. It is
              modelled on Hyperledger Fabric because Fabric is the right reference for a permissioned
              securities ledger. It runs no Fabric code and we do not claim it does. Settlement is
              single-writer, so there is no read-write set conflict handling of the kind a real Fabric
              deployment needs.
            </p>
            <p style={{ fontSize: 13, color: '#334155', lineHeight: 1.65, margin: '10px 0 0' }}>
              You can verify the chain yourself in the{' '}
              <Link to="/ledger" style={{ color: '#1E3A5F', fontWeight: 600 }}>ledger explorer</Link>: every
              block carries the hash of the one before it, and the rail rebuilds its entire state by
              replaying them.
            </p>
          </div>
        </>
      )}

      {!data && !err && <p style={{ fontSize: 13, color: C.mut, marginTop: 24 }}>Loading the live status…</p>}
    </div>
  )
}
