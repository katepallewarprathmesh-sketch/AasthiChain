import React, { useEffect, useState } from 'react'
import { umiFetch as umi } from '../lib/umiFetch'

// Per-path speed, on screen.
//
// ThroughputPanel above measures one path very well: the DvP critical
// section. It is the number a reviewer asks for first, and quoting it for a
// CBDC transfer or a corridor send would be quoting a measurement of
// something else. The rail times each named path separately; this is where
// a person can read those timings without calling the API.
//
// Two rules this panel keeps, because they are the difference between a
// measurement and a boast:
//
//   1. A path with no traffic shows nothing, not a zero. A zero reads like
//      a result. "Not exercised yet" is the truth.
//   2. Refusals are counted and displayed apart from completed work. A
//      refusal returns before anything moves, so folding the two together
//      would make every path look faster than it is.

const C = {
  navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  head: '#F8FAFC', ok: '#047857',
}

const n = (v) => Number(v || 0).toLocaleString('en-IN')

export default function PathSpeedPanel() {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)
  const [open, setOpen] = useState(null)

  const load = async () => {
    try {
      const r = await umi('/pathspeed')
      if (r.ok && r.data && typeof r.data.measured === 'boolean') setD(r.data)
      else setErr(true)
    } catch { setErr(true) }
  }
  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [])

  if (err || !d) return null

  const paths = Object.entries(d.paths || {})
    .filter(([, p]) => (p.calls || 0) > 0)
    .sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0))

  return (
    <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>
        11 &middot; What every other path costs
      </h2>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.mut, maxWidth: 760 }}>
        A digital rupee transfer, a programmable spend and a corridor send do different amounts of work and take
        different locks. Each one is timed where the work happens, below HTTP, on the requests this process has
        really served. {d.refusalsCountedApart}
      </p>

      {paths.length === 0 ? (
        <div style={{ marginTop: 14, fontSize: 13, color: C.mut }}>
          No path has been exercised on this process yet. Move money on the digital rupee page or send over a
          corridor, and the timings appear here. Nothing is shown as zero in the meantime, because a zero would
          read like a measurement.
        </div>
      ) : (
        <div style={{ marginTop: 14, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 640 }}>
            <thead>
              <tr style={{ background: C.head, textAlign: 'left' }}>
                {['Path', 'Completed', 'Refused', 'Median', 'p99', 'Lock wait', 'Serial ceiling'].map((h) => (
                  <th key={h} style={{
                    padding: '7px 9px', fontSize: 10.5, letterSpacing: .4, textTransform: 'uppercase',
                    color: C.mut, fontWeight: 600, borderBottom: `1px solid ${C.line}`,
                    textAlign: h === 'Path' ? 'left' : 'right',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paths.map(([name, p]) => {
                const lat = p.latencyMs || {}
                const lock = p.lockWaitMs || {}
                const isOpen = open === name
                return (
                  <React.Fragment key={name}>
                    <tr
                      onClick={() => setOpen(isOpen ? null : name)}
                      style={{ borderBottom: `1px solid ${C.line}`, cursor: 'pointer' }}
                    >
                      <td style={{ padding: '7px 9px', fontFamily: 'ui-monospace, Menlo, monospace', color: C.navy }}>
                        {name}
                      </td>
                      <td style={{ padding: '7px 9px', textAlign: 'right', color: C.ok, fontWeight: 600 }}>{n(p.completed)}</td>
                      <td style={{ padding: '7px 9px', textAlign: 'right', color: p.refused ? C.navy : C.mut }}>{n(p.refused)}</td>
                      <td style={{ padding: '7px 9px', textAlign: 'right' }}>{lat.p50} ms</td>
                      <td style={{ padding: '7px 9px', textAlign: 'right' }}>{lat.p99} ms</td>
                      <td style={{ padding: '7px 9px', textAlign: 'right', color: C.mut }}>{lock.mean} ms</td>
                      <td style={{ padding: '7px 9px', textAlign: 'right' }}>{n(p.serialCeilingPerSecond)}/s</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={7} style={{ padding: '8px 10px 12px', background: C.head, fontSize: 12.5, color: '#334155' }}>
                          <strong style={{ color: C.navy }}>What this path does:</strong> {p.work}
                          <div style={{ marginTop: 5, color: C.mut }}>
                            {n(p.calls)} requests served &middot; worst case {lat.max} ms &middot; worst lock wait {lock.max} ms.
                            The ceiling is what one writer sustains at this mean latency, not a tested peak.
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 8, fontSize: 11.5, color: C.mut }}>
            Tap a path to see what it actually does.
          </div>
        </div>
      )}

      <div style={{
        marginTop: 14, padding: '10px 12px', borderRadius: 9,
        background: C.head, border: `1px solid ${C.line}`, fontSize: 12, color: '#334155',
      }}>
        <strong style={{ color: C.navy }}>What these numbers are not.</strong> {d.notABenchmark} {d.caveat}
      </div>
    </section>
  )
}
