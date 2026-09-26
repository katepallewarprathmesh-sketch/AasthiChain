import React, { useState, useEffect } from 'react'

export default function UTRReconciliation() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [utrQuery, setUtrQuery] = useState('')
  const [utrResult, setUtrResult] = useState(null)
  const [webhooks, setWebhooks] = useState([])

  const getHeaders = () => {
    const token = localStorage.getItem('aasthi_token') || ''
    const userStr = localStorage.getItem('aasthi_user')
    let identityId = 'regulator1'
    try { if (userStr) identityId = JSON.parse(userStr).identityId || 'regulator1' } catch {}
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Fabric-Identity': identityId
    }
  }

  const fetchReconcile = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/npci/reconcile', { headers: getHeaders() })
      const json = await res.json()
      setData(json)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const fetchWebhooks = async () => {
    try {
      const res = await fetch('/api/npci/webhooks?limit=20', { headers: getHeaders() })
      const json = await res.json()
      setWebhooks(json.webhooks || [])
    } catch {}
  }

  const lookupUTR = async () => {
    if (!utrQuery.trim()) return
    setUtrResult({ loading: true })
    try {
      const res = await fetch(`/api/npci/utr/${encodeURIComponent(utrQuery.trim())}`, { headers: getHeaders() })
      const json = await res.json()
      setUtrResult(json)
    } catch (e) {
      setUtrResult({ error: e.message })
    }
  }

  useEffect(() => {
    fetchReconcile()
    fetchWebhooks()
  }, [])

  return (
    <div className="card" style={{borderColor:'#1E3A5F', borderWidth:2}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
        <h3 style={{display:'flex', alignItems:'center', gap:8}}>
          <span style={{background:'#1E3A5F', color:'white', fontSize:10, padding:'3px 8px', borderRadius:4, fontWeight:800}}>UTR Reconciliation</span>
          <span>Bank Statement Verification</span>
        </h3>
        <button className="btn btn-secondary" onClick={()=>{fetchReconcile(); fetchWebhooks()}} disabled={loading} style={{fontSize:11, padding:'6px 12px'}}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      <p style={{fontSize:11, color:'#475569', marginTop:6, lineHeight:1.5, maxWidth:'70ch'}}>
        UTR = Unique Transaction Reference from NPCI/bank 12-digit numeric for IMPS. Every CONFIRMED payment gets UTR via webhook from Setu/ICICI. Use for bank statement reconciliation ensures our ledger matches bank. No partial settlement per atomic DvP.
      </p>

      <div style={{marginTop:16, display:'flex', gap:8, flexWrap:'wrap'}}>
        <input className="input" placeholder="Enter UTR e.g. 418123456789 or IMPS4181234567891234" value={utrQuery} onChange={e=>setUtrQuery(e.target.value)} style={{flex:1, minWidth:200, fontSize:12, fontFamily:'monospace'}} />
        <button className="btn btn-primary" onClick={lookupUTR} style={{fontSize:12, padding:'8px 14px'}}>Lookup UTR →</button>
      </div>

      {utrResult && (
        <div style={{marginTop:12, background: utrResult.error ? '#FEF2F2' : '#F8FAFC', border:`1px solid ${utrResult.error ? '#FECACA' : '#E2E8F0'}`, borderRadius:8, padding:12, fontSize:11}}>
          {utrResult.loading ? 'Searching...' : utrResult.error ? `Error: ${utrResult.error}` : (
            <>
              <div style={{fontWeight:700, display:'flex', justifyContent:'space-between'}}>
                <span>UTR: {utrResult.utr}</span>
                <span style={{fontSize:10, background: utrResult.reconciliation?.utrFormat?.includes('12-digit') ? '#F0FDF4' : '#FEF3C7', border:'1px solid #BBF7D0', padding:'2px 6px', borderRadius:10}}>{utrResult.reconciliation?.utrFormat || 'unknown'}</span>
              </div>
              <div style={{marginTop:6, display:'grid', gridTemplateColumns:'120px 1fr', gap:4}}>
                <span style={{color:'#64748B'}}>Payment ID</span><span style={{fontFamily:'monospace'}}>{utrResult.paymentId}</span>
                <span style={{color:'#64748B'}}>Amount</span><span>₹{utrResult.payment?.amountINR?.toLocaleString('en-IN')}</span>
                <span style={{color:'#64748B'}}>Status</span><span className={`status-chip ${utrResult.payment?.status==='RELEASED' ? 'status-tokenized' : 'status-pending'}`} style={{fontSize:10}}>{utrResult.payment?.status}</span>
                <span style={{color:'#64748B'}}>Provider</span><span>{utrResult.payment?.provider || 'mock'} {utrResult.payment?.webhookReceivedAt ? '✓ webhook' : ''}</span>
                <span style={{color:'#64748B'}}>Confirmed</span><span>{utrResult.payment?.confirmedAt ? new Date(utrResult.payment.confirmedAt).toLocaleString() : ''}</span>
              </div>
            </>
          )}
        </div>
      )}

      {data && (
        <div style={{marginTop:16}}>
          <div className="grid grid-4" style={{gap:8}}>
            <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:8, padding:10, textAlign:'center'}}>
              <div style={{fontSize:18, fontWeight:800}}>{data.summary?.totalPayments || 0}</div>
              <div style={{fontSize:10, color:'#64748B'}}>Total Payments</div>
            </div>
            <div style={{background:'#F0FDF4', border:'1px solid #BBF7D0', borderRadius:8, padding:10, textAlign:'center'}}>
              <div style={{fontSize:18, fontWeight:800, color:'#059669'}}>{data.summary?.successRate || '0%'}</div>
              <div style={{fontSize:10, color:'#64748B'}}>Success Rate</div>
            </div>
            <div style={{background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:8, padding:10, textAlign:'center'}}>
              <div style={{fontSize:18, fontWeight:800}}>{data.summary?.totalVolumeINR?.toLocaleString('en-IN') || 0}</div>
              <div style={{fontSize:10, color:'#64748B'}}>Volume INR</div>
            </div>
            <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:8, padding:10, textAlign:'center'}}>
              <div style={{fontSize:12, fontWeight:700}}>{data.summary?.utrCoverage || '0'}</div>
              <div style={{fontSize:10, color:'#64748B'}}>UTR Coverage</div>
            </div>
          </div>

          <div style={{marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
            <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:10}}>
              <div style={{fontSize:11, fontWeight:700, color:'#DC2626'}}>Issues Requires Attention</div>
              <div style={{marginTop:8, fontSize:10, display:'flex', flexDirection:'column', gap:6}}>
                <div>Pending without UTR: <strong>{data.issues?.pendingWithoutUTR?.length || 0}</strong> {data.issues?.pendingWithoutUTR?.length ? '⚠️' : '✓'}</div>
                <div>Amount mismatches: <strong>{data.issues?.amountMismatches?.length || 0}</strong> {data.issues?.amountMismatches?.length ? '⚠️ Manual review' : '✓'}</div>
                <div>Pending too long (&gt;5min): <strong>{data.issues?.pendingTooLong?.length || 0}</strong></div>
                <div>Failed provider: <strong>{data.issues?.failedProvider?.length || 0}</strong></div>
              </div>
              {data.issues?.amountMismatches?.length > 0 && (
                <div style={{marginTop:8, background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:6, padding:8, fontSize:10}}>
                  {data.issues.amountMismatches.slice(0,3).map(m => (
                    <div key={m.paymentId} style={{marginBottom:4}}>{m.paymentId.slice(0,12)}... {m.failureReason}</div>
                  ))}
                </div>
              )}
            </div>
            <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:8, padding:10}}>
              <div style={{fontSize:11, fontWeight:700}}>Recent Webhooks Audit Log</div>
              <div style={{marginTop:8, maxHeight:150, overflowY:'auto', display:'flex', flexDirection:'column', gap:4}}>
                {(data.recentWebhooks || webhooks).slice(0,10).map((wh, i) => (
                  <div key={i} style={{fontSize:9, display:'flex', justifyContent:'space-between', borderBottom:'1px solid #F1F5F9', paddingBottom:3}}>
                    <span style={{fontFamily:'monospace'}}>{wh.paymentId?.slice(0,10)}...</span>
                    <span style={{background: wh.result==='SUCCESS' ? '#F0FDF4' : '#FEF2F2', padding:'1px 6px', borderRadius:10, fontSize:8}}>{wh.status}</span>
                    <span style={{fontFamily:'monospace'}}>{wh.utr?.slice(-4) || ''}</span>
                    <span style={{color:'#94A3B8'}}>{wh.provider}</span>
                  </div>
                ))}
                {(data.recentWebhooks || []).length === 0 && <div style={{fontSize:10, color:'#94A3B8', textAlign:'center', padding:'12px 0'}}>No webhooks yet approve a payment to see webhook audit</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{marginTop:12, fontSize:10, color:'#6B7280', background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:6, padding:8, lineHeight:1.5}}>
        <strong>How UTR Reconciliation Works:</strong> 1) User pays via UPI → 2) NPCI switch assigns RRN → 3) Bank assigns 12-digit UTR → 4) Setu/ICICI POSTs webhook to /api/npci/webhook with UTR → 5) We verify signature, check amount matches, store UTR in utrIndex → 6) Frontend releases tokens only after UTR confirmed → 7) Regulator can lookup UTR at /api/npci/utr/:utr to match bank statement. Amount mismatch → FAILED_AMOUNT_MISMATCH, manual review, no auto-release. Idempotent duplicate webhook returns same, no double credit.
      </div>
    </div>
  )
}
