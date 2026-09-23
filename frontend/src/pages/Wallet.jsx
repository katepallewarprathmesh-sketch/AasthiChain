import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'

// SOLID: Single Responsibility — Only wallet display for layman

function SimpleHoldingCard({ holding }) {
  const balance = holding.balance
  const propertyTitle = holding.propertyTitle || balance.assetId?.slice(0, 16) || 'Property'
  const tokenPrice = holding.tokenPrice || 500
  const value = holding.valueINR || (balance.balance * tokenPrice)

  return (
    <div style={{
      background: 'white',
      border: '1px solid #E5E7EB',
      borderRadius: 12,
      padding: 16,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{propertyTitle}</div>
        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
          {(balance.balance || 0).toLocaleString('en-IN')} tokens • ₹{tokenPrice.toLocaleString('en-IN')} each
        </div>
        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2, fontFamily: 'monospace' }}>
          {balance.assetId?.slice(0, 16)}...
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>₹{value.toLocaleString('en-IN')}</div>
        <div style={{ fontSize: 11, color: '#6B7280' }}>Value</div>
        <Link to={`/property/${balance.assetId}`} style={{
          fontSize: 11,
          color: '#1E3A5F',
          textDecoration: 'none',
          fontWeight: 600,
          marginTop: 4,
          display: 'inline-block'
        }}>
          View →
        </Link>
      </div>
    </div>
  )
}

export default function Wallet({ user }) {
  const [wallet, setWallet] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [transferForm, setTransferForm] = useState({ assetId: '', toId: '', amount: '' })
  const [transferMsg, setTransferMsg] = useState('')

  const fetchWallet = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getWallet(user?.identityId || 'investor1')
      setWallet(data)
    } catch (e) {
      setError(e.message)
      setWallet({ balances: [], totalPortfolioValue: 0 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchWallet()
  }, [user?.identityId])

  const handleTransfer = async (e) => {
    e.preventDefault()
    setTransferMsg('')
    try {
      const result = await api.transferTokens(
        transferForm.assetId,
        user?.identityId || 'investor1',
        transferForm.toId,
        parseInt(transferForm.amount)
      )
      setTransferMsg(`✓ Transferred ${result.amount} tokens to ${result.toId} — Success!`)
      setTransferForm({ assetId: '', toId: '', amount: '' })
      fetchWallet()
    } catch (err) {
      setTransferMsg(`Transfer failed: ${err.data?.error || err.message}`)
    }
  }

  const totalValue = wallet?.totalPortfolioValue || 0
  const holdings = wallet?.balances || []

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>My Wallet</h1>
      <p style={{ color: '#6B7280', fontSize: 14, marginTop: 6 }}>
        Your property tokens and portfolio value
      </p>

      <div style={{
        background: 'white',
        border: '1px solid #E5E7EB',
        borderRadius: 12,
        padding: 20,
        marginTop: 20,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div>
          <div style={{ fontSize: 12, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Total Portfolio Value</div>
          <div style={{ fontSize: 32, fontWeight: 800, marginTop: 6, color: '#111827' }}>₹{totalValue.toLocaleString('en-IN')}</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{holdings.length} properties owned</div>
        </div>
        <button onClick={fetchWallet} style={{
          padding: '8px 14px',
          border: '1px solid #E5E7EB',
          borderRadius: 8,
          background: 'white',
          fontSize: 13,
          cursor: 'pointer'
        }}>
          Refresh
        </button>
      </div>

      <div style={{ marginTop: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>My Properties</h3>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{
              width: 32, height: 32,
              border: '3px solid #E5E7EB',
              borderTopColor: '#1E3A5F',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              margin: '0 auto'
            }}></div>
            <p style={{ color: '#6B7280', fontSize: 14, marginTop: 12 }}>Loading your properties...</p>
          </div>
        ) : holdings.length === 0 ? (
          <div style={{
            background: 'white',
            border: '1px solid #E5E7EB',
            borderRadius: 12,
            padding: '40px 20px',
            textAlign: 'center',
            marginTop: 12
          }}>
            <div style={{ fontSize: 32 }}>🏠</div>
            <p style={{ fontSize: 16, fontWeight: 600, marginTop: 12, color: '#111827' }}>No properties yet</p>
            <p style={{ fontSize: 13, color: '#6B7280', marginTop: 6, maxWidth: '40ch', margin: '6px auto 0' }}>
              Start investing from ₹500. Browse properties and buy tokens via UPI.
            </p>
            <Link to="/marketplace" style={{
              display: 'inline-block',
              marginTop: 16,
              padding: '10px 20px',
              background: '#1E3A5F',
              color: 'white',
              textDecoration: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600
            }}>
              Explore Properties →
            </Link>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            {holdings.map((h, i) => (
              <SimpleHoldingCard key={i} holding={h} />
            ))}
          </div>
        )}
      </div>

      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Transfer Tokens</h3>
        <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Send tokens to another person</p>

        <form onSubmit={handleTransfer} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <input
            placeholder="Property ID (e.g., PROP-GREEN-VALLEY-PUNE-001)"
            value={transferForm.assetId}
            onChange={e => setTransferForm({ ...transferForm, assetId: e.target.value })}
            style={{
              padding: '10px 12px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 13
            }}
            required
          />
          <input
            placeholder="Send to (e.g., investor2)"
            value={transferForm.toId}
            onChange={e => setTransferForm({ ...transferForm, toId: e.target.value })}
            style={{
              padding: '10px 12px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 13
            }}
            required
          />
          <input
            type="number"
            placeholder="Amount of tokens"
            value={transferForm.amount}
            onChange={e => setTransferForm({ ...transferForm, amount: e.target.value })}
            style={{
              padding: '10px 12px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 13
            }}
            required
            min="1"
          />
          <button type="submit" style={{
            padding: '12px',
            background: '#1E3A5F',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer'
          }}>
            Transfer Tokens →
          </button>
        </form>

        {transferMsg && (
          <div style={{
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 8,
            fontSize: 13,
            background: transferMsg.includes('failed') ? '#FEF2F2' : '#F0FDF4',
            color: transferMsg.includes('failed') ? '#991B1B' : '#065F46',
            border: `1px solid ${transferMsg.includes('failed') ? '#FECACA' : '#BBF7D0'}`
          }}>
            {transferMsg}
          </div>
        )}
      </div>
    </div>
  )
}
