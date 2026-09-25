import React, { useState, useEffect } from 'react'
import { money } from '../lib/format.js'
import api from '../lib/api.js'
import { useProperties } from '../hooks/useProperties.js'
import { useLocalCache } from '../hooks/useLocalCache.js'

// SOLID: Single Responsibility — Admin flow for layman: Register → Review → Mint
// Simple language, no jargon, clear steps

function SimpleStep({ number, title, active, done }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        background: done ? '#059669' : active ? '#1E3A5F' : '#E5E7EB',
        color: done || active ? 'white' : '#6B7280',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 700,
        flexShrink: 0
      }}>
        {done ? '✓' : number}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: active || done ? '#111827' : '#6B7280' }}>{title}</div>
      </div>
    </div>
  )
}

export default function Admin({ user }) {
  const isOwner = (user?.role || '') === 'Originator'
  const [form, setForm] = useState({
    title: 'Sunrise Heights 2BHK',
    state: 'Maharashtra',
    city: 'Pune',
    pincode: '411045',
    valuationINR: 6000000,
    documentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  })
  const [result, setResult] = useState('')
  const [lastId, setLastId] = useState('')
  const [validationStatus, setValidationStatus] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  
  const { properties, refresh } = useProperties('')
  const { saveProperty, getLastPropertyId } = useLocalCache()

  useEffect(() => {
    const last = getLastPropertyId()
    if (last && !lastId) setLastId(last)
  }, [])

  useEffect(() => {
    if (!lastId) return
    const fetchStatus = async () => {
      try {
        const data = await api.getProperty(lastId)
        const prop = data.property || data
        setValidationStatus(prop.registrarValidationStatus || prop.validationStatus || 'PENDING')
      } catch {
        setValidationStatus('NOT_FOUND')
      }
    }
    fetchStatus()
  }, [lastId])

  const handleRegister = async (e) => {
    if (!isOwner) {
      setResult('Only a Property Owner can list a property. You are logged in as ' + (user?.role || 'unknown') + ' — switch to "Property Owner" on the login page, otherwise the property would wrongly belong to you.')
      return
    }
    e.preventDefault()
    setResult('Creating property... Please wait')
    try {
      const data = await api.registerProperty({
        title: form.title,
        state: form.state,
        city: form.city,
        pincode: form.pincode,
        valuationINR: parseInt(form.valuationINR),
        documentHash: form.documentHash
      })
      
      setLastId(data.assetId)
      setResult(`✓ Property created: ${data.assetId} — Saved to real database (Postgres/GitHub), won't vanish on refresh, visible to investors`)
      
      saveProperty({
        assetId: data.assetId,
        title: form.title,
        location: { state: form.state, city: form.city, pincode: form.pincode },
        valuationINR: parseInt(form.valuationINR),
        status: 'DRAFT',
        registrarValidationStatus: 'PENDING',
        originatorId: user?.identityId || 'originator1'
      })
      
      refresh()
    } catch (err) {
      setResult(`Failed: ${err.message}`)
    }
  }

  const handleValidate = async (decision) => {
    if (!lastId) {
      setResult('Please create or select a property first')
      return
    }
    setResult(`Reviewing property ${lastId.slice(0,16)}... as ${decision}`)
    try {
      const data = await api.validateProperty(lastId, decision)
      setValidationStatus(data.validationStatus || decision)
      setResult(`✓ ${decision}: Property ${data.assetId} is now ${decision} — ${decision === 'VALIDATED' ? 'Ready to create tokens!' : 'Rejected'}`)
      
      saveProperty({
        assetId: data.assetId,
        registrarValidationStatus: decision,
        status: decision === 'VALIDATED' ? 'VALIDATED' : 'REJECTED'
      })
      
      refresh()
    } catch (err) {
      setResult(`Review failed: ${err.message}`)
    }
  }

  const handleMint = async () => {
    if (!lastId) {
      setResult('Please select a property first')
      return
    }
    if (validationStatus !== 'VALIDATED') {
      setResult(`Cannot create tokens — property status is ${validationStatus}, need VALIDATED. Please get it reviewed first.`)
      return
    }
    
    setResult('Creating tokens... Please wait')
    try {
      const data = await api.mintProperty(lastId, 10000)
      setResult(`✓ Created ${data.totalTokens} tokens for ${data.assetId} — Now available in Marketplace for investors to buy`)
      
      saveProperty({
        assetId: data.assetId,
        totalTokens: data.totalTokens,
        status: 'TOKENIZED',
        tokenPrice: data.tokenPrice
      })
      
      refresh()
    } catch (err) {
      setResult(`Failed to create tokens: ${err.message}`)
    }
  }

  const tokenPrice = form.valuationINR ? Math.floor(parseInt(form.valuationINR) / 10000) : 0

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>Manage Properties</h1>
      {!isOwner && (
        <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: 12, marginTop: 12, fontSize: 13, color: '#92400E', lineHeight: 1.5 }}>
          You are logged in as <strong>{user?.role || 'unknown'}</strong>. Listing a property makes you its owner — only Property Owners should list. Switch to <strong>Property Owner</strong> on the login page first.
        </div>
      )}
      <p style={{ color: '#6B7280', fontSize: 14, marginTop: 6, maxWidth: '70ch' }}>
        For property owners: List your property, get it verified, and create tokens for investors.
      </p>

      <div style={{ display: 'flex', gap: 16, marginTop: 20, marginBottom: 24 }}>
        <SimpleStep number={1} title="List Property" active={!lastId} done={!!lastId} />
        <div style={{ width: 40, height: 1, background: '#E5E7EB', marginTop: 14 }}></div>
        <SimpleStep number={2} title="Get Verified" active={lastId && validationStatus !== 'VALIDATED'} done={validationStatus === 'VALIDATED'} />
        <div style={{ width: 40, height: 1, background: '#E5E7EB', marginTop: 14 }}></div>
        <SimpleStep number={3} title="Create Tokens" active={validationStatus === 'VALIDATED'} done={false} />
      </div>
      <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 8, lineHeight: 1.5 }}>
        When tokens are created, all of them start with you (the owner). Investors buy from you — your ownership goes down as they buy.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>1. List Your Property</h3>
          <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Enter basic details — takes 1 minute</p>

          <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Property Name</label>
              <input
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                placeholder="e.g., Sunrise Heights 2BHK"
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '10px 12px',
                  border: '1px solid #E5E7EB',
                  borderRadius: 8,
                  fontSize: 13
                }}
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>City</label>
                <input
                  value={form.city}
                  onChange={e => setForm({ ...form, city: e.target.value })}
                  placeholder="Pune"
                  style={{
                    width: '100%',
                    marginTop: 6,
                    padding: '10px 12px',
                    border: '1px solid #E5E7EB',
                    borderRadius: 8,
                    fontSize: 13
                  }}
                  required
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>State</label>
                <select
                  value={form.state}
                  onChange={e => setForm({ ...form, state: e.target.value })}
                  style={{
                    width: '100%',
                    marginTop: 6,
                    padding: '10px 12px',
                    border: '1px solid #E5E7EB',
                    borderRadius: 8,
                    fontSize: 13,
                    background: 'white'
                  }}
                >
                  <option>Maharashtra</option>
                  <option>Karnataka</option>
                  <option>Goa</option>
                  <option>Gujarat</option>
                </select>
              </div>
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Property Value (₹)</label>
              <input
                type="number"
                value={form.valuationINR}
                onChange={e => setForm({ ...form, valuationINR: e.target.value })}
                placeholder="6000000"
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '10px 12px',
                  border: '1px solid #E5E7EB',
                  borderRadius: 8,
                  fontSize: 13
                }}
                required
              />
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
                {money(parseInt(form.valuationINR) || 0)} • 1 token = ₹{tokenPrice.toLocaleString('en-IN')}
              </div>
            </div>

            <button type="submit" style={{
              width: '100%',
              padding: '12px',
              background: '#1E3A5F',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              marginTop: 8
            }}>
              List Property →
            </button>
          </form>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>2. Get Verified</h3>
            <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Registrar reviews your documents</p>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Select Property</label>
              <select
                value={lastId}
                onChange={e => setLastId(e.target.value)}
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '10px 12px',
                  border: '1px solid #E5E7EB',
                  borderRadius: 8,
                  fontSize: 13,
                  background: 'white'
                }}
              >
                <option value="">Choose property</option>
                {properties.map(p => (
                  <option key={p.assetId} value={p.assetId}>
                    {p.title?.slice(0, 30)} — {p.registrarValidationStatus || p.status}
                  </option>
                ))}
              </select>
              {lastId && (
                <div style={{ fontSize: 11, color: validationStatus === 'VALIDATED' ? '#059669' : '#D97706', marginTop: 6 }}>
                  Status: <strong>{validationStatus || 'Checking...'}</strong>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                onClick={() => handleValidate('VALIDATED')}
                style={{
                  flex: 1,
                  padding: '10px',
                  background: '#059669',
                  color: 'white',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                ✓ Approve
              </button>
              <button
                onClick={() => handleValidate('REJECTED')}
                style={{
                  flex: 1,
                  padding: '10px',
                  background: 'white',
                  color: '#DC2626',
                  border: '1px solid #FECACA',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                ✗ Reject
              </button>
            </div>
          </div>

          <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, borderLeft: '3px solid #1E3A5F' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>3. Create Tokens</h3>
            <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Make it available for investors</p>

            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: 10, marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#065F46' }}>How it works</div>
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4, lineHeight: 1.5 }}>
                Creates 10,000 tokens for your property. Investors can buy from ₹500 each.
              </div>
            </div>

            <button
              onClick={handleMint}
              disabled={validationStatus !== 'VALIDATED'}
              style={{
                width: '100%',
                marginTop: 16,
                padding: '12px',
                background: validationStatus === 'VALIDATED' ? '#059669' : '#9CA3AF',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: validationStatus === 'VALIDATED' ? 'pointer' : 'not-allowed',
                opacity: validationStatus === 'VALIDATED' ? 1 : 0.6
              }}
            >
              {validationStatus === 'VALIDATED' ? '✓ Create Tokens' : `Need Verified Status (${validationStatus || 'none'})`}
            </button>

            {validationStatus !== 'VALIDATED' && lastId && (
              <div style={{ fontSize: 11, color: '#D97706', marginTop: 8, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '8px 10px' }}>
                {validationStatus === 'PENDING' ? 'Waiting for verification — click Approve above' : `Status is ${validationStatus} — need Verified to create tokens`}
              </div>
            )}
          </div>
        </div>
      </div>

      {result && (
        <div style={{
          marginTop: 20,
          background: result.includes('Failed') ? '#FEF2F2' : '#F0FDF4',
          border: `1px solid ${result.includes('Failed') ? '#FECACA' : '#BBF7D0'}`,
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
          color: result.includes('Failed') ? '#991B1B' : '#065F46',
          whiteSpace: 'pre-wrap'
        }}>
          {result}
        </div>
      )}

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
          {showAdvanced ? 'Hide' : 'Show'} Advanced Options
        </button>
      </div>

      {showAdvanced && (
        <div style={{ marginTop: 16, background: '#F9FAFB', border: '1px dashed #E5E7EB', borderRadius: 12, padding: 16 }}>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: '#6B7280' }}>Advanced — For Developers</h4>
          <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>Technical details hidden from layman — only for developers</p>
          <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace', background: 'white', padding: 10, borderRadius: 6, border: '1px solid #E5E7EB' }}>
            Last ID: {lastId || 'none'}<br/>
            Status: {validationStatus || 'none'}<br/>
            Properties: {properties.length}<br/>
            User: {user?.identityId} ({user?.role})
          </div>
          <button onClick={refresh} style={{
            marginTop: 10,
            padding: '6px 12px',
            fontSize: 11,
            border: '1px solid #E5E7EB',
            borderRadius: 6,
            background: 'white',
            cursor: 'pointer'
          }}>
            Refresh Properties
          </button>
        </div>
      )}

      {/* Your Listings — delete rules: DRAFT anytime; TOKENIZED once fully sold. Regulator can remove any. */}
      {user?.role === 'Originator' && properties.filter(pp => pp.originatorId === user.identityId).length > 0 && (
        <div style={{ marginTop: 24, background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Your Listings</h3>
          <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
            Delete a listing anytime while in draft (nothing tokenized), or once it is fully subscribed (all your tokens sold). Investors keep their tokens.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
            {properties.filter(pp => pp.originatorId === user.identityId).map(pp => (
              <div key={pp.assetId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 8, padding: 12 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{pp.title}</div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                    {pp.location?.city || '—'} • {pp.status} • {pp.totalTokens?.toLocaleString?.('en-IN') || pp.totalTokens} tokens
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (!confirm(`Delete listing "${pp.title}"? Investors keep their tokens — only the marketplace listing is removed.`)) return
                    try {
                      await api.deleteProperty(pp.assetId)
                      alert('Listing deleted. Marketplace no longer shows it.')
                      refresh()
                    } catch (e) {
                      alert(e.data?.message || e.message || 'Delete failed')
                    }
                  }}
                  style={{ padding: '7px 12px', background: 'white', color: '#B91C1C', border: '1px solid #FECACA', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
                >
                  Delete Listing
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
