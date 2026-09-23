import React, { useState, useEffect } from 'react'
import api from '../lib/api.js'

// SOLID: Single Responsibility — Only regulator audit for layman

export default function Regulator({ user }) {
  const [transfers, setTransfers] = useState([])
  const [properties, setProperties] = useState([])
  const [filterAsset, setFilterAsset] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  useEffect(() => {
    fetchAll()
  }, [user?.identityId, filterAsset])

  const fetchAll = async () => {
    try {
      const propData = await api.listProperties()
      setProperties(propData.properties || [])

      const histData = await api.getTransferHistory(filterAsset, '', 10, '')
      setTransfers(histData.transfers || [])
    } catch {}
  }

  const handleFreeze = async (assetId) => {
    const reason = prompt('Why freeze this property? (e.g., fraud detected)')
    if (!reason) return
    if (!confirm(`Freeze ${assetId}? No transfers possible until unfrozen. Reason: ${reason}`)) return
    
    try {
      await api.freezeProperty(assetId, reason)
      alert(`Property frozen: ${assetId}`)
      fetchAll()
    } catch (e) {
      alert(`Freeze failed: ${e.message}`)
    }
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>Audit & Safety</h1>
      <p style={{ color: '#6B7280', fontSize: 14, marginTop: 6, maxWidth: '70ch' }}>
        Monitor all properties and transfers. Freeze if fraud detected.
      </p>

      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>All Properties</h3>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16, maxHeight: 400, overflowY: 'auto' }}>
          {properties.map(p => (
            <div key={p.assetId} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: '#F9FAFB',
              border: '1px solid #F3F4F6',
              borderRadius: 8,
              padding: 14
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{p.title}</div>
                <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
                  {p.location?.city || '—'} • ₹{(p.valuationINR || 0).toLocaleString('en-IN')} • {p.totalTokens || 0} tokens • {p.status}
                </div>
              </div>
              <button
                onClick={() => handleFreeze(p.assetId)}
                style={{
                  padding: '6px 12px',
                  background: 'white',
                  color: '#DC2626',
                  border: '1px solid #FECACA',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Freeze
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Recent Transfers</h3>
          <select
            value={filterAsset}
            onChange={e => setFilterAsset(e.target.value)}
            style={{
              padding: '8px 12px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 13,
              background: 'white'
            }}
          >
            <option value="">All Properties</option>
            {properties.map(p => <option key={p.assetId} value={p.assetId}>{p.title?.slice(0, 20)}</option>)}
          </select>
        </div>

        <div style={{ overflowX: 'auto', marginTop: 16 }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#9CA3AF', borderBottom: '1px solid #F3F4F6', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
                <th style={{ padding: '10px 8px' }}>From → To</th>
                <th style={{ padding: '10px 8px' }}>Tokens</th>
                <th style={{ padding: '10px 8px' }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map(t => (
                <tr key={t.transferId} style={{ borderBottom: '1px solid #F9FAFB' }}>
                  <td style={{ padding: '10px 8px' }}>{t.fromId} → {t.toId}</td>
                  <td style={{ padding: '10px 8px', fontWeight: 600 }}>{t.amount}</td>
                  <td style={{ padding: '10px 8px', color: '#6B7280', fontSize: 12 }}>{new Date(t.txTimestamp).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {transfers.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: '#9CA3AF', fontSize: 13 }}>No transfers yet</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            fontSize: 12,
            color: '#9CA3AF',
            background: 'none',
            border: '1px dashed #E5E7EB',
            padding: '6px 12px',
            borderRadius: 20,
            cursor: 'pointer'
          }}
        >
          {showAdvanced ? 'Hide' : 'Show'} Advanced
        </button>
      </div>

      {showAdvanced && (
        <div style={{ marginTop: 16, background: '#F9FAFB', border: '1px dashed #E5E7EB', borderRadius: 12, padding: 16 }}>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: '#6B7280' }}>Advanced — For Developers</h4>
          <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>Technical audit details</p>
          <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace', background: 'white', padding: 10, borderRadius: 6, border: '1px solid #E5E7EB' }}>
            Total properties: {properties.length}<br/>
            Total transfers: {transfers.length}<br/>
            User: {user?.identityId} ({user?.role})<br/>
            Indexes: idx_transfer_asset_time, idx_balance_asset
          </div>
        </div>
      )}
    </div>
  )
}
