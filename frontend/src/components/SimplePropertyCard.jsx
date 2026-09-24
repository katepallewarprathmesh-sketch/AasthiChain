// SOLID: Single Responsibility — Only displays property card for layman
// Open/Closed — Open for extension via props, closed for modification
// Liskov — Can be substituted anywhere property card needed

import React from 'react'
import { Link } from 'react-router-dom'

function SimpleStatus({ status, validationStatus }) {
  // Lifecycle status (DRAFT/TOKENIZED/FROZEN) decides the badge — validation
  // only fills the gap. Before: validationStatus shadowed status, so a minted
  // (buyable) property could show "Verified"/"Under Review"/"Coming Soon".
  const statusConfig = {
    'TOKENIZED': { label: 'Available', color: '#059669', bg: '#F0FDF4', border: '#BBF7D0' },
    'VALIDATED': { label: 'Verified', color: '#1E3A5F', bg: '#EFF6FF', border: '#BFDBFE' },
    'PENDING': { label: 'Under Review', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
    'DRAFT': { label: 'Coming Soon', color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB' },
    'FROZEN': { label: 'Paused', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' }
  }
  
  const config = statusConfig[status] || statusConfig[validationStatus] || statusConfig['DRAFT']
  
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 600,
      padding: '4px 10px',
      borderRadius: 20,
      background: config.bg,
      color: config.color,
      border: `1px solid ${config.border}`
    }}>
      {config.label}
    </span>
  )
}

export default function SimplePropertyCard({ property }) {
  const tokenPrice = property.totalTokens ? Math.floor(property.valuationINR / property.totalTokens) : (property.tokenPrice || 500)
  const valuationLakh = ((property.valuationINR || 0) / 100000).toFixed(1)
  const city = property.location?.city || 'Pune'
  const state = property.location?.state || 'Maharashtra'

  return (
    <div className="card" style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      padding: 20,
      borderRadius: 12,
      border: '1px solid #E5E7EB',
      background: 'white',
      transition: 'all 0.2s',
      cursor: 'pointer'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.3, flex: 1, color: '#111827' }}>
          {property.title || 'Untitled Property'}
        </h3>
        <SimpleStatus status={property.status} validationStatus={property.registrarValidationStatus} />
      </div>

      <div style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>📍</span> {city}, {state}
        </div>
      </div>

      <div style={{ background: '#F9FAFB', borderRadius: 10, padding: 14, border: '1px solid #F3F4F6' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Property Value</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: '#111827' }}>₹{valuationLakh}L</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Per Token</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: '#1E3A5F' }}>₹{tokenPrice.toLocaleString('en-IN')}</div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
          Own from ₹500 — {property.totalTokens?.toLocaleString('en-IN') || '—'} tokens total
        </div>
      </div>

      <Link 
        to={`/property/${property.assetId}`} 
        className="btn btn-primary" 
        style={{ 
          textDecoration: 'none', 
          fontSize: 14, 
          fontWeight: 600,
          padding: '12px',
          borderRadius: 8,
          justifyContent: 'center',
          display: 'flex',
          background: '#1E3A5F',
          color: 'white',
          border: 'none'
        }}
      >
        View Details →
      </Link>
    </div>
  )
}
