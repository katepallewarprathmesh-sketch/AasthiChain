import React, { useEffect, useState } from 'react'
import { umiFetch as umi } from '../lib/umiFetch'

// Throughput, with the limitation attached.
//
// A settlement system that quotes a throughput figure without saying what
// serialises is not telling you anything, so this panel is built to be read
// in one direction: here is the number, here is the thing that bounds it,
// here is what would move it, and here is what this number is NOT.
//
// Everything shown is measured from traffic this process actually served. We
// deliberately do not run a synthetic loop to produce a bigger figure.

const C = {
  navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  warn: '#B45309', warnBg: '#FFFBEB', ok: '#047857',
}

const n = (v) => Number(v || 0).toLocaleString('en-IN')

function Stat({ label, value, unit, hint }) {
  return (
    <div style={{ minWidth: 'min(100%, 118px)' }}>
      <div style={{ fontSize: 11, color: C.mut, textTransform: 'uppercase', letterSpacing: .4 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 19, color: C.navy, marginTop: 2 }}>
        {value}<span style={{ fontSize: 12, fontWeight: 500, color: C.mut }}>{unit ? ` ${unit}` : ''}</span>
      </div>
      {hint && <div style={{ fontSize: 10.5, color: C.mut, marginTop: 2 }}>{hint}</div>}
    </div>
  )
}

export default function ThroughputPanel() {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)

  const load = async () => {
    // umiFetch answers {ok, status, data}: the payload is under .data.
    try {
      const r = await umi('/throughput')
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

  const lat = d.latencyMs || {}
  const lock = d.lockWaitMs || {}

  return (
    <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>
        10 · Throughput, and the thing that limits it
      </h2>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.mut, maxWidth: 760 }}>
        Measured from settlements this process has actually served, not from a synthetic loop. The engine is a single
        writer by design, so these numbers come with the reason they are what they are.
      </p>

      {!d.measured ? (
        <div style={{ marginTop: 14, fontSize: 13, color: C.mut }}>
          No settlements yet on this process, so there is nothing measured to show. Settle a trade above and this fills in.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 14 }}>
            <Stat label="Settlements" value={n(d.settlements)} hint={`${n(d.settled)} settled · ${n(d.failed)} failed`} />
            <Stat label="Median" value={lat.p50} unit="ms" hint="p50 in the engine" />
            <Stat label="p99" value={lat.p99} unit="ms" hint={`max ${lat.max} ms`} />
            <Stat label="Lock wait" value={lock.mean} unit="ms" hint={`max ${lock.max} ms`} />
            <Stat label="Serial ceiling" value={n(d.serialCeilingPerSecond)} unit="/sec" hint="at this mean latency" />
            <Stat label="Peak observed" value={n(d.peakSettlementsPerSecondObserved)} unit="/sec" hint={`max ${n(d.maxConcurrentWaiters)} queued`} />
          </div>

          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 9,
            background: '#F8FAFC', border: `1px solid ${C.line}`, fontSize: 12.5, color: '#334155',
          }}>
            <strong style={{ color: C.navy }}>Concurrency model: {d.concurrencyModel}.</strong> {d.whySingleWriter}
            <div style={{ marginTop: 6 }}><strong style={{ color: C.navy }}>The cost:</strong> {d.cost}</div>
            <div style={{ marginTop: 6 }}><strong style={{ color: C.navy }}>Reading lock wait:</strong> {d.howToReadLockWait}</div>
          </div>

          <div style={{ marginTop: 10, fontSize: 12.5, color: C.mut }}>
            <strong style={{ color: C.navy }}>What would raise it:</strong> {d.whatWouldRaiseIt}
          </div>
        </>
      )}
    </section>
  )
}
