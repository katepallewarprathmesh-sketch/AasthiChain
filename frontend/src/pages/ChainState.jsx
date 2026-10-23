import React, { useCallback, useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost } from '../lib/umiFetch.js'

/**
 * Is the ledger the state, or a description of it?
 *
 * THE QUESTION THIS PAGE ANSWERS
 * Most of this system wrote blocks about things that actually lived in a Go
 * map. That is a log, not a ledger. The difference is invisible from the
 * outside unless somebody does the work of rebuilding the state from the
 * blocks alone and checking that it matches what the system is serving.
 *
 * That is what this page shows. Each module's state is replayed from the
 * committed blocks, with nothing read from the running module's memory, and
 * then compared against what the rail is actually serving. Agreement means
 * the module could be reconstructed from the chain. Disagreement is reported
 * as a failure rather than absorbed, because a projection that cannot fail
 * proves nothing.
 *
 * The honest part is the gap list: each projection names the fields the
 * blocks do not carry, instead of implying there are none.
 */

const num = (v) => Number(v || 0).toLocaleString('en-IN')

function Verdict({ verify, onRecheck, busy }) {
  if (!verify) return null
  const agrees = verify.agrees
  return (
    <Card
      title={agrees ? 'The ledger and the running process agree' : 'The ledger and the running process disagree'}
      sub={'Checked against ' + num(verify.blocksInLedger) + ' committed blocks'}
      right={<Tag tone={agrees ? 'live' : 'bad'}>{agrees ? 'Reconstructable' : num(verify.divergences) + ' divergence(s)'}</Tag>}
      actions={null}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        {(verify.checks || []).map(c => (
          <div key={c.module} className="pg-card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 600 }}>{c.module}</div>
              <Tag tone={c.agrees ? 'live' : 'bad'}>{c.agrees ? 'agrees' : 'diverged'}</Tag>
            </div>
            <div className="pg-kv" style={{ marginTop: 8 }}>
              <div>Being served</div>
              <div>{num(c.liveEntities)}</div>
              <div>Rebuilt from blocks</div>
              <div>{num(c.chainEntities)}</div>
            </div>
            {c.note && <p className="pg-card-sub" style={{ marginTop: 8 }}>{c.note}</p>}
            {(c.divergences || []).map((d, i) => (
              <p key={i} className="pg-card-sub" style={{ marginTop: 6 }}>
                <b>{d.id}</b> · {d.field}: the process says {d.live}, the ledger says {d.chain}
              </p>
            ))}
            {(c.fieldsNotOnChain || []).map((f, i) => (
              <p key={'n' + i} className="pg-card-sub" style={{ marginTop: 6, opacity: 0.85 }}>
                Not on the chain: {f}
              </p>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <button className="pg-btn" disabled={busy} onClick={onRecheck}>{busy ? 'Replaying…' : 'Replay and compare again'}</button>
      </div>
      <p className="pg-card-sub" style={{ marginTop: 12 }}>{verify.whatThisProves}</p>
      <p className="pg-card-sub" style={{ marginTop: 8, opacity: 0.85 }}>{verify.whatThisDoesNotProve}</p>
    </Card>
  )
}

function ProjectionCard({ p }) {
  const [open, setOpen] = useState(false)
  const shown = open ? p.entities : (p.entities || []).slice(0, 5)
  return (
    <Card
      title={p.module + ' rebuilt from the ledger'}
      sub={num(p.blocksConsumed) + ' blocks replayed · ' + num(p.count) + ' entities reconstructed'}
      right={<Tag tone="neutral">{(p.blockTypesConsumed || []).length} block types</Tag>}
    >
      <p className="pg-card-sub">Reads: {(p.blockTypesConsumed || []).join(', ')}</p>
      {!p.count && <p className="pg-card-sub" style={{ marginTop: 10 }}>Nothing of this kind has been committed yet, so the projection is empty rather than wrong.</p>}
      {shown.map(e => (
        <div key={e.id} className="pg-card" style={{ padding: 10, marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{e.id}</span>
            <Tag tone="neutral">{e.status}</Tag>
          </div>
          <div className="pg-card-sub" style={{ marginTop: 4 }}>
            blocks {(e.blocks || []).join(', ')}
          </div>
          <div className="pg-card-sub" style={{ marginTop: 4 }}>
            {Object.entries(e.fields || {}).map(([k, v]) => k + ': ' + v).join(' · ')}
          </div>
        </div>
      ))}
      {(p.entities || []).length > 5 && (
        <div style={{ marginTop: 10 }}>
          <button className="pg-btn pg-btn-ghost" onClick={() => setOpen(o => !o)}>
            {open ? 'Show fewer' : 'Show all ' + num(p.count)}
          </button>
        </div>
      )}
      {(p.fieldsNotOnChain || []).map((f, i) => (
        <p key={i} className="pg-card-sub" style={{ marginTop: 10, opacity: 0.85 }}>
          <b>Cannot be rebuilt:</b> {f}
        </p>
      ))}
    </Card>
  )
}

export default function ChainState() {
  const [verify, setVerify] = useState(null)
  const [projections, setProjections] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [restored, setRestored] = useState(null)

  const load = useCallback(async () => {
    setBusy(true)
    const v = await umiFetch('/chainstate/verify')
    if (v.ok) setVerify(v.data); else setErr((v.data && v.data.message) || 'Could not run the comparison.')
    const p = await umiFetch('/chainstate')
    if (p.ok) setProjections((p.data && p.data.projections) || [])
    setBusy(false)
  }, [])

  useEffect(() => { load() }, [load])

  const restore = async () => {
    setBusy(true)
    const { ok, data } = await umiPost('/chainstate/restore', {})
    setBusy(false)
    setRestored(ok ? data : { restored: 0, note: (data && data.message) || 'Refused.' })
    load()
  }

  return (
    <PageShell
      eyebrow="Chain-first state"
      title="Is the ledger the state, or a story about it?"
      lede="Writing a block about something that lives in a Go map is a log, not a ledger, and from the outside the two look identical. This page rebuilds each module's state by replaying the committed blocks, reads nothing from the running module's memory, and then checks the two against each other. Where the blocks cannot rebuild a field, the projection says which field rather than pretending otherwise."
      badge={<Tag tone="live">Replayed live, not cached</Tag>}
    >
      {err && <div className="pg-card pg-empty">{err}</div>}
      <Verdict verify={verify} onRecheck={load} busy={busy} />

      <Card title="Recover the book from the ledger" sub="What a restart would do: rebuild the offer book from blocks instead of starting empty.">
        <p className="pg-card-sub">
          The secondary market book used to exist only in memory. A listing was made, the process held it, and
          nothing on the ledger recorded that it had happened at all. Listing, taking and withdrawing now each
          commit a block, which means the book can be rebuilt. The rail does this at boot; this button runs it
          again on demand.
        </p>
        <div style={{ marginTop: 12 }}>
          <button className="pg-btn" disabled={busy} onClick={restore}>Rebuild the book from blocks</button>
        </div>
        {restored && (
          <p className="pg-card-sub" style={{ marginTop: 10 }}>
            <b>{num(restored.restored)} rebuilt.</b> {restored.note}
          </p>
        )}
      </Card>

      {projections.map(p => <ProjectionCard key={p.module} p={p} />)}

      <Card title="What this does not claim">
        <p className="pg-card-sub">
          Three modules are projected here. The rest of the rail still keeps state the chain does not fully
          carry, and this page deliberately does not list those as passing. The maps have not gone away
          either: they remain as caches, because the read path should not walk the whole chain on every
          request. What changed is which one is authoritative. The projection is derived from blocks, the
          served state is checked against it, and a disagreement is reported as a failure instead of being
          quietly absorbed.
        </p>
      </Card>
    </PageShell>
  )
}
