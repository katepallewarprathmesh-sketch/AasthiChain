import React, { useState, useEffect } from 'react'
import { money } from '../lib/format.js'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useLocalCache } from '../hooks/useLocalCache.js'

// SOLID: Single Responsibility Only wallet display + transfer for layman

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
        {holding.fromDevice && (
          <div style={{ fontSize: 10, color: '#92400E', marginTop: 2 }}>
            syncing to cloud…
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>{money(value)}</div>
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

// Layman-friendly transfer error messages (Open/Closed: add new codes to the map)
const TRANSFER_ERRORS = {
  ERR_BALANCE_NOT_FOUND: 'We could not find your tokens on the server just now. Tap Refresh and try again in a few seconds.',
  ERR_INSUFFICIENT_BALANCE: 'Not enough tokens for that amount. Check how many you own above.',
  ERR_ASSET_FROZEN: 'This property is temporarily frozen by the regulator. Transfers are paused.',
  ERR_ASSET_NOT_FOUND: 'Property not found. Tap Refresh and try again.',
  ERR_INVALID_TRANSFER: 'You cannot send tokens to yourself.',
  ERR_KYC_NOT_VERIFIED: 'The person receiving has not finished verification. Try sending to investor2.'
}

export default function Wallet({ user }) {
  const { loadHoldings, adjustHolding, syncHoldingFromServer } = useLocalCache()
  const [wallet, setWallet] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [transferForm, setTransferForm] = useState({ assetId: '', toId: '', amount: '' })
  const [transferMsg, setTransferMsg] = useState('')

  const identityId = user?.identityId || 'investor1'

  const fetchWallet = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getWallet(identityId)
      // Merge server holdings with local receipts a cold server instance may not
      // have balances yet, but your verified purchases on this device still count
      const local = loadHoldings(identityId)
      const byAsset = {}
      ;(data.balances || []).forEach(b => { byAsset[b.balance.assetId] = b })
      Object.keys(local).forEach(assetId => {
        const h = local[assetId]
        if (!h || !(h.balance > 0)) return
        if (byAsset[assetId]) {
          if ((byAsset[assetId].balance?.balance || 0) < h.balance) {
            byAsset[assetId] = {
              ...byAsset[assetId],
              balance: { ...byAsset[assetId].balance, balance: h.balance },
              valueINR: (h.tokenPrice || byAsset[assetId].tokenPrice || 0) * h.balance,
              fromDevice: true
            }
          } else {
            // Server authoritative sync local down
            syncHoldingFromServer(identityId, assetId, byAsset[assetId].balance?.balance || 0)
          }
        } else {
          byAsset[assetId] = {
            balance: { docType: 'balance', assetId, ownerId: identityId, balance: h.balance },
            propertyTitle: h.title || assetId.slice(0, 16),
            tokenPrice: h.tokenPrice || 0,
            valueINR: (h.tokenPrice || 0) * h.balance,
            fromDevice: true
          }
        }
      })
      const merged = Object.values(byAsset)
      const total = merged.reduce((s, b) => s + (b.valueINR || 0), 0)
      setWallet({ ...data, balances: merged, totalPortfolioValue: total })
    } catch (e) {
      setError(e.message)
      setWallet({ balances: [], totalPortfolioValue: 0 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchWallet()
  }, [identityId])

  const handleTransfer = async (e) => {
    e.preventDefault()
    setTransferMsg('')
    const amount = parseInt(transferForm.amount)
    const local = loadHoldings(identityId)
    const h = local[transferForm.assetId]
    const holding = (wallet?.balances || []).find(b => b.balance.assetId === transferForm.assetId)
    const effectiveBalance = Math.max(holding?.balance?.balance || 0, h?.balance || 0)

    if (amount > effectiveBalance) {
      setTransferMsg(`You own ${effectiveBalance} tokens of this property you cannot send ${amount}.`)
      return
    }

    try {
      const result = await api.transferTokens(
        transferForm.assetId,
        identityId,
        transferForm.toId.trim(),
        amount,
        {
          claimedBalance: effectiveBalance,
          property: h ? {
            assetId: transferForm.assetId,
            title: h.title,
            valuationINR: h.valuationINR,
            totalTokens: h.totalTokens,
            originatorId: h.originatorId,
            status: 'TOKENIZED',
            registrarValidationStatus: 'VALIDATED'
          } : undefined,
          receipts: (h?.receipts || []).map(r => ({
            paymentId: r.paymentId,
            assetId: transferForm.assetId,
            payerId: r.payerId,
            tokenAmount: r.tokenAmount,
            amountINR: r.amountINR,
            status: r.status,
            upiTxnId: r.upiTxnId,
            createdAt: r.createdAt
          }))
        }
      )
      // Move local overlay down so the next screen agrees
      adjustHolding(identityId, transferForm.assetId, -amount)
      setTransferMsg(`✓ Sent ${result.amount} tokens to ${result.toId} done!`)
      setTransferForm({ assetId: '', toId: '', amount: '' })
      fetchWallet()
    } catch (err) {
      const code = err.data?.error || ''
      const friendly = TRANSFER_ERRORS[code] || TRANSFER_ERRORS[Object.keys(TRANSFER_ERRORS).find(k => code.startsWith(k))] || err.message
      setTransferMsg(friendly)
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
          <div style={{ fontSize: 32, fontWeight: 800, marginTop: 6, color: '#111827' }}>{money(totalValue)}</div>
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

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 10, fontSize: 12, color: '#991B1B', marginTop: 12 }}>
          {error}
        </div>
      )}

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
          {holdings.length > 0 ? (
            <select
              value={transferForm.assetId}
              onChange={e => setTransferForm({ ...transferForm, assetId: e.target.value })}
              style={{
                padding: '10px 12px',
                border: '1px solid #E5E7EB',
                borderRadius: 8,
                fontSize: 13,
                background: 'white'
              }}
              required
            >
              <option value="">Which property?</option>
              {holdings.map((h, i) => (
                <option key={i} value={h.balance.assetId}>
                  {h.propertyTitle} you own {(h.balance.balance || 0).toLocaleString('en-IN')}
                </option>
              ))}
            </select>
          ) : (
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
          )}
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
          {transferMsg && (
            <div style={{
              background: transferMsg.startsWith('✓') ? '#F0FDF4' : '#FEF2F2',
              border: `1px solid ${transferMsg.startsWith('✓') ? '#BBF7D0' : '#FECACA'}`,
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              color: transferMsg.startsWith('✓') ? '#065F46' : '#991B1B',
              lineHeight: 1.5
            }}>
              {transferMsg}
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
