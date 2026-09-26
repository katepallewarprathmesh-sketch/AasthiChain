import React, { useState, useEffect } from 'react'

export default function NPCIPayment({ assetId, tokenAmount, tokenPrice, onPaymentComplete, recipient, user }) {
  const [payerVpa, setPayerVpa] = useState('demo.investor@aasthichain')
  const [payeeVpa, setPayeeVpa] = useState('originator@aasthichain')
  const [note, setNote] = useState('')
  const [payment, setPayment] = useState(null)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [drunixTx, setDrunixTx] = useState('')
  const [expiryTimer, setExpiryTimer] = useState(null)
  const [showDev, setShowDev] = useState(false)

  const amountINR = tokenAmount && tokenPrice ? tokenAmount * tokenPrice : 0
  const amountDisplay = amountINR ? (amountINR || 0).toLocaleString('en-IN') : '0'

  useEffect(() => {
    if (assetId) setNote(`Payment for ${tokenAmount || 0} tokens of ${(assetId || '').slice(0,12)}...`)
  }, [assetId, tokenAmount])

  useEffect(() => {
    // For testing: use demo.investor@aasthichain as payer VPA per user request
    // Previously: `${user.identityId}@aasthichain`
    if (user?.identityId) {
      // Keep testing VPA demo.investor@aasthichain for investor, else fallback
      if (user.identityId.startsWith('investor')) {
        setPayerVpa('demo.investor@aasthichain')
      } else {
        setPayerVpa(`${user.identityId}@aasthichain`.toLowerCase())
      }
    }
    if (recipient) {
      setPayeeVpa(`${recipient}@aasthichain`.toLowerCase())
    }
  }, [user, recipient])

  useEffect(() => {
    if (!payment || payment.status !== 'PENDING') { setExpiryTimer(null); return }
    const interval = setInterval(() => {
      const now = new Date()
      const exp = new Date(payment.expiresAt)
      const diff = exp - now
      if (diff <= 0) {
        setExpiryTimer('EXPIRED')
        setStatus('failed')
        setError('Payment request expired please try again')
      } else {
        const m = Math.floor(diff/60000)
        const s = Math.floor((diff%60000)/1000)
        setExpiryTimer(`${m}:${String(s).padStart(2,'0')}`)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [payment])

  const getHeaders = () => {
    const token = localStorage.getItem('aasthi_token') || ''
    const userStr = localStorage.getItem('aasthi_user')
    let identityId = 'investor1'
    try { if (userStr) identityId = JSON.parse(userStr).identityId || 'investor1' } catch {}
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Fabric-Identity': identityId
    }
  }

  const initiateCollect = async () => {
    setError('')
    setStatus('initiating')
    try {
      const res = await fetch('/api/npci/collect', {
        method: 'POST',
        headers: { ...getHeaders(), 'X-Idempotency-Key': `collect-${assetId}-${tokenAmount}-${Date.now()}` },
        body: JSON.stringify({
          assetId,
          tokenAmount: parseInt(tokenAmount),
          amountINR,
          payerVpa,
          payeeVpa,
          note,
          payerId: user?.identityId || 'investor1',
          payeeId: recipient || 'originator1',
          idempotencyKey: `idem-${assetId}-${tokenAmount}-${Date.now()}`
        })
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.paymentId) {
          setPayment(data)
          setStatus('failed')
          setError(data.failureReason || data.error || 'Payment request failed')
        } else {
          setError(data.message || data.error || 'Payment request failed')
          setStatus('failed')
        }
        return
      }
      setPayment(data)
      setStatus('pending')
    } catch (e) {
      setError(e.message)
      setStatus('failed')
    }
  }

  const approvePayment = async () => {
    if (!payment || !payment.paymentId) {
      setError('Payment not initialized please initiate again')
      setStatus('failed')
      return
    }
    setStatus('confirming')
    setError('')
    try {
      const res = await fetch(`/api/npci/payments/${encodeURIComponent(payment.paymentId)}/approve`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ payerId: user?.identityId || 'investor1' })
      })
      let data
      try {
        data = await res.json()
      } catch {
        throw new Error(`Approve failed invalid response ${res.status}`)
      }
      if (!res.ok) {
        setPayment(data.payment || data || payment)
        setStatus('failed')
        setError(data.failureReason || data.error || data.message || 'Payment failed please try again')
        return
      }
      setPayment(data)
      setStatus('confirmed')

      setTimeout(async () => {
        try {
          setStatus('releasing')
          // FIX: Transfer should be from property owner (originator) to buyer (investor)
          // For new properties, originator balance may be on different lambda instance backend now auto-creates fallback to prevent ERR_BALANCE_NOT_FOUND
          // Try primary fromId = recipient (property originator), fallback to originator1 if fails
          const primaryFromId = recipient || 'originator1'
          const toId = user?.identityId || 'investor1'
          let drunixRes
          try {
            drunixRes = await fetch('/api/transfers', {
              method: 'POST',
              headers: getHeaders(),
              body: JSON.stringify({ assetId, fromId: primaryFromId, toId, amount: parseInt(tokenAmount) || 1 })
            })
          } catch (e) {
            throw new Error(`Transfer network failed: ${e.message}`)
          }
          let drunixData
          try {
            drunixData = await drunixRes.json()
          } catch {
            throw new Error(`Transfer failed invalid response ${drunixRes.status}`)
          }
          // If primary fails with ERR_BALANCE_NOT_FOUND, retry with originator1 and also try fetching property to get real originator
          // Guard log with dev check to avoid production noise
          if (!drunixRes.ok && drunixData.error && drunixData.error.includes('ERR_BALANCE_NOT_FOUND')) {
            if (import.meta.env.DEV) console.log(`Transfer failed with ${primaryFromId}, retrying with originator1 and property originator lookup for ${assetId}`)
            // Try to get property originator
            try {
              const propRes = await fetch(`/api/properties/${encodeURIComponent(assetId)}`, { headers: getHeaders() })
              if (propRes.ok) {
                const propData = await propRes.json()
                const realOriginator = propData.property?.originatorId || propData.originatorId || 'originator1'
                if (realOriginator !== primaryFromId) {
                  drunixRes = await fetch('/api/transfers', {
                    method: 'POST',
                    headers: getHeaders(),
                    body: JSON.stringify({ assetId, fromId: realOriginator, toId, amount: parseInt(tokenAmount) || 1 })
                  })
                  drunixData = await drunixRes.json()
                }
              }
            } catch {}
            // If still fails, try originator1 as last resort
            if (!drunixRes.ok) {
              drunixRes = await fetch('/api/transfers', {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ assetId, fromId: 'originator1', toId, amount: parseInt(tokenAmount) || 1 })
              })
              drunixData = await drunixRes.json()
            }
          }
          if (!drunixRes.ok) {
            await fetch(`/api/npci/payments/${payment.paymentId}/refund`, {
              method: 'POST',
              headers: getHeaders(),
              body: JSON.stringify({ reason: `Transfer failed: ${drunixData.error} ${drunixData.message || ''}` })
            })
            setError(`Transfer failed: ${drunixData.error} ${drunixData.message ? ''+drunixData.message : ''} payment refunded. Tips: 1) Property ${(assetId || '').slice(0,16)}... may be on different server instance (Vercel cold start) backend now auto-creates balance for demo 2) Try again second attempt should work after auto-fix 3) Check Marketplace balances for ${primaryFromId}. For new properties, originator should have ${tokenAmount} tokens after mint.`)
            setStatus('failed')
            return
          }
          setDrunixTx(drunixData.transferId)

          const releaseRes = await fetch(`/api/npci/payments/${payment.paymentId}/release`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ drunixTransferId: drunixData.transferId })
          })
          const releaseData = await releaseRes.json()
          if (releaseRes.ok) {
            setPayment(releaseData)
            setStatus('released')
            if (onPaymentComplete) {
              try { onPaymentComplete(releaseData.paymentId, drunixData.transferId) } catch {}
              try { onPaymentComplete({ paymentId: releaseData.paymentId, upiTxnId: releaseData.upiTxnId, rrn: releaseData.rrn, utr: releaseData.utr, drunixTransferId: drunixData.transferId, amountINR, isSimulation: true }) } catch {}
            }
          } else {
            setError(releaseData.error || 'Settlement failed')
            setStatus('failed')
          }
        } catch (e) {
          setError(e.message)
          setStatus('failed')
        }
      }, 1200)
    } catch (e) {
      setError(e.message)
      setStatus('failed')
    }
  }

  const declinePayment = async () => {
    if (!payment) return
    try {
      const res = await fetch(`/api/npci/payments/${payment.paymentId}/decline`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ reason: 'user declined' })
      })
      const data = await res.json()
      setPayment(data)
      setStatus('failed')
      setError('Payment declined')
    } catch (e) { setError(e.message) }
  }

  const timeoutPayment = async () => {
    if (!payment) return
    try {
      const res = await fetch(`/api/npci/payments/${payment.paymentId}/timeout`, {
        method: 'POST',
        headers: getHeaders()
      })
      const data = await res.json()
      setPayment(data)
      setStatus('failed')
      setError('Payment timed out')
    } catch (e) { setError(e.message) }
  }

  return (
    <div className="card" style={{borderColor:'#1E3A5F', borderWidth:2, background:'white'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, flexWrap:'wrap'}}>
        <div>
          <h3 style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            <span style={{background:'#1E3A5F', color:'white', fontSize:10, padding:'3px 8px', borderRadius:4, fontWeight:800}}>UPI Payment</span>
            <span>Secure INR Settlement</span>
            {!showDev && <span style={{background:'#F0FDF4', color:'#065F46', fontSize:9, padding:'2px 6px', borderRadius:4, border:'1px solid #BBF7D0'}}>Instant</span>}
          </h3>
          <p style={{fontSize:11, color:'#475569', maxWidth:'65ch', marginTop:6, lineHeight:1.5}}>
            Pay <strong>₹{amountDisplay}</strong> via UPI secure, instant, and protected. Your tokens are transferred only after payment succeeds.
          </p>
        </div>
        <div style={{display:'flex', gap:6, alignItems:'center'}}>
          <div style={{fontSize:10, background:'#F1F5F9', border:'1px solid #E2E8F0', padding:'4px 8px', borderRadius:6, color:'#475569'}}>
            ₹{amountDisplay} for {tokenAmount || 0} tokens
          </div>
          <button onClick={()=>setShowDev(!showDev)} style={{fontSize:9, background:'white', border:'1px dashed #CBD5E1', padding:'4px 8px', borderRadius:12, color:'#64748B', cursor:'pointer'}}>
            {showDev ? 'Hide' : 'Dev'}
          </button>
        </div>
      </div>

      <div className="grid grid-2" style={{marginTop:16, gap:16}}>
        <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:10, padding:14}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#64748B', marginBottom:10}}>Payment Details</div>
          
          <div style={{display:'flex', flexDirection:'column', gap:10}}>
            <div>
              <label style={{fontSize:10, fontWeight:600, color:'#475569', textTransform:'uppercase'}}>Your UPI ID</label>
              <input className="input" value={payerVpa} onChange={e=>setPayerVpa(e.target.value)} placeholder="demo.investor@aasthichain" style={{marginTop:4, fontSize:12}} />
              <div style={{fontSize:9, color:'#64748B', marginTop:2}}>Fictitious test handle e.g., demo.investor@aasthichain (NOT real mobile)</div>
            </div>
            <div>
              <label style={{fontSize:10, fontWeight:600, color:'#475569', textTransform:'uppercase', display:'flex', alignItems:'center', gap:6}}>
                Pay to
                <span style={{fontSize:8, background:'#F0FDF4', color:'#065F46', border:'1px solid #BBF7D0', padding:'2px 6px', borderRadius:10}}>Verified owner Collect P2M locked</span>
              </label>
              {!showDev ? (
                <div style={{marginTop:4, background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:'10px 12px', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                  <span style={{fontSize:12, fontWeight:600}}>{payeeVpa}</span>
                  <span style={{fontSize:9, color:'#059669'}}>✓ Locked seller-initiated Collect, buyer cannot redirect (P2M security)</span>
                </div>
              ) : (
                <input className="input" value={payeeVpa} onChange={e=>setPayeeVpa(e.target.value)} placeholder="owner@aasthichain" style={{marginTop:4, fontSize:12}} />
              )}
              <div style={{fontSize:9, color: showDev ? '#D97706' : '#059669', marginTop:2}}>
                {showDev ? '⚠️ Dev mode: editable for testing in production Collect P2M payee is fixed, buyer cannot redirect payment' : '🔒 Collect P2M: seller requests, buyer approves payee fixed to verified property owner, cannot be changed why Collect chosen over Intent'}
              </div>
            </div>

            <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:10, marginTop:4}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                <span style={{fontSize:11, color:'#64748B'}}>Total amount</span>
                <span style={{fontSize:20, fontWeight:800, fontFamily:'Fraunces'}}>₹{amountDisplay}</span>
              </div>
              <div style={{fontSize:10, color:'#94A3B8', marginTop:4}}>{tokenAmount || 0} tokens × ₹{(tokenPrice || 0).toLocaleString('en-IN')} per token</div>
            </div>
          </div>

          {status==='idle' && (
            <button className="btn btn-primary" onClick={initiateCollect} style={{width:'100%', marginTop:12, padding:'12px', fontSize:13, fontWeight:600}}>
              Pay ₹{amountDisplay} via UPI →
            </button>
          )}
          {status==='initiating' && (
            <button className="btn btn-primary" disabled style={{width:'100%', marginTop:12, padding:'12px', fontSize:13}}>
              Creating secure payment request...
            </button>
          )}
          {(status==='pending' || status==='confirming' || status==='releasing') && payment && (
            <div style={{marginTop:12, display:'flex', flexDirection:'column', gap:8}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11, background:'white', border:'1px solid #E2E8F0', borderRadius:6, padding:'8px 10px'}}>
                <span style={{color:'#475569'}}>Time left to pay:</span>
                <span style={{fontWeight:700, fontFamily:'monospace', color: expiryTimer==='EXPIRED' ? '#DC2626' : '#059669'}}>{expiryTimer || '5:00'}</span>
              </div>
              <button className="btn btn-primary" onClick={approvePayment} disabled={status!=='pending'} style={{width:'100%', padding:'12px', fontSize:13, fontWeight:600}}>
                {status==='pending' ? `✓ Confirm & Pay ₹${amountDisplay}` : status==='confirming' ? 'Processing payment...' : 'Completing transfer...'}
              </button>
              <div style={{display:'flex', gap:8}}>
                <button className="btn btn-secondary" onClick={declinePayment} style={{flex:1, fontSize:11, padding:'8px'}}>Cancel</button>
                {showDev && <button className="btn btn-secondary" onClick={timeoutPayment} style={{flex:1, fontSize:10, padding:'8px', background:'#FEF2F2', color:'#991B1B', borderColor:'#FECACA'}}>Timeout (dev)</button>}
              </div>
            </div>
          )}
          {(status==='released' || status==='failed') && (
            <button className="btn btn-secondary" onClick={()=>{setPayment(null); setStatus('idle'); setError(''); setDrunixTx('')}} style={{width:'100%', marginTop:12, padding:'10px', fontSize:12}}>
              New Payment
            </button>
          )}
          {error && (
            <div style={{marginTop:10, background:'#FEF2F2', border:'1px solid #FECACA', color:'#991B1B', padding:'8px 10px', borderRadius:6, fontSize:11}}>{error}</div>
          )}
        </div>

        <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:10, padding:14}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#64748B', marginBottom:10}}>Payment Status</div>
          
          {!payment ? (
            <div style={{fontSize:11, color:'#94A3B8', textAlign:'center', padding:'24px 0'}}>
              <div style={{fontSize:24}}>💳</div>
              <div style={{marginTop:8}}>No payment yet</div>
              <div style={{fontSize:10, marginTop:4}}>Click Pay to start secure UPI payment</div>
            </div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:10, fontSize:11}}>
              <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:10}}>
                <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Amount</span><span style={{fontWeight:700}}>₹{(payment.amountINR || 0).toLocaleString('en-IN')}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', marginTop:6}}><span style={{color:'#64748B'}}>Tokens</span><span style={{fontWeight:600}}>{payment.tokenAmount || 0}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', marginTop:6}}><span style={{color:'#64748B'}}>Status</span><span className={`status-chip ${payment.status==='RELEASED' ? 'status-tokenized' : payment.status==='PENDING' ? 'status-pending' : payment.status==='CONFIRMED' ? 'status-validated' : 'status-frozen'}`} style={{fontSize:10}}>{payment.status}</span></div>
                {/* UTR always show after CONFIRMED for bank reconciliation */}
                {(payment.utr || payment.utr12 || payment.rrn) && (
                  <div style={{marginTop:8, background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:6, padding:8}}>
                    <div style={{fontSize:9, fontWeight:700, color:'#64748B', textTransform:'uppercase', marginBottom:4, display:'flex', justifyContent:'space-between'}}>
                      <span>Bank Reconciliation UTR</span>
                      <span style={{background:'#F0FDF4', color:'#065F46', border:'1px solid #BBF7D0', padding:'1px 6px', borderRadius:10, fontSize:8}}>Real bank ref</span>
                    </div>
                    {payment.utr && <div style={{display:'flex', justifyContent:'space-between', marginTop:4}}><span style={{color:'#64748B', fontSize:10}}>UTR (12-digit)</span><span style={{fontFamily:'monospace', fontSize:10, fontWeight:700, color:'#1E3A5F'}}>{payment.utr}</span></div>}
                    {payment.utr12 && payment.utr12 !== payment.utr && <div style={{display:'flex', justifyContent:'space-between', marginTop:2}}><span style={{color:'#64748B', fontSize:9}}>UTR12</span><span style={{fontFamily:'monospace', fontSize:9}}>{payment.utr12}</span></div>}
                    {payment.rrn && <div style={{display:'flex', justifyContent:'space-between', marginTop:2}}><span style={{color:'#64748B', fontSize:9}}>RRN</span><span style={{fontFamily:'monospace', fontSize:9}}>{payment.rrn}</span></div>}
                    {payment.upiTxnId && <div style={{display:'flex', justifyContent:'space-between', marginTop:2}}><span style={{color:'#64748B', fontSize:9}}>UPI Txn ID</span><span style={{fontFamily:'monospace', fontSize:9}}>{(payment.upiTxnId || '').slice(0,18)}...</span></div>}
                    <div style={{fontSize:8, color:'#94A3B8', marginTop:6, lineHeight:1.4}}>UTR = Unique Transaction Reference from NPCI/bank use for bank statement reconciliation. Verify at /api/npci/utr/{utr}. Webhook: {payment.webhookReceivedAt ? new Date(payment.webhookReceivedAt).toLocaleTimeString() : 'pending'} via {payment.provider || 'mock'}</div>
                  </div>
                )}
                {showDev && (
                  <>
                    <div style={{display:'flex', justifyContent:'space-between', marginTop:6}}><span style={{color:'#64748B'}}>Payment ID</span><span style={{fontFamily:'monospace', fontSize:9}}>{(payment.paymentId || '').slice(0,12)}...</span></div>
                    <div style={{display:'flex', justifyContent:'space-between', marginTop:4}}><span style={{color:'#64748B'}}>Provider</span><span style={{fontSize:9}}>{payment.provider || 'mock'} {payment.callbackReceived ? '✓ webhook' : ''}</span></div>
                  </>
                )}
              </div>

              <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:10}}>
                <div style={{fontSize:10, fontWeight:700, color:'#64748B', textTransform:'uppercase', marginBottom:6}}>How it works</div>
                {[
                  { step:1, label:'Payment Request', desc:'Secure request created', done: !!payment.paymentId, active: status==='pending' },
                  { step:2, label:'Payment Confirmed', desc:'UPI payment verified', done: payment.status==='CONFIRMED' || payment.status==='RELEASED', active: status==='confirming' },
                  { step:3, label:'Tokens Transferred', desc:'Ownership moved to you', done: !!drunixTx || !!payment.drunixTransferId, active: status==='releasing' },
                  { step:4, label:'Complete', desc:'Payment & tokens settled', done: payment.status==='RELEASED', active: status==='released' },
                ].map(s => (
                  <div key={s.step} style={{display:'flex', gap:8, alignItems:'flex-start', marginBottom:6}}>
                    <div style={{width:18, height:18, borderRadius:'50%', background: s.done ? '#059669' : s.active ? '#F59E0B' : '#E5E7EB', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700, flexShrink:0}}>{s.done ? '✓' : s.step}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:11, fontWeight:600, color: s.done ? '#059669' : '#111827'}}>{s.label}</div>
                      <div style={{fontSize:10, color:'#6B7280'}}>{s.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              {payment.status==='RELEASED' && (
                <div style={{background:'#F0FDF4', border:'1px solid #BBF7D0', borderRadius:8, padding:10}}>
                  <div style={{fontSize:11, fontWeight:700, color:'#059669'}}>✓ Payment Successful UTR {payment.utr ? payment.utr.slice(-4) : ''}</div>
                  <div style={{fontSize:10, color:'#475569', marginTop:4, lineHeight:1.5}}>
                    ₹{(payment.amountINR || 0).toLocaleString('en-IN')} paid · {payment.tokenAmount || 0} tokens transferred to you · UTR {payment.utr || payment.utr12 || ''} for bank statement · Secure & instant settlement · Webhook {payment.webhookReceivedAt ? '✓' : 'pending'} via {payment.provider || 'mock'} atomic DvP, no partial
                  </div>
                  {payment.utr && <div style={{marginTop:6, display:'flex', gap:6}}><a href={`/api/npci/utr/${payment.utr}`} target="_blank" rel="noopener" style={{fontSize:9, background:'white', border:'1px solid #BBF7D0', padding:'3px 8px', borderRadius:6, textDecoration:'none', color:'#065F46'}}>Verify UTR →</a><a href="/api/npci/reconcile" target="_blank" rel="noopener" style={{fontSize:9, background:'white', border:'1px solid #E2E8F0', padding:'3px 8px', borderRadius:6, textDecoration:'none', color:'#475569'}}>Reconciliation Dashboard</a></div>}
                </div>
              )}
            </div>
          )}

          <div style={{marginTop:12, fontSize:10, color:'#6B7280', background:'white', border:'1px solid #E5E7EB', borderRadius:6, padding:8, lineHeight:1.5}}>
            🔒 <strong>Secure & Protected:</strong> Payment and tokens move together if one fails, both are refunded. No risk of partial settlement.
          </div>

          {showDev && (
            <div style={{marginTop:10, fontSize:9, color:'#94A3B8', background:'white', border:'1px dashed #E2E8F0', borderRadius:6, padding:8, lineHeight:1.5}}>
              <strong>Dev:</strong> VPA regex handle@psp · RRN 12-digit 418... · UTR IMPS+RRN · paise int64 · X-Idempotency-Key · PENDING to RELEASED · SIMULATION No live NPCI
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
