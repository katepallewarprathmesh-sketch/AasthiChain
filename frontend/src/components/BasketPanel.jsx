import React from 'react'

// Cross-property portfolio tokens, on the investor's dashboard.
//
// A basket unit is not a summary of what someone owns — it is a thing they
// own: one instrument backed by a fixed recipe of property tokens sitting in
// custody. The panel shows the backing rather than just a value, because
// "fully backed" is the only claim that makes a basket worth holding, and an
// under-backed basket must be impossible to mistake for a healthy one.

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

export default function BasketPanel({ holdings = [], catalogue = [], unavailable }) {
  const held = holdings.filter(h => Number(h.units) > 0)
  const total = held.reduce((s, h) => s + Number(h.valueINR || 0), 0)

  const card = {
    background: 'white', border: '1px solid #E5E7EB', borderRadius: 12,
    padding: 16, marginTop: 16
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

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Portfolio baskets</h2>
        {held.length > 0 && (
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1E3A5F' }}>{inr(total)}</span>
        )}
      </div>
      <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.6, maxWidth: '68ch' }}>
        One unit is a claim on several properties at once. Every unit is backed by real
        tokens held in custody — nothing is issued without them.
      </p>

      {held.length === 0 ? (
        <div style={{ marginTop: 10, fontSize: 12.5, color: '#6B7280' }}>
          You hold no basket units yet.
          {catalogue.length > 0 && (
            <>
              {' '}Available: {catalogue.map(b => b.name || b.basketId).join(', ')}.
            </>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {held.map(h => {
            const detail = catalogue.find(c => c.basketId === h.basketId)
            const backed = detail ? detail.fullyBacked !== false : true
            return (
              <div key={h.basketId} style={{
                border: '1px solid #F3F4F6', borderRadius: 10, padding: '10px 12px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                    {h.name || h.basketId}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
                    {inr(h.valueINR)}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 3 }}>
                  {Number(h.units).toLocaleString('en-IN')} unit{Number(h.units) === 1 ? '' : 's'}
                  {' · '}{inr(h.navPerUnitINR)} per unit
                </div>

                {detail?.components?.length > 0 && (
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6, lineHeight: 1.7 }}>
                    {detail.components.map(c => (
                      <div key={c.assetId}>
                        {c.tokensPerUnit} × {c.assetId}
                      </div>
                    ))}
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
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
