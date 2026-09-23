// SOLID: Single Responsibility — Only handles buy flow for layman
// Interface Segregation — Small props interface
// Dependency Inversion — Depends on api abstraction

import React, { useState } from 'react'
import api from '../lib/api.js'

export default function SimpleBuyFlow({ assetId, tokenPrice, recipient, user, onSuccess }) {
  const [amount, setAmount] = useState(100)
  const [step, setStep] = useState('idle') // idle, paying, success, error
  const [error, setError] = useState('')
  const [payment, setPayment] = useState(null)

  const total = (amount || 0) * (tokenPrice || 0)

  const handleBuy = async () => {
    setError('')
    setStep('paying')
    
    try {
      // Step 1: Create payment request
      const collectData = await api.initiateCollect({
        assetId,
        tokenAmount: parseInt(amount),
        amountINR: total,
        payerVpa: `${user?.identityId || 'investor1'}@aasthichain`,
        payeeVpa: `${recipient || 'originator1'}@aasthichain`,
        note: `Buy ${amount} tokens of ${assetId}`,
        payerId: user?.identityId || 'investor1',
        payeeId: recipient || 'originator1'
      })
      
      setPayment(collectData)
      
      // Step 2: Approve payment (simulates UPI app approval)
      const approved = await api.approvePayment(collectData.paymentId, user?.identityId || 'investor1')
      setPayment(approved)
      
      // Step 3: Transfer tokens from owner to buyer
      const transfer = await api.transferTokens(assetId, recipient || 'originator1', user?.identityId || 'investor1', parseInt(amount))
      
      // Step 4: Release payment (settlement)
      const released = await api.releasePayment(collectData.paymentId, transfer.transferId)
      setPayment(released)
      
      setStep('success')
      if (onSuccess) onSuccess(released, transfer)
      
    } catch (e) {
      console.error('Buy failed', e)
      setError(e.data?.failureReason || e.message || 'Payment failed — please try again')
      setStep('error')
      
      // Try refund if payment was created
      if (payment?.paymentId) {
        try {
          await api.refundPayment(payment.paymentId, e.message)
        } catch {}
      }
    }
  }

  if (step === 'success' && payment) {
    return (
      <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12, padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>✓</div>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: '#065F46', marginTop: 8 }}>Payment Successful!</h3>
        <p style={{ fontSize: 13, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
          You bought <strong>{amount} tokens</strong> for <strong>₹{total.toLocaleString('en-IN')}</strong><br/>
          Tokens added to your wallet. Payment ref: {(payment.utr || payment.paymentId || '').slice(-6) || '—'}
        </p>
        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
          <a href="/wallet" className="btn btn-primary" style={{ fontSize: 13, textDecoration: 'none', padding: '10px 16px' }}>
            View Wallet →
          </a>
          <button className="btn btn-secondary" style={{ fontSize: 13, padding: '10px 16px' }} onClick={() => { setStep('idle'); setPayment(null); setError('') }}>
            Buy More
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Buy Tokens</h3>
      <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Own a part of this property from ₹500</p>
      
      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>How many tokens?</label>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <input
            type="number"
            min="1"
            max="10000"
            value={amount}
            onChange={e => setAmount(Math.max(1, parseInt(e.target.value) || 1))}
            style={{
              width: 100,
              padding: '10px 12px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600
            }}
          />
          <span style={{ fontSize: 13, color: '#6B7280' }}>tokens = ₹{total.toLocaleString('en-IN')}</span>
        </div>
        
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          {[10, 50, 100, 500].map(num => (
            <button
              key={num}
              onClick={() => setAmount(num)}
              style={{
                padding: '6px 12px',
                borderRadius: 20,
                border: '1px solid #E5E7EB',
                background: amount === num ? '#1E3A5F' : 'white',
                color: amount === num ? 'white' : '#6B7280',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {num}
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: '#F9FAFB', borderRadius: 8, padding: 12, marginTop: 16, border: '1px solid #F3F4F6' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span style={{ color: '#6B7280' }}>Total to pay</span>
          <span style={{ fontWeight: 700, fontSize: 18, color: '#111827' }}>₹{total.toLocaleString('en-IN')}</span>
        </div>
        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
          {amount} tokens × ₹{(tokenPrice || 0).toLocaleString('en-IN')} each
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 10, fontSize: 12, color: '#991B1B' }}>
          {error}
        </div>
      )}

      <button
        onClick={handleBuy}
        disabled={step === 'paying'}
        style={{
          width: '100%',
          marginTop: 16,
          padding: '14px',
          background: step === 'paying' ? '#9CA3AF' : '#1E3A5F',
          color: 'white',
          border: 'none',
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
          cursor: step === 'paying' ? 'not-allowed' : 'pointer'
        }}
      >
        {step === 'paying' ? 'Processing payment...' : `Pay ₹${total.toLocaleString('en-IN')} →`}
      </button>

      <div style={{ fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 10, lineHeight: 1.4 }}>
        🔒 Secure UPI payment • Tokens transferred instantly • No paperwork
      </div>
    </div>
  )
}
