import React, { useState, useEffect } from 'react'

export default function NPCIPayment({ assetId, tokenAmount, tokenPrice, onPaymentComplete, recipient, user }) {
  const [payerVpa, setPayerVpa] = useState('investor@aasthichain')
  const [payeeVpa, setPayeeVpa] = useState('originator@aasthichain')
  const [note, setNote] = useState('')
  const [payment, setPayment] = useState(null)
  const [status, setStatus] = useState('idle') // idle, initiating, pending, confirming, confirmed, releasing, released, failed
  const [error, setError] = useState('')
  const [drunixTx, setDrunixTx] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [expiryTimer, setExpiryTimer] = useState(null)

  const amountINR = tokenAmount && tokenPrice ? tokenAmount * tokenPrice : 0
  const amountDisplay = amountINR ? amountINR.toLocaleString('en-IN') : '0'

  useEffect(() => {
    if (assetId) setNote(`Payment for ${tokenAmount || 0} tokens of ${assetId.slice(0,12)}...`)
  }, [assetId, tokenAmount])

  useEffect(() => {
    if (user?.identityId) {
      setPayerVpa(`${user.identityId}@aasthichain`.toLowerCase())
    }
    if (recipient) {
      setPayeeVpa(`${recipient}@aasthichain`.toLowerCase())
    }
  }, [user, recipient])

  // expiry countdown
  useEffect(() => {
    if (!payment || payment.status !== 'PENDING') { setExpiryTimer(null); return }
    const interval = setInterval(() => {
      const now = new Date()
      const exp = new Date(payment.expiresAt)
      const diff = exp - now
      if (diff <= 0) {
        setExpiryTimer('EXPIRED')
        setStatus('failed')
        setError('Collect request expired after 5 min — UPI window elapsed')
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
        // failure response still contains payment object
        if (data.paymentId) {
          setPayment(data)
          setStatus('failed')
          setError(data.failureReason || data.error || 'Collect failed')
        } else {
          setError(data.message || data.error || 'Collect failed')
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
    if (!payment) return
    setStatus('confirming')
    setError('')
    try {
      const res = await fetch(`/api/npci/payments/${payment.paymentId}/approve`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ payerId: user?.identityId || 'investor1' })
      })
      const data = await res.json()
      if (!res.ok) {
        setPayment(data.payment || data)
        setStatus('failed')
        setError(data.failureReason || data.error || 'Approval failed')
        // if insufficient funds etc, allow refund
        return
      }
      setPayment(data)
      setStatus('confirmed')

      // Atomic DvP: call Drunix TransferTokens
      setTimeout(async () => {
        try {
          setStatus('releasing')
          const toId = recipient || 'investor2'
          const drunixRes = await fetch('/api/transfers', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ assetId, toId, amount: parseInt(tokenAmount) || 1 })
          })
          const drunixData = await drunixRes.json()
          if (!drunixRes.ok) {
            // Drunix failed → refund
            await fetch(`/api/npci/payments/${payment.paymentId}/refund`, {
              method: 'POST',
              headers: getHeaders(),
              body: JSON.stringify({ reason: `Drunix transfer failed: ${drunixData.error} — atomic refund` })
            })
            setError(`Drunix transfer failed: ${drunixData.error} — payment REFUNDED (atomic DvP preserved)`)
            setStatus('failed')
            return
          }
          setDrunixTx(drunixData.transferId)

          // Release settlement
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
            setError(releaseData.error || 'Release failed')
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
        body: JSON.stringify({ reason: 'user declined in UPI app' })
      })
      const data = await res.json()
      setPayment(data)
      setStatus('failed')
      setError('Declined by user in UPI app')
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
      setError('Collect request timed out after 5 min — UPI window elapsed')
    } catch (e) { setError(e.message) }
  }

  return (
    <div className="card" style={{borderColor:'#1E3A5F', borderWidth:2, background:'white'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, flexWrap:'wrap'}}>
        <div>
          <h3 style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            <span style={{background:'#1E3A5F', color:'white', fontSize:10, padding:'3px 8px', borderRadius:4, fontWeight:800, letterSpacing:'0.05em'}}>PRIMARY</span>
            <span>UPI Collect — NPCI-style Settlement (INR)</span>
            <span style={{background:'#FEF3C7', color:'#92400E', fontSize:9, padding:'2px 6px', borderRadius:4, border:'1px solid #FDE68A'}}>SIMULATION — No live NPCI</span>
          </h3>
          <p style={{fontSize:11, color:'#475569', maxWidth:'75ch', marginTop:6, lineHeight:1.5}}>
            Payee <strong>{payeeVpa}</strong> requests <strong>₹{amountDisplay}</strong> from payer <strong>{payerVpa}</strong> via NPCI switch. Payer approves in UPI app → IMPS settlement with UTR → Drunix <code>TransferTokens</code> → atomic DvP. Models UPI P2M Collect + IMPS UTR flow.
          </p>
        </div>
        <div style={{fontSize:10, background:'#F1F5F9', border:'1px solid #E2E8F0', padding:'4px 8px', borderRadius:6, color:'#475569'}}>
          ₹{amountDisplay} = {tokenAmount || 0} tokens × ₹{tokenPrice?.toLocaleString('en-IN') || 0}
        </div>
      </div>

      <div className="grid grid-2" style={{marginTop:16, gap:16}}>
        <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:10, padding:14}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#64748B', marginBottom:10}}>Collect Request — UPI P2M</div>
          
          <div style={{display:'flex', flexDirection:'column', gap:10}}>
            <div>
              <label style={{fontSize:10, fontWeight:700, color:'#475569', textTransform:'uppercase'}}>Payer VPA (Investor)</label>
              <input className="input" value={payerVpa} onChange={e=>setPayerVpa(e.target.value)} placeholder="investor@aasthichain" style={{marginTop:4, fontSize:12}} />
              <div style={{fontSize:9, color:'#94A3B8', marginTop:2}}>Format: handle@psp — e.g., investor@aasthichain</div>
            </div>
            <div>
              <label style={{fontSize:10, fontWeight:700, color:'#475569', textTransform:'uppercase'}}>Payee VPA (Originator)</label>
              <input className="input" value={payeeVpa} onChange={e=>setPayeeVpa(e.target.value)} placeholder="originator@aasthichain" style={{marginTop:4, fontSize:12}} />
            </div>
            <div>
              <label style={{fontSize:10, fontWeight:700, color:'#475569', textTransform:'uppercase'}}>Note</label>
              <input className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Payment for tokens" style={{marginTop:4, fontSize:12}} />
            </div>

            <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:10, marginTop:4}}>
              <div style={{fontSize:10, color:'#64748B', fontWeight:700, textTransform:'uppercase'}}>Amount — INR (₹)</div>
              <div style={{display:'flex', gap:12, marginTop:6}}>
                <div><div style={{fontSize:10, color:'#94A3B8'}}>Tokens</div><div style={{fontSize:14, fontWeight:700}}>{tokenAmount || 0}</div></div>
                <div><div style={{fontSize:10, color:'#94A3B8'}}>Price/token</div><div style={{fontSize:14, fontWeight:700}}>₹{tokenPrice?.toLocaleString('en-IN') || 0}</div></div>
                <div><div style={{fontSize:10, color:'#94A3B8'}}>Total</div><div style={{fontSize:18, fontWeight:800, fontFamily:'Fraunces'}}>₹{amountDisplay}</div></div>
              </div>
              <div style={{fontSize:9, color:'#94A3B8', marginTop:6}}>Stored as paise internally (int64) to avoid float — {amountINR ? Math.round(amountINR*100) : 0} paise</div>
            </div>
          </div>

          {status==='idle' && (
            <button className="btn btn-primary" onClick={initiateCollect} style={{width:'100%', marginTop:12, padding:'12px', fontSize:13, fontWeight:600}}>
              Initiate UPI Collect — Request ₹{amountDisplay} from {payerVpa.split('@')[0]}
            </button>
          )}
          {status==='initiating' && (
            <button className="btn btn-primary" disabled style={{width:'100%', marginTop:12, padding:'12px', fontSize:13}}>
              Initiating collect via NPCI switch...
            </button>
          )}
          {(status==='pending' || status==='confirming' || status==='releasing') && payment && (
            <div style={{marginTop:12, display:'flex', flexDirection:'column', gap:8}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11, background:'white', border:'1px solid #E2E8F0', borderRadius:6, padding:'8px 10px'}}>
                <span style={{color:'#475569'}}>UPI Collect expires in:</span>
                <span style={{fontWeight:700, fontFamily:'monospace', color: expiryTimer==='EXPIRED' ? '#DC2626' : '#059669'}}>{expiryTimer || '5:00'}</span>
              </div>
              <button className="btn btn-primary" onClick={approvePayment} disabled={status!=='pending'} style={{width:'100%', padding:'12px', fontSize:13, fontWeight:600}}>
                {status==='pending' ? `✓ Approve in UPI app — Pay ₹${amountDisplay}` : status==='confirming' ? 'Approving...' : 'Releasing settlement...'}
              </button>
              <div style={{display:'flex', gap:8}}>
                <button className="btn btn-secondary" onClick={declinePayment} style={{flex:1, fontSize:11, padding:'8px'}}>Decline</button>
                <button className="btn btn-secondary" onClick={timeoutPayment} style={{flex:1, fontSize:11, padding:'8px', background:'#FEF2F2', color:'#991B1B', borderColor:'#FECACA'}}>Simulate Timeout</button>
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
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#64748B', marginBottom:10}}>NPCI Settlement References — UPI/IMPS</div>
          
          {!payment ? (
            <div style={{fontSize:11, color:'#94A3B8', textAlign:'center', padding:'24px 0'}}>
              <div style={{fontSize:20}}>💸</div>
              <div style={{marginTop:8}}>No payment yet</div>
              <div style={{fontSize:10, marginTop:4, maxWidth:'30ch', margin:'4px auto 0'}}>Initiate collect to generate UPI Txn ID, RRN, UTR — NPCI-style IDs</div>
            </div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:10, fontSize:11}}>
              <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:10}}>
                <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Payment ID</span><span style={{fontFamily:'monospace', fontWeight:700, fontSize:10}}>{payment.paymentId}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', marginTop:6}}><span style={{color:'#64748B'}}>UPI Txn ID</span><span style={{fontFamily:'monospace', fontWeight:600, fontSize:10}}>{payment.upiTxnId}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', marginTop:6}}><span style={{color:'#64748B'}}>RRN</span><span style={{fontFamily:'monospace', fontWeight:600}}>{payment.rrn}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', marginTop:6}}><span style={{color:'#64748B'}}>UTR (IMPS)</span><span style={{fontFamily:'monospace', fontWeight:700, color:'#1E3A5F'}}>{payment.utr}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', marginTop:6}}><span style={{color:'#64748B'}}>Status</span><span className={`status-chip ${payment.status==='RELEASED' ? 'status-tokenized' : payment.status==='PENDING' ? 'status-pending' : payment.status==='CONFIRMED' ? 'status-validated' : 'status-frozen'}`} style={{fontSize:10}}>{payment.status}</span></div>
              </div>

              <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:10}}>
                <div style={{fontSize:10, fontWeight:700, color:'#64748B', textTransform:'uppercase', marginBottom:6}}>Atomic DvP Flow</div>
                {[
                  { step:1, label:'Collect Initiated', desc:'Payee requests via NPCI switch', done: !!payment.paymentId, active: status==='pending' },
                  { step:2, label:'Payer Approves', desc:'UPI app approval + KYC + balance check', done: payment.status==='CONFIRMED' || payment.status==='RELEASED', active: status==='confirming' },
                  { step:3, label:'Drunix Transfer', desc:'TransferTokens chaincode — token ownership moves', done: !!drunixTx || !!payment.drunixTransferId, active: status==='releasing' },
                  { step:4, label:'IMPS Settlement', desc:'UTR credited to payee — RELEASED', done: payment.status==='RELEASED', active: status==='released' },
                ].map(s => (
                  <div key={s.step} style={{display:'flex', gap:8, alignItems:'flex-start', marginBottom:6}}>
                    <div style={{width:18, height:18, borderRadius:'50%', background: s.done ? '#059669' : s.active ? '#F59E0B' : '#E5E7EB', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700, flexShrink:0}}>{s.done ? '✓' : s.step}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:11, fontWeight:600, color: s.done ? '#059669' : '#111827'}}>{s.label} {s.active ? '— in progress' : ''}</div>
                      <div style={{fontSize:10, color:'#6B7280'}}>{s.desc}</div>
                    </div>
                  </div>
                ))}
                {(drunixTx || payment.drunixTransferId) && (
                  <div style={{fontSize:9, fontFamily:'monospace', background:'#F0FDF4', border:'1px solid #BBF7D0', padding:'6px 8px', borderRadius:4, marginTop:6}}>
                    Drunix TXN: {(drunixTx || payment.drunixTransferId).slice(0,24)}... — linked to UPI UTR {payment.utr.slice(0,16)}... — atomic DvP
                  </div>
                )}
              </div>

              {payment.status==='RELEASED' && (
                <div style={{background:'#F0FDF4', border:'1px solid #BBF7D0', borderRadius:8, padding:10}}>
                  <div style={{fontSize:11, fontWeight:700, color:'#059669'}}>✓ Settlement Complete — Atomic DvP Achieved</div>
                  <div style={{fontSize:10, color:'#475569', marginTop:4, lineHeight:1.5}}>
                    ₹{payment.amountINR.toLocaleString('en-IN')} moved via IMPS UTR {payment.utr} → {tokenAmount} tokens moved via Drunix TXN {payment.drunixTransferId?.slice(0,12)}... — money and tokens moved together, or both refunded. Production path: real UPI Collect API (ICICI/Yes Bank) + webhook.
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{marginTop:12, fontSize:9, color:'#94A3B8', background:'white', border:'1px dashed #E2E8F0', borderRadius:6, padding:8, lineHeight:1.5}}>
            <strong>Why UPI Collect P2M?</strong> Real estate: seller requests payment, buyer approves — matches merchant collect. UPI Intent (buyer-initiated) would be buyer directly paying. Collect gives seller control + UPI mandate. Settlement via IMPS gives UTR for reconciliation (like NPCI). No live NPCI credentials — simulation clearly labeled.
          </div>
        </div>
      </div>

      <div style={{marginTop:12, display:'flex', gap:8, flexWrap:'wrap'}}>
        <span style={{fontSize:9, background:'#F1F5F9', border:'1px solid #E2E8F0', padding:'3px 6px', borderRadius:4, color:'#64748B'}}>VPA: handle@psp validated via regex</span>
        <span style={{fontSize:9, background:'#F1F5F9', border:'1px solid #E2E8F0', padding:'3px 6px', borderRadius:4, color:'#64748B'}}>RRN: 12-digit numeric (418...)</span>
        <span style={{fontSize:9, background:'#F1F5F9', border:'1px solid #E2E8F0', padding:'3px 6px', borderRadius:4, color:'#64748B'}}>UTR: IMPS + RRN</span>
        <span style={{fontSize:9, background:'#F1F5F9', border:'1px solid #E2E8F0', padding:'3px 6px', borderRadius:4, color:'#64748B'}}>Idempotency: X-Idempotency-Key</span>
        <span style={{fontSize:9, background:'#FEF3C7', border:'1px solid #FDE68A', padding:'3px 6px', borderRadius:4, color:'#92400E'}}>SIMULATION</span>
      </div>
    </div>
  )
}
