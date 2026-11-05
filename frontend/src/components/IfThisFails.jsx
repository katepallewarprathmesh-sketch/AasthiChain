import React, { useEffect, useState } from 'react'
import { umiFetch, umiPost } from '../lib/umiFetch.js'
import { colour } from '../lib/tokens.js'

/**
 * "If this fails": the claim waterfall for one property, on the page where
 * somebody is deciding whether to buy it.
 *
 * WHY IT IS HERE AND NOT BURIED IN A RISK PAGE
 * Every platform answers this question somewhere no buyer reads. The
 * information a person most needs is what happens when it goes wrong, and it
 * is reliably the information placed furthest from the buy button. So this
 * sits in the body of the property page, in the same type as everything else.
 *
 * WHAT IT IS NOT
 * Not a warning box. A red panel is a decoration that teaches people to skip
 * it, and it also lets a platform feel it has disclosed something. This is a
 * plain section stating an order of payment and a number. The number is
 * currently zero for every asset on this rail, which is the honest answer and
 * the reason the section is worth having: a reader can see the structure, see
 * that none of it is funded, and draw the obvious conclusion.
 *
 * Data comes from /umi/recourse (recourse.go). The verdict sentence is the
 * rail's, not the screen's, so a reader and an auditor see the same words.
 */

const TRIGGERS = [
  { id: 'ISSUER_DEFAULT', label: 'The issuer defaults' },
  { id: 'ASSET_IMPAIRMENT', label: 'The property is revalued down' },
  { id: 'ATTESTATION_WITHDRAWN', label: 'The attestation is withdrawn' },
  { id: 'CUSTODIAN_FAILURE', label: 'The custodian fails' },
]

export default function IfThisFails({ assetId, holder }) {
  const [terms, setTerms] = useState(null)
  const [trigger, setTrigger] = useState('ISSUER_DEFAULT')
  const [sim, setSim] = useState(null)
  const [simErr, setSimErr] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    if (!assetId) return undefined
    umiFetch(`/recourse/${encodeURIComponent(assetId)}`)
      .then(r => { if (alive && r.ok) setTerms(r.data && r.data.terms) })
      .catch(() => { /* leave the section absent rather than show a broken one */ })
    return () => { alive = false }
  }, [assetId])

  // The simulation needs a holder, so it is only offered to somebody who
  // holds something. Showing a stranger a recovery of zero would be true and
  // useless: their recovery is zero because they own nothing, not because
  // nothing is funded, and conflating the two would misinform them.
  const runSim = async () => {
    if (!holder) return
    setBusy(true); setSimErr(null)
    try {
      const r = await umiPost('/recourse/simulate', { assetId, trigger, holder })
      if (r.ok) { setSim(r.data && r.data.simulation); setSimErr(null) }
      else { setSim(null); setSimErr((r.data && r.data.message) || 'The rail could not run that.') }
    } catch {
      setSim(null); setSimErr('The rail did not answer.')
    } finally { setBusy(false) }
  }

  if (!terms) return null

  const ranks = terms.claimPriority || []
  const triggers = terms.triggers || []
  const gaps = terms.gapsInTheseTerms || []
  const funded = ranks.filter(r => r.funding && r.funding !== 'none').length

  return (
    <section style={{ marginTop: 28 }} data-testid="if-this-fails">
      <h3 style={{ fontSize: 17, fontWeight: 650, margin: '0 0 4px' }}>If this fails</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.65, color: '#4B5563', maxWidth: 680 }}>
        The order in which claims would be paid, and where the money would come from. A rank is counted
        as funded only when it names a pot this ledger can see.{' '}
        {funded === 0
          ? 'None of these do, so a holder of this property would recover nothing. That is the position today, stated rather than left to be discovered.'
          : `${funded} of ${ranks.length} ranks name a pot this ledger can see.`}
      </p>

      {/* The waterfall. */}
      <ol style={{ listStyle: 'none', margin: '0 0 16px', padding: 0, display: 'grid', gap: 8 }}>
        {ranks.map(r => (
          <li
            key={r.rank}
            style={{
              display: 'grid', gridTemplateColumns: 'minmax(min(100%, 22px), 28px) 1fr auto',
              gap: 12, alignItems: 'start', border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px 12px',
            }}
          >
            <div className="pg-mono" style={{ fontSize: 12, color: colour.inkMuted, paddingTop: 1 }}>{r.rank}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: colour.ink }}>{r.claimant}</div>
              <div style={{ fontSize: 12.5, color: colour.inkMuted, lineHeight: 1.55, marginTop: 2 }}>{r.remedy}</div>
            </div>
            <div
              className="pg-mono"
              style={{
                fontSize: 11, whiteSpace: 'nowrap', paddingTop: 2,
                color: r.funding && r.funding !== 'none' ? colour.good : colour.bad,
              }}
            >
              {r.funding && r.funding !== 'none' ? r.funding : 'unfunded'}
            </div>
          </li>
        ))}
      </ol>

      {/* What would have to happen for any of it to start. */}
      <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
        {triggers.map(t => (
          <div key={t.id} style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.6 }}>
            <span style={{ color: colour.ink, fontWeight: 600 }}>{t.test}</span>{' '}
            {t.observableOnThisRail
              ? <span>Visible on this rail. Declared by {t.declaredBy}.</span>
              : <span>Not visible on this rail, and nobody here may declare it, so it can happen without anything following.</span>}
          </div>
        ))}
      </div>

      {/* The personal number, for somebody who actually holds this. */}
      {holder && (
        <div style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: '12px 13px', marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label htmlFor="recourse-trigger" style={{ fontSize: 12.5, color: '#4B5563' }}>What would I recover if</label>
            <select
              id="recourse-trigger"
              value={trigger}
              onChange={e => { setTrigger(e.target.value); setSim(null) }}
              style={{ fontSize: 12.5, padding: '5px 8px', borderRadius: 8, border: '1px solid #D1D5DB', minWidth: 'min(100%, 220px)' }}
            >
              {TRIGGERS.map(t => <option key={t.id} value={t.id}>{t.label.toLowerCase()}</option>)}
            </select>
            <button type="button" className="pg-btn" onClick={runSim} disabled={busy}>
              {busy ? 'Working' : 'Work it out'}
            </button>
          </div>

          {simErr && <p style={{ margin: '10px 0 0', fontSize: 12.5, color: colour.bad }}>{simErr}</p>}

          {sim && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 650, color: colour.ink, fontVariantNumeric: 'tabular-nums' }}>
                {sim.recoveryINR}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.65, color: '#374151' }}>{sim.verdict}</p>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: colour.inkMuted }}>
                On {sim.holderTokens} of {sim.tokensOutstanding} tokens ({sim.holderSharePercent}).
                Pool available: {sim.recoverablePoolSource}
              </p>
            </div>
          )}
        </div>
      )}

      {/* The terms state their own gaps. Computed by the rail, not written here. */}
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, color: colour.inkMuted }}>
        {gaps.map((g, i) => <li key={i}>{g}</li>)}
      </ul>
      <p style={{ margin: '10px 0 0', fontSize: 11.5, color: colour.inkFaint, lineHeight: 1.6, maxWidth: 680 }}>
        {terms.jurisdiction} {terms.vehicle}
      </p>
    </section>
  )
}
