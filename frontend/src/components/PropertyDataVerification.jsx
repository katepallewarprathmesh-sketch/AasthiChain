import React, { useState, useEffect } from 'react'

export default function PropertyDataVerification({ assetId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [verifyResult, setVerifyResult] = useState(null)

  const getHeaders = () => {
    const token = localStorage.getItem('aasthi_token') || ''
    const userStr = localStorage.getItem('aasthi_user')
    let identityId = 'registrar1'
    try { if (userStr) identityId = JSON.parse(userStr).identityId || 'registrar1' } catch {}
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Fabric-Identity': identityId
    }
  }

  const fetchProperty = async () => {
    if (!assetId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/properties/${encodeURIComponent(assetId)}`, { headers: getHeaders() })
      const json = await res.json()
      setData(json.property || json)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const verifyProperty = async () => {
    if (!assetId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/properties/${encodeURIComponent(assetId)}/verify`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ source: 'bhoomi' })
      })
      const json = await res.json()
      setVerifyResult(json)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchProperty()
  }, [assetId])

  return (
    <div className="card" style={{borderColor:'#1E3A5F', borderWidth:2}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
        <h3 style={{display:'flex', alignItems:'center', gap:8}}>
          <span style={{background:'#1E3A5F', color:'white', fontSize:10, padding:'3px 8px', borderRadius:4, fontWeight:800}}>Property Data</span>
          <span>Government Registry Verification</span>
        </h3>
        <button className="btn btn-secondary" onClick={fetchProperty} disabled={loading} style={{fontSize:11, padding:'6px 12px'}}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      <p style={{fontSize:11, color:'#475569', marginTop:6, lineHeight:1.5, maxWidth:'70ch'}}>
        Verify property against government land records (Bhoomi, Dharani, e-Property) — encumbrance check, valuation, ownership. Mock for hackathon, real toggle via PROPERTY_DATA_API_KEY.
      </p>

      <div style={{marginTop:16, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
        <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:10, padding:12}}>
          <div style={{fontSize:11, fontWeight:700, textTransform:'uppercase', color:'#64748B', marginBottom:8}}>Property — Our Records</div>
          {data ? (
            <div style={{fontSize:11, display:'flex', flexDirection:'column', gap:6}}>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Asset ID</span><span style={{fontFamily:'monospace', fontSize:10}}>{data.assetId?.slice(0,16)}...</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Title</span><span style={{fontWeight:600}}>{data.title?.slice(0,20) || '—'}</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Location</span><span>{data.location?.city || ''}, {data.location?.state || ''}</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Valuation</span><span>₹{data.valuationINR?.toLocaleString('en-IN') || '—'}</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Status</span><span className={`status-chip ${data.status==='TOKENIZED' ? 'status-tokenized' : 'status-pending'}`} style={{fontSize:10}}>{data.status}</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Doc Hash</span><span style={{fontFamily:'monospace', fontSize:9}}>{data.documentHash?.slice(0,12)}...</span></div>
            </div>
          ) : (
            <div style={{fontSize:11, color:'#94A3B8', textAlign:'center', padding:'20px 0'}}>{loading ? 'Loading...' : 'No property selected'}</div>
          )}
        </div>

        <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:10, padding:12}}>
          <div style={{fontSize:11, fontWeight:700, textTransform:'uppercase', color:'#64748B', marginBottom:8, display:'flex', justifyContent:'space-between'}}>
            <span>Government Verification</span>
            <span style={{fontSize:9, background:'#F0FDF4', color:'#065F46', border:'1px solid #BBF7D0', padding:'2px 6px', borderRadius:10}}>Bhoomi / Dharani</span>
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            <button className="btn btn-primary" onClick={verifyProperty} disabled={loading || !assetId} style={{width:'100%', padding:'10px', fontSize:12, fontWeight:600}}>
              Verify with Government Records →
            </button>
            {verifyResult ? (
              <div style={{background: verifyResult.verified ? '#F0FDF4' : '#FEF2F2', border:`1px solid ${verifyResult.verified ? '#BBF7D0' : '#FECACA'}`, borderRadius:8, padding:10, fontSize:11}}>
                <div style={{fontWeight:700, display:'flex', justifyContent:'space-between'}}>
                  <span>{verifyResult.verified ? '✓ Verified' : '⚠️ Mismatch'}</span>
                  <span style={{fontSize:10, background:'white', padding:'2px 6px', borderRadius:10}}>{verifyResult.source || 'bhoomi'}</span>
                </div>
                <div style={{marginTop:6, display:'flex', flexDirection:'column', gap:4, fontSize:10}}>
                  <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Ownership</span><span>{verifyResult.governmentRecord?.ownerName || '—'}</span></div>
                  <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Encumbrance</span><span style={{color: verifyResult.encumbranceCheck?.hasEncumbrance ? '#DC2626' : '#059669'}}>{verifyResult.encumbranceCheck?.hasEncumbrance ? 'Has encumbrance ⚠️' : 'Clear ✓'}</span></div>
                  <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Govt Valuation</span><span>₹{verifyResult.valuationSource?.governmentValuation?.toLocaleString('en-IN') || '—'}</span></div>
                  <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Match</span><span>{verifyResult.matchScore ? `${verifyResult.matchScore}%` : '—'}</span></div>
                </div>
                <div style={{fontSize:9, color:'#6B7280', marginTop:6, lineHeight:1.4}}>{verifyResult.message || ''}</div>
              </div>
            ) : (
              <div style={{fontSize:10, color:'#6B7280', background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:6, padding:8, lineHeight:1.5}}>
                Click Verify to check against government land registry. Checks: ownership match, encumbrance (mortgage/litigation), valuation difference. If encumbrance found, Registrar should REJECT per §3.2.
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{marginTop:12, fontSize:10, color:'#6B7280', background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:6, padding:8, lineHeight:1.5}}>
        <strong>Real Integration:</strong> Bhoomi (Karnataka), Dharani (Telangana), e-Property (MH) — API via state data centers or via Setu AA (Account Aggregator). Env: PROPERTY_DATA_API_KEY, BHUMI_API_URL. Flow: assetId → survey number → API call → government record → compare with our docHash, valuation, owner. Mock for hackathon — same interface, realistic data.
      </div>
    </div>
  )
}
