import React, { useEffect, useState } from 'react'
import { umiFetch as umi } from '../lib/umiFetch'

// Private data collections, shown the way they should be judged.
//
// The interesting claim is not "we store KYC safely", it is "the chain can
// prove a record exists and has not changed without being able to read it".
// So the panel shows the policy, the counts, and the one line that says what
// is structurally real here and what is not.

const C = {
  navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  warnBg: '#FFFBEB', warn: '#B45309', ok: '#047857',
}

export default function PrivateDataPanel() {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let live = true
    // umiFetch answers {ok, status, data}. A rail that does not have this
    // route yet answers 404 with a JSON error, so the shape is checked too:
    // rendering a table of nothing is worse than rendering nothing.
    umi('/private/collections')
      .then((r) => {
        if (!live) return
        if (r.ok && r.data && Array.isArray(r.data.collections)) setD(r.data)
        else setErr(true)
      })
      .catch(() => { if (live) setErr(true) })
    return () => { live = false }
  }, [])

  if (err || !d) return null
  const rows = (d.stats && d.stats.collections) || []
  const defs = d.collections || []
  const defFor = (name) => defs.find((c) => c.name === name) || {}

  return (
    <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>
        11 · Private data collections
      </h2>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.mut, maxWidth: 780 }}>
        Members hold the value. The chain holds the hash of the key and the hash of the value, so the network can
        agree a record exists, agree it has not changed, and order it against every settlement, without being able
        to read it. Anyone holding a copy can check it against the chain.
      </p>

      <div style={{ overflowX: 'auto', marginTop: 14 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: C.mut }}>
              <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.line}` }}>Collection</th>
              <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.line}` }}>Members</th>
              <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.line}` }}>Also readable by</th>
              <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.line}` }}>Retention</th>
              <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.line}` }}>Records</th>
              <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.line}` }}>Values held</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const def = defFor(r.collection)
              const extra = [def.ownerReads ? 'the subject' : null, def.partiesRead ? 'named parties' : null]
                .filter(Boolean).join(', ') || 'nobody else'
              return (
                <tr key={r.collection}>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}`, fontWeight: 600, color: C.navy }}>
                    {r.collection}
                    <div style={{ fontWeight: 400, color: C.mut, fontSize: 11.5, maxWidth: 320 }}>{def.description}</div>
                  </td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>{(r.memberRoles || []).join(', ')}</td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>{extra}</td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>
                    {r.blockToLive > 0 ? `purge after ${r.blockToLive} blocks` : 'kept'}
                  </td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>{r.records}</td>
                  <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.line}` }}>
                    {r.valuesHeld}{r.valuesPurged ? ` (${r.valuesPurged} purged)` : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{
        marginTop: 14, padding: '10px 12px', borderRadius: 9,
        background: C.warnBg, border: '1px solid #FDE68A', fontSize: 12.5, color: '#78350F',
      }}>
        <strong style={{ color: C.warn }}>What is real and what is not.</strong> {d.limitation}
      </div>

      <div style={{ marginTop: 10, fontSize: 11.5, color: C.mut }}>
        Check a record yourself: <code>POST /api/umi/private/{'{collection}'}/{'{key}'}/verify</code> with the copy you
        hold. The hash is the SHA-256 of the value serialised as JSON with sorted keys.
      </div>
    </section>
  )
}
