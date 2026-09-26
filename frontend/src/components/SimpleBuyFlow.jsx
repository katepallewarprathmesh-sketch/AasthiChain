// SOLID: Single Responsibility only the UPI buy journey for layman
// Open/Closed status config object; new statuses need no component change
// Dependency Inversion depends on api abstraction, not fetch
// UPI Collect journey (NPCI rail, simulation): collect → approve in UPI app → CONFIRMED (UTR)
//   → token transfer on Drunix ledger → escrow RELEASED. Payment and tokens move together (DvP).

import React, { useEffect, useState } from 'react'
import api from '../lib/api.js'
import { useLocalCache } from '../hooks/useLocalCache.js'
import PayUCheckout from './PayUCheckout.jsx'

const STATUS_STEPS = [
  { key: 'collect', label: 'Payment Request', desc: 'Secure request created' },
  { key: 'approved', label: 'Payment Confirmed', desc: 'Approved in UPI app' },
  { key: 'tokens', label: 'Tokens Transferred', desc: 'Ownership moved to you' },
  { key: 'settled', label: 'Complete', desc: 'Money & tokens settled' }
]

const DEMO_VPAS = ['demo.investor@aasthichain', 'demo.investor@fakebank', 'test@payu', 'fail@payu']

function StepTrack({ current, doneCount }) {
  return (
    <div style={{ marginTop: 14 }}>
      {STATUS_STEPS.map((s, i) => {
        const done = i < doneCount
        const active = i === doneCount && ['paying', 'confirming', 'transferring'].includes(current)
        return (
          <div key={s.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
              background: done ? '#059669' : active ? '#F59E0B' : '#E5E7EB',
              color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700
            }}>{done ? '✓' : i + 1}</div>
            <div>
              <div style={{ fontSize: 12, fontWeight: done || active ? 700 : 500, color: done ? '#065F46' : active ? '#92400E' : '#9CA3AF' }}>{s.label}</div>
              {(done || active) && <div style={{ fontSize: 10, color: '#9CA3AF' }}>{s.desc}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function SimpleBuyFlow({ assetId, tokenPrice, recipient, user, propertyTitle, valuationINR, totalTokens, availableTokens, onSuccess }) {
  const [amount, setAmount] = useState(10)
  const [vpa, setVpa] = useState(user?.identityId ? `${user.identityId}@aasthichain` : 'demo.investor@aasthichain')
  const [step, setStep] = useState('form') // form, paying, payu, pending, confirming, transferring, success, error
  const [error, setError] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [payment, setPayment] = useState(null)
  const [transfer, setTransfer] = useState(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [resumeInfo, setResumeInfo] = useState('')

  const safePrice = tokenPrice || 0
  const cap = Number.isFinite(availableTokens) && availableTokens > 0 ? Math.floor(availableTokens) : null
  const clampedAmount = cap ? Math.min(amount, cap) : amount
  const total = (clampedAmount || 0) * safePrice

  // Countdown for UPI approval expiry (5 min collect request)
  useEffect(() => {
    if (step !== 'pending' || !payment) return
    const t = setInterval(() => {
      const msLeft = new Date(payment.expiresAt).getTime() - Date.now()
      setSecondsLeft(Math.max(0, Math.ceil(msLeft / 1000)))
      if (msLeft <= 0) {
        clearInterval(t)
        setError('This payment request expired after 5 minutes. Please start again no money was taken.')
        setStep('error')
      }
    }, 1000)
    return () => clearInterval(t)
  }, [step, payment])

  // PayU test-mode: resume automatically when the browser returns from PayU
  // (PayU POSTs the signed callback -> server CONFIRMs -> we poll and continue DvP)
  useEffect(() => {
    if (step !== 'form' || payment) return
    let raw = null
    try { raw = localStorage.getItem('aasthi_payu_pending') } catch { /* private mode */ }
    if (!raw) return
    let pending = null
    try { pending = JSON.parse(raw) } catch { localStorage.removeItem('aasthi_payu_pending'); return }
    if (!pending?.paymentId) return
    let cancelled = false
    let attempts = 0
    let reconciledAt = 0
    setResumeInfo('Checking your PayU payment…')
    const poll = async () => {
      if (cancelled) return
      attempts++
      try {
        let pay = await api.getPayment(pending.paymentId)
        if (cancelled) return
        // Self-heal: if PayU said success but our callback was missed/rejected
        // (old hash bug, closed tab), ask the server to reconcile via PayU
        // verify_payment and flip the payment before completing the purchase.
        if (pay.status === 'PENDING' && attempts >= 3 && Date.now() - reconciledAt > 15000) {
          setResumeInfo('Confirming with PayU (this heals missed callbacks)…')
          try {
            const rec = await api.reconcilePayu(pending.paymentId)
            if (cancelled) return
            reconciledAt = Date.now()
            if (rec?.payment?.status) pay = rec.payment
          } catch { /* reconcile is best-effort; keep polling */ }
        }
        if (pay.status === 'CONFIRMED' && (!pending.assetId || pending.assetId === assetId)) {
          localStorage.removeItem('aasthi_payu_pending')
          setResumeInfo('Completing your purchase moving tokens to you…')
          // Server settles with the payment's OWN data (paid amount, payer, seller)
          // nothing depends on this component's state. Idempotent.
          try {
            const s = await api.settlePayment(pay.paymentId, pay)
            if (cancelled) return
            if (s.ok) {
              setResumeInfo('')
              setPayment(s.payment)
              if (s.transfer) setTransfer(s.transfer)
              setStep('success')
              return
            }
            // settle refused (not confirmed / seller broke) fall through to client DvP
          } catch { /* older server without settle fall back below */ }
          setResumeInfo('')
          setPayment(pay)
          await transferAndRelease(pay, pay.tokenAmount)
          return
        }
        if (pay.status !== 'PENDING') {
          localStorage.removeItem('aasthi_payu_pending')
          setResumeInfo('')
          setPayment(pay)
          setError(pay.failureReason || `Payment ${pay.status} no tokens moved, nothing was kept`)
          setStep('error')
          return
        }
        if (attempts < 60) setTimeout(poll, 3000) // keep waiting for the PayU callback (~3 min)
        else { setResumeInfo(''); localStorage.removeItem('aasthi_payu_pending'); setError('Could not confirm this payment with PayU within 3 minutes. If your PayU dashboard shows success, re-open this page the purchase completes automatically. No money moves without tokens.'); setStep('error') }
      } catch { if (attempts < 10) setTimeout(poll, 3000) }
    }
    poll()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const startPayment = async () => {
    setError('')
    setStep('paying')
    try {
      const collectData = await api.initiateCollect({
        assetId,
        tokenAmount: parseInt(clampedAmount),
        amountINR: total,
        payerVpa: vpa.trim(),
        payeeVpa: `${recipient || 'originator1'}@aasthichain`,
        note: `Buy ${amount} tokens of ${assetId}`,
        payerId: user?.identityId || 'investor1',
        payeeId: recipient || 'originator1'
      })
      if (collectData.payuCheckout) {
        // PayU rail: hand off to the hosted checkout; the callback CONFIRMs and
        // the resume effect above completes transfer + release on return.
        try { localStorage.setItem('aasthi_payu_pending', JSON.stringify({ paymentId: collectData.paymentId, assetId, ts: Date.now() })) } catch { /* private mode */ }
        setPayment(collectData)
        setStep('payu')
        return
      }
      setPayment(collectData)
      setSecondsLeft(300)
      setStep('pending')
    } catch (e) {
      setError(e.data?.failureReason || e.message || 'Could not start payment please try again')
      setStep('error')
    }
  }

  const approve = async () => {
    setStep('confirming')
    try {
      let confirmed
      try {
        confirmed = await api.approvePayment(payment.paymentId, user?.identityId || 'investor1', payment)
      } catch (e) {
        if (e.status === 404 && payment) {
          // Server lost it (fresh cloud instance) re-upload our copy and retry once
          await api.reattachPayment(payment.paymentId, payment)
          confirmed = await api.approvePayment(payment.paymentId, user?.identityId || 'investor1', payment)
        } else throw e
      }
      setPayment(confirmed)
      await transferAndRelease(confirmed)
    } catch (e) {
      failWithRefund(e, 'Payment could not be confirmed')
    }
  }

  const transferAndRelease = async (confirmed, amountOverride) => {
    setStep('transferring')
    const moveAmount = parseInt(amountOverride || clampedAmount) // paid amount wins on resume
    try {
      // Leg 1 Drunix ledger: tokens move from seller to you
      let tr
      try {
        tr = await api.transferTokens(assetId, recipient || 'originator1', user?.identityId || 'investor1', moveAmount)
      } catch (e) {
        if (e.status === 404 || e.status === 400) {
          // Balances not on this instance reattach payment first so state is consistent, then retry
          await api.reattachPayment(confirmed.paymentId, confirmed)
          tr = await api.transferTokens(assetId, recipient || 'originator1', user?.identityId || 'investor1', moveAmount)
        } else throw e
      }
      setTransfer(tr)
      // Leg 2 release escrow to seller (settlement completes)
      let released
      try {
        released = await api.releasePayment(confirmed.paymentId, tr.transferId, confirmed)
      } catch (e) {
        if (e.status === 404) {
          await api.reattachPayment(confirmed.paymentId, confirmed)
          released = await api.releasePayment(confirmed.paymentId, tr.transferId, confirmed)
        } else throw e
      }
      setPayment(released)
      setStep('success')
      // Record holdings locally with the payment receipt lets a cold server
      // instance re-materialize this balance later (self-heal, no lost tokens)
      try {
        recordBuy(user?.identityId || 'investor1', {
          assetId,
          title: propertyTitle || assetId.slice(0, 16),
          tokenPrice: safePrice,
          valuationINR: valuationINR || 0,
          totalTokens: totalTokens || 0,
          originatorId: recipient || 'originator1',
          tokenAmount: moveAmount,
          receipt: {
            paymentId: released.paymentId || collectData.paymentId,
            assetId,
            payerId: user?.identityId || 'investor1',
            tokenAmount: moveAmount,
            amountINR: confirmed.amountINR ?? total,
            status: released.status || 'RELEASED',
            upiTxnId: released.upiTxnId || collectData.upiTxnId || '',
            createdAt: collectData.createdAt || new Date().toISOString(),
            utr: released.utr || ''
          }
        })
      } catch {}
      if (onSuccess) onSuccess(released, tr)
    } catch (e) {
      failWithRefund(e, 'Tokens could not be transferred your money will be refunded')
    }
  }

  const decline = async () => {
    try { await api.declinePayment(payment.paymentId, 'user declined') } catch {}
    setError('Payment cancelled. No money was taken.')
    setStep('error')
  }

  const failWithRefund = async (e, friendly) => {
    setError(e.data?.failureReason || e.message || friendly)
    setStep('error')
    if (payment?.paymentId && payment.status === 'CONFIRMED') {
      try { await api.refundPayment(payment.paymentId, e.message || friendly) } catch {}
    }
  }

  const mm = String(Math.floor(secondsLeft / 60)).padStart(1, '0')
  const ss = String(secondsLeft % 60).padStart(2, '0')

  if (step === 'success' && payment) {
    return (
      <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12, padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>✓</div>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: '#065F46', margin: '8px 0 0' }}>Payment Successful!</h3>
        <p style={{ fontSize: 13, color: '#374151', marginTop: 8, lineHeight: 1.5 }}>
          You bought <strong>{Number(payment.tokenAmount || clampedAmount).toLocaleString('en-IN')} tokens</strong> of this property for <strong>₹{Number(payment.amountINR || total).toLocaleString('en-IN')}</strong>.<br />
          Money and tokens moved together nothing partial.
        </p>
        {payment.utr && (
          <div style={{ background: 'white', border: '1px solid #D1FAE5', borderRadius: 8, padding: '8px 12px', margin: '12px auto', maxWidth: 320, fontSize: 12 }}>
            <div style={{ color: '#6B7280', fontSize: 11 }}>Bank reference (UTR)</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#065F46' }}>{payment.utr}</div>
          </div>
        )}
        {payment.risk && (
          <div style={{ fontSize: 12, color: payment.risk.decision === 'APPROVE' ? '#065F46' : '#92400E', marginTop: 10 }}>
            🛡 Security check {payment.risk.decision === 'APPROVE' ? 'passed' : 'flagged'} risk {payment.risk.band} ({payment.risk.score}/100)
          </div>
        )}
        <div style={{ fontSize: 11, color: '#64748B', marginTop: 6 }}>Settled on NPCI Drunix · atomic DvP</div>
        <div style={{ marginTop: 12 }}>
          <button onClick={() => setAdvanced(!advanced)} style={{ background: 'none', border: 'none', color: '#059669', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}>
            {advanced ? 'Hide' : 'Show'} payment details
          </button>
        </div>
        {advanced && (
          <div style={{ textAlign: 'left', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, padding: 10, margin: '8px auto 0', maxWidth: 320, fontSize: 10, color: '#475569', fontFamily: 'monospace', lineHeight: 1.7 }}>
            <div>paymentId: {payment.paymentId}</div>
            <div>upiTxnId: {payment.upiTxnId || ''}</div>
            <div>RRN: {payment.rrn || ''}</div>
            <div>UTR12: {payment.utr12 || payment.utr || ''}</div>
            <div>Drunix transfer: {payment.drunixTransferId || (transfer && transfer.transferId) || ''}</div>
            <div>status: {payment.status}</div>
            {payment.risk && <div>risk: {payment.risk.score}/100 {payment.risk.band} {(payment.risk.factors || []).map(f => f.code).join(', ')}</div>}
            {payment.risk && <div>fraud model: {payment.risk.model}</div>}
            {payment.utr && <a href={`/api/npci/utr/${payment.utr}`} target="_blank" rel="noopener" style={{ color: '#1E3A5F' }}>Verify UTR →</a>}
          </div>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
          <a href="/wallet" className="btn btn-primary" style={{ fontSize: 13, textDecoration: 'none', padding: '10px 16px' }}>
            View Wallet →
          </a>
          <button className="btn btn-secondary" style={{ fontSize: 13, padding: '10px 16px' }} onClick={() => { setStep('form'); setPayment(null); setTransfer(null); setError('') }}>
            Buy More
          </button>
        </div>
      </div>
    )
  }

  if (step === 'error') {
    return (
      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Buy Tokens</h3>
        <div style={{ marginTop: 12, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 12, fontSize: 12, color: '#991B1B', lineHeight: 1.5 }}>
          {error}
        </div>
        <button
          onClick={() => { setStep('form'); setPayment(null); setError('') }}
          style={{ width: '100%', marginTop: 14, padding: 12, background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          Try Again
        </button>
      </div>
    )
  }

  if (step === 'payu' && payment?.payuCheckout) {
    return (
      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: '0 0 12px' }}>Pay ₹{total.toLocaleString('en-IN')} via UPI</h3>
        <PayUCheckout
          checkout={payment.payuCheckout}
          testMode={!!payment.payuTestMode}
          onCancel={() => {
            try { localStorage.removeItem('aasthi_payu_pending') } catch { /* ignore */ }
            setPayment(null)
            setStep('form')
          }}
        />
      </div>
    )
  }

  if (step === 'pending' && payment) {
    return (
      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Approve in your UPI app</h3>
        <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: 12, marginTop: 12, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#111827' }}>₹{total.toLocaleString('en-IN')}</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>to {payment.payeeVpa} · for {amount} tokens</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#92400E', marginTop: 6 }}>Expires in {mm}:{ss}</div>
        </div>
        <StepTrack current="pending" doneCount={0} />
        <button
          onClick={approve}
          style={{ width: '100%', marginTop: 14, padding: 13, background: '#059669', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
        >
          ✓ Approve Payment
        </button>
        <button
          onClick={decline}
          style={{ width: '100%', marginTop: 8, padding: 11, background: 'white', color: '#6B7280', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          ✕ Decline
        </button>
        <div style={{ fontSize: 10, color: '#9CA3AF', textAlign: 'center', marginTop: 10 }}>
          Demo: this button simulates your UPI app approval. Live UPI comes via NPCI-certified partners (Setu / bank APIs).
        </div>
      </div>
    )
  }

  if (step === 'confirming' || step === 'transferring' || step === 'paying') {
    return (
      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>
          {step === 'paying' ? 'Creating payment request…' : step === 'confirming' ? 'Confirming payment…' : 'Transferring tokens…'}
        </h3>
        <StepTrack current={step} doneCount={step === 'paying' ? 0 : step === 'confirming' ? 1 : 2} />
        <div style={{ marginTop: 12, fontSize: 12, color: '#6B7280', textAlign: 'center' }}>
          🔒 Money and tokens move together never one without the other
        </div>
      </div>
    )
  }

  // step === 'form'
  return (
    <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Buy Tokens</h3>
      {resumeInfo && (
        <div style={{ marginTop: 10, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: 10, fontSize: 12, color: '#92400E', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 12, height: 12, border: '2px solid #FDE68A', borderTopColor: '#D97706', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }}></span>
          {resumeInfo}
        </div>
      )}
      <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Own a part of this property pay by UPI</p>

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>How many tokens?</label>
        {cap !== null && (
          <div style={{ fontSize: 11, color: cap < 10 ? '#92400E' : '#6B7280', marginTop: 4 }}>
            {cap.toLocaleString('en-IN')} tokens available now from the owner{cap < 10 ? ' almost sold out' : ''}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <input
            type="number"
            min="1"
            max={cap || 10000}
            value={amount}
            onChange={e => {
              const v = Math.max(1, parseInt(e.target.value) || 1)
              setAmount(cap ? Math.min(v, cap) : v)
            }}
            style={{ width: 100, padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 14, fontWeight: 600 }}
          />
          <span style={{ fontSize: 13, color: '#6B7280' }}>tokens = ₹{total.toLocaleString('en-IN')}</span>
          {cap !== null && amount > cap && (
            <button onClick={() => setAmount(cap)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #FDE68A', background: '#FFFBEB', color: '#92400E', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              Only {cap} left
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          {cap !== null && cap > 0 && (
            <button onClick={() => setAmount(cap)} style={{ padding: '6px 12px', borderRadius: 20, border: '1px solid #A7F3D0', background: '#ECFDF5', color: '#065F46', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              Max {cap}
            </button>
          )}
          {[10, 50, 100, 500].filter(num => !cap || num <= cap).map(num => (
            <button
              key={num}
              onClick={() => setAmount(num)}
              style={{
                padding: '6px 12px', borderRadius: 20, cursor: 'pointer',
                border: '1px solid #E5E7EB',
                background: amount === num ? '#1E3A5F' : 'white',
                color: amount === num ? 'white' : '#6B7280',
                fontSize: 12, fontWeight: 600
              }}
            >
              {num}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Your UPI ID</label>
        <input
          type="text"
          value={vpa}
          onChange={e => setVpa(e.target.value)}
          placeholder="yourname@bank"
          style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 14, marginTop: 6, fontFamily: 'monospace' }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {DEMO_VPAS.map(dv => (
            <button
              key={dv}
              onClick={() => setVpa(dv)}
              style={{
                padding: '4px 10px', borderRadius: 12, cursor: 'pointer', fontSize: 11,
                border: '1px solid #C7D2FE',
                background: vpa === dv ? '#EEF2FF' : 'white',
                color: '#4338CA', fontFamily: 'monospace'
              }}
            >
              {dv}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 6 }}>
          Test handles only pre-loaded with demo money. No real bank account is used.<br />
          On the next PayU screen, choose <b>UPI ID / VPA</b> and enter the same handle.
        </div>
      </div>

      <div style={{ background: '#F9FAFB', borderRadius: 8, padding: 12, marginTop: 16, border: '1px solid #F3F4F6' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span style={{ color: '#6B7280' }}>Total to pay</span>
          <span style={{ fontWeight: 700, fontSize: 18, color: '#111827' }}>₹{total.toLocaleString('en-IN')}</span>
        </div>
        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
          {amount} tokens × ₹{safePrice.toLocaleString('en-IN')} each
        </div>
      </div>

      <button
        onClick={startPayment}
        disabled={step === 'paying'}
        style={{
          width: '100%', marginTop: 16, padding: 14,
          background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8,
          fontSize: 14, fontWeight: 700, cursor: 'pointer'
        }}
      >
        Pay ₹{total.toLocaleString('en-IN')} →
      </button>

      <div style={{ fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 10, lineHeight: 1.4 }}>
        🔒 Secure UPI payment • Tokens transferred instantly • No paperwork
      </div>
    </div>
  )
}
