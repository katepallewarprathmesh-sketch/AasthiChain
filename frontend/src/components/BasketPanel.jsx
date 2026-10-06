import React, { useState } from 'react'
import api from '../lib/api.js'

// Cross-property portfolio tokens, on the investor's dashboard.
//
// A basket unit is not a summary of what someone owns — it is a thing they
// own: one instrument backed by a fixed recipe of property tokens sitting in
// custody. The panel shows the backing rather than just a value, because
// "fully backed" is the only claim that makes a basket worth holding, and an
// under-backed basket must be impossible to mistake for a healthy one.
//
// Subscribing is not a purchase with cash: the subscriber DELIVERS the
// component tokens and receives units. That is the whole reason units can be
// trusted, so the form says what each unit costs in tokens up front and names
// the exact asset that is short when a delivery fails.

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

const btn = (primary, disabled) => ({
  padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
  background: primary ? '#1E3A5F' : 'white',
  color: primary ? 'white' : '#374151',
  border: primary ? 'none' : '1px solid #E5E7EB'
})

const input = {
  width: 72, padding: '7px 9px', border: '1px solid #E5E7EB',
  borderRadius: 8, fontSize: 12, boxSizing: 'border-box'
}

function UnitForm({ label, primary, onRun, busy }) {
  const [units, setUnits] = useState(1)
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        style={input} type="number" min="1" value={units}
        onChange={e => setUnits(e.target.value)}
        aria-label={`${label} units`} disabled={busy}
      />
      <button
        style={btn(primary, busy || Number(units) <= 0)}
        disabled={busy || Number(units) <= 0}
        onClick={() => onRun(Number(units))}
      >
        {busy ? 'Working…' : label}
      </button>
    </div>
  )
}

export default function BasketPanel({ holdings = [], catalogue = [], unavailable, identityId, onChanged }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const held = holdings.filter(h => Number(h.units) > 0)
  const total = held.reduce((s, h) => s + Number(h.valueINR || 0), 0)
  const heldIds = new Set(held.map(h => h.basketId))

  const card = {
    background: 'white', border: '1px solid #E5E7EB', borderRadius: 12,
    padding: 16, marginTop: 16
  }

  const run = async (kind, basketId, units) => {
    setBusy(`${kind}:${basketId}`); setError(''); setDone('')
    try {
      if (kind === 'subscribe') await api.umiBasketSubscribe(basketId, identityId, units)
      else await api.umiBasketRedeem(basketId, identityId, units)
      setDone(kind === 'subscribe'
        ? `Issued ${units} unit${units === 1 ? '' : 's'} against delivered tokens.`
        : `Redeemed ${units} unit${units === 1 ? '' : 's'}; the backing tokens are back in your holdings.`)
      if (onChanged) await onChanged()
    } catch (e) {
      // The rail names the asset that could not be delivered. Keep that —
      // "subscription failed" alone leaves nothing to act on.
      setError(e.message || 'The rail refused that instruction.')
    } finally {
      setBusy('')
    }
  }

  if (unavailable) {
    return (
      <div style={card}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Portfolio baskets</h2>
        <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8, lineHeight: 1.6 }}>
          The settlement rail did not answer, so basket holdings could not be read.
          Any units you hold are unaffected — they live on the rail, not on this page.
        </p>
      </div>
    )
  }

  const recipe = (detail) => (detail?.components || [])
    .map(c => `${c.tokensPerUnit} × ${c.assetId}`).join(' + ')

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Portfolio baskets</h2>
        {held.length > 0 && (
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1E3A5F' }}>{inr(total)}</span>
        )}
      </div>
      <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.6, maxWidth: '68ch' }}>
        One unit is a claim on several properties at once. You create units by delivering
        the underlying tokens into custody, and redeeming gives them back — so every unit
        is backed by something real.
      </p>

      {error && (
        <div style={{
          marginTop: 10, padding: '9px 12px', borderRadius: 8, background: '#FEF2F2',
          border: '1px solid #FECACA', color: '#991B1B', fontSize: 12, lineHeight: 1.5
        }}>{error}</div>
      )}
      {done && !error && (
        <div style={{
          marginTop: 10, padding: '9px 12px', borderRadius: 8, background: '#ECFDF5',
          border: '1px solid #A7F3D0', color: '#065F46', fontSize: 12
        }}>{done}</div>
      )}

      {/* held */}
      {held.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {held.map(h => {
            const detail = catalogue.find(c => c.basketId === h.basketId)
            const backed = detail ? detail.fullyBacked !== false : true
            return (
              <div key={h.basketId} style={{ border: '1px solid #F3F4F6', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{h.name || h.basketId}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{inr(h.valueINR)}</span>
                </div>
                <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 3 }}>
                  {Number(h.units).toLocaleString('en-IN')} unit{Number(h.units) === 1 ? '' : 's'}
                  {' · '}{inr(h.navPerUnitINR)} per unit
                </div>
                {detail?.components?.length > 0 && (
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                    Each unit holds {recipe(detail)}
                  </div>
                )}
                <div style={{
                  marginTop: 6, fontSize: 11, fontWeight: 600,
                  color: backed ? '#065F46' : '#991B1B'
                }}>
                  {backed
                    ? 'Fully backed in custody'
                    : 'Backing short — the rail is holding fewer tokens than these units require'}
                </div>
                <div style={{ marginTop: 9, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <UnitForm label="Create more" primary
                    busy={busy === `subscribe:${h.basketId}`}
                    onRun={(u) => run('subscribe', h.basketId, u)} />
                  <UnitForm label="Redeem"
                    busy={busy === `redeem:${h.basketId}`}
                    onRun={(u) => run('redeem', h.basketId, u)} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* available but not held */}
      {catalogue.filter(c => !heldIds.has(c.basketId)).length > 0 && (
        <div style={{ marginTop: held.length ? 14 : 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Available to create
          </div>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {catalogue.filter(c => !heldIds.has(c.basketId)).map(c => (
              <div key={c.basketId} style={{ border: '1px solid #F3F4F6', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{c.name || c.basketId}</span>
                  <span style={{ fontSize: 12, color: '#6B7280' }}>{inr(c.navPerUnitINR)} per unit</span>
                </div>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 5, lineHeight: 1.6 }}>
                  You deliver {recipe(c) || 'the component tokens'} for each unit.
                </div>
                <div style={{ marginTop: 9 }}>
                  <UnitForm label="Create units" primary
                    busy={busy === `subscribe:${c.basketId}`}
                    onRun={(u) => run('subscribe', c.basketId, u)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {held.length === 0 && catalogue.length === 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: '#6B7280' }}>
          No baskets have been defined on this rail yet.
        </div>
      )}
    </div>
  )
}
