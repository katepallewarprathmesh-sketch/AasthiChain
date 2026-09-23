import React, { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useProperty } from '../hooks/useProperties.js'
import SimpleBuyFlow from '../components/SimpleBuyFlow.jsx'
import api from '../lib/api.js'

export default function PropertyDetail({ user }) {
  const { id } = useParams()
  const { property, loading, error, refresh } = useProperty(id)
  const [balances, setBalances] = useState([])
  const [showBuy, setShowBuy] = useState(false)

  useEffect(() => {
    if (!property) return
    const fetchBalances = async () => {
      const owners = ['originator1', 'investor1', 'investor2']
      const results = []
      for (const owner of owners) {
        try {
          const b = await api.getBalance(property.assetId, owner)
          if (b.balance > 0) results.push(b)
        } catch {}
      }
      setBalances(results)
    }
    fetchBalances()
  }, [property?.assetId])

  if (loading && !property) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{
          width: 32, height: 32,
          border: '3px solid #E5E7EB',
          borderTopColor: '#1E3A5F',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
          margin: '0 auto'
        }}></div>
        <p style={{ color: '#6B7280', fontSize: 14, marginTop: 12 }}>Loading property details...</p>
      </div>
    )
  }

  if (error && !property) {
    return (
      <div style={{ padding: 20, maxWidth: 600, margin: '0 auto' }}>
        <Link to="/marketplace" style={{ fontSize: 13, color: '#1E3A5F', textDecoration: 'none' }}>← Back to Properties</Link>
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: 20, marginTop: 16, textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: '#991B1B' }}>{error}</p>
          <button onClick={refresh} style={{
            marginTop: 12,
            padding: '8px 16px',
            background: '#1E3A5F',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer'
          }}>
            Try Again
          </button>
        </div>
      </div>
    )
  }

  if (!property) return null

  const tokenPrice = property.totalTokens ? Math.floor(property.valuationINR / property.totalTokens) : 500
  const valuationLakh = ((property.valuationINR || 0) / 100000).toFixed(1)
  const totalHeld = balances.reduce((s, b) => s + (b.balance || 0), 0)
  const soldPct = property.totalTokens ? Math.round((totalHeld / property.totalTokens) * 100) : 0

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 16px' }}>
      <Link to="/marketplace" style={{ fontSize: 13, color: '#1E3A5F', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
        ← Back to Properties
      </Link>

      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>{property.title}</h1>
          <p style={{ color: '#6B7280', fontSize: 13, marginTop: 6 }}>
            📍 {property.location?.city || 'Pune'}, {property.location?.state || 'Maharashtra'} • Listed by {property.originatorId || 'Owner'}
          </p>
        </div>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          padding: '6px 12px',
          borderRadius: 20,
          background: property.status === 'TOKENIZED' ? '#F0FDF4' : '#FFFBEB',
          color: property.status === 'TOKENIZED' ? '#059669' : '#D97706',
          border: `1px solid ${property.status === 'TOKENIZED' ? '#BBF7D0' : '#FDE68A'}`
        }}>
          {property.status === 'TOKENIZED' ? 'Available' : property.registrarValidationStatus || property.status}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 24 }}>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Property Value</h3>
          <div style={{ fontSize: 32, fontWeight: 800, marginTop: 12, color: '#111827' }}>₹{valuationLakh}L</div>
          <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>₹{(property.valuationINR || 0).toLocaleString('en-IN')} total value</div>

          <div style={{ height: 1, background: '#F3F4F6', margin: '20px 0' }}></div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Total Tokens</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{(property.totalTokens || 0).toLocaleString('en-IN')}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Price Per Token</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, color: '#1E3A5F' }}>₹{tokenPrice.toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: '#6B7280' }}>{soldPct}% owned</span>
              <span style={{ color: '#6B7280' }}>{totalHeld.toLocaleString('en-IN')} / {(property.totalTokens || 0).toLocaleString('en-IN')}</span>
            </div>
            <div style={{ height: 8, background: '#F3F4F6', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${soldPct}%`, height: '100%', background: '#1E3A5F', borderRadius: 4 }}></div>
            </div>
          </div>

          {!showBuy ? (
            <button
              onClick={() => setShowBuy(true)}
              style={{
                width: '100%',
                marginTop: 20,
                padding: '14px',
                background: '#1E3A5F',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Buy Tokens →
            </button>
          ) : (
            <button
              onClick={() => setShowBuy(false)}
              style={{
                width: '100%',
                marginTop: 20,
                padding: '10px',
                background: 'white',
                color: '#6B7280',
                border: '1px solid #E5E7EB',
                borderRadius: 8,
                fontSize: 13,
                cursor: 'pointer'
              }}
            >
              Hide Buy Options
            </button>
          )}

          <div style={{ fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 10 }}>
            🔒 Secure payment • Instant transfer • No paperwork
          </div>
        </div>

        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Who Owns This?</h3>
          <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>Current token holders</p>

          {balances.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: '#6B7280' }}>
              <div style={{ fontSize: 24 }}>👥</div>
              <p style={{ fontSize: 13, marginTop: 8 }}>No investors yet</p>
              <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>Be the first to invest</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              {balances.map(b => {
                const pct = property.totalTokens ? ((b.balance / property.totalTokens) * 100).toFixed(1) : 0
                return (
                  <div key={b.ownerId} style={{
                    background: '#F9FAFB',
                    border: '1px solid #F3F4F6',
                    borderRadius: 8,
                    padding: 12,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{b.ownerId}</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>{(b.balance || 0).toLocaleString('en-IN')} tokens</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{pct}%</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>₹{((b.balance || 0) * tokenPrice).toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {showBuy && (
        <div style={{ marginTop: 20 }}>
          <SimpleBuyFlow
            assetId={property.assetId}
            tokenPrice={tokenPrice}
            recipient={property.originatorId}
            user={user}
            onSuccess={() => {
              setTimeout(() => window.location.reload(), 1500)
            }}
          />
        </div>
      )}
    </div>
  )
}
