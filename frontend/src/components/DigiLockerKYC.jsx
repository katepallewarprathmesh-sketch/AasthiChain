import React, { useState, useEffect } from 'react'

export default function DigiLockerKYC({ user }) {
  const [kycStatus, setKycStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [digiData, setDigiData] = useState(null)
  const [showMock, setShowMock] = useState(false)

  const getHeaders = () => {
    const token = localStorage.getItem('aasthi_token') || ''
    const userStr = localStorage.getItem('aasthi_user')
    let identityId = user?.identityId || 'investor1'
    try { if (userStr) identityId = JSON.parse(userStr).identityId || identityId } catch {}
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Fabric-Identity': identityId
    }
  }

  const fetchKYC = async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/kyc/${encodeURIComponent(user?.identityId || 'investor1')}`, { headers: getHeaders() })
      const data = await res.json()
      setKycStatus(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const initDigiLocker = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/kyc/digilocker/init', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ identityId: user?.identityId || 'investor1' })
      })
      const data = await res.json()
      if (data.authUrl) {
        // In real flow, redirect to DigiLocker OAuth
        // For mock, simulate callback
        setDigiData(data)
        setShowMock(true)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const simulateCallback = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/kyc/digilocker/callback', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          identityId: user?.identityId || 'investor1',
          code: 'mock-code-' + Date.now(),
          state: digiData?.state || 'mock-state'
        })
      })
      const data = await res.json()
      setDigiData(data)
      await fetchKYC()
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const pullDocument = async (docType) => {
    setLoading(true)
    try {
      const res = await fetch('/api/kyc/digilocker/pull-document', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          identityId: user?.identityId || 'investor1',
          docType
        })
      })
      const data = await res.json()
      setDigiData(prev => ({ ...prev, pulledDoc: data }))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchKYC()
  }, [user?.identityId])

  return (
    <div className="card" style={{borderColor:'#1E3A5F', borderWidth:2}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
        <h3 style={{display:'flex', alignItems:'center', gap:8}}>
          <span style={{background:'#1E3A5F', color:'white', fontSize:10, padding:'3px 8px', borderRadius:4, fontWeight:800}}>DigiLocker KYC</span>
          <span>Government ID Verification</span>
          {kycStatus?.kycStatus === 'VERIFIED' && <span style={{background:'#F0FDF4', color:'#065F46', fontSize:10, padding:'2px 8px', borderRadius:10, border:'1px solid #BBF7D0'}}>✓ Verified</span>}
        </h3>
        <button className="btn btn-secondary" onClick={fetchKYC} disabled={loading} style={{fontSize:11, padding:'6px 12px'}}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      <p style={{fontSize:11, color:'#475569', marginTop:6, lineHeight:1.5, maxWidth:'70ch'}}>
        DigiLocker integration for KYC per Asset Tokenisation Bill 2026 verify Aadhaar, PAN, etc. via government source. Real flow: OAuth → DigiLocker → pull document → verify. Mock for hackathon, real toggle via DIGILOCKER_CLIENT_ID.
      </p>

      <div style={{marginTop:16, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
        <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:10, padding:12}}>
          <div style={{fontSize:11, fontWeight:700, textTransform:'uppercase', color:'#64748B', marginBottom:8}}>Current KYC Status</div>
          {kycStatus ? (
            <div style={{fontSize:11, display:'flex', flexDirection:'column', gap:6}}>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Identity</span><span style={{fontWeight:600}}>{kycStatus.identityId}</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Status</span><span className={`status-chip ${kycStatus.kycStatus==='VERIFIED' ? 'status-tokenized' : 'status-pending'}`} style={{fontSize:10}}>{kycStatus.kycStatus}</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Provider</span><span>{kycStatus.provider || 'mock'}</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#64748B'}}>Verified At</span><span style={{fontSize:10}}>{kycStatus.verifiedAt ? new Date(kycStatus.verifiedAt).toLocaleString() : ''}</span></div>
              {kycStatus.digilocker && (
                <div style={{marginTop:8, background:'white', border:'1px solid #E2E8F0', borderRadius:6, padding:8}}>
                  <div style={{fontSize:10, fontWeight:700}}>DigiLocker Docs</div>
                  <div style={{fontSize:10, marginTop:4}}>{kycStatus.digilocker.documents?.map(d => `${d.docType}: ${d.status}`).join(', ') || 'No docs pulled'}</div>
                </div>
              )}
            </div>
          ) : (
            <div style={{fontSize:11, color:'#94A3B8', textAlign:'center', padding:'20px 0'}}>Loading KYC...</div>
          )}
        </div>

        <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:10, padding:12}}>
          <div style={{fontSize:11, fontWeight:700, textTransform:'uppercase', color:'#64748B', marginBottom:8}}>Verify via DigiLocker</div>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            <button className="btn btn-primary" onClick={initDigiLocker} disabled={loading || kycStatus?.kycStatus==='VERIFIED'} style={{width:'100%', padding:'10px', fontSize:12, fontWeight:600}}>
              {kycStatus?.kycStatus==='VERIFIED' ? '✓ Already Verified' : '🔐 Verify with DigiLocker →'}
            </button>
            <div style={{fontSize:10, color:'#6B7280', lineHeight:1.5}}>
              Click to start DigiLocker OAuth. In production, redirects to digilocker.gov.in. For demo, simulates OTP flow.
            </div>
            {showMock && digiData && (
              <div style={{background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:8, padding:10, marginTop:4}}>
                <div style={{fontSize:11, fontWeight:700}}>Mock DigiLocker OAuth Demo</div>
                <div style={{fontSize:10, marginTop:4}}>Auth URL: {digiData.authUrl?.slice(0,40)}...</div>
                <div style={{fontSize:10, marginTop:4}}>State: {digiData.state}</div>
                <button className="btn btn-secondary" onClick={simulateCallback} disabled={loading} style={{width:'100%', marginTop:8, fontSize:11, padding:'8px'}}>
                  Simulate DigiLocker Callback (OTP Verified) →
                </button>
                <div style={{display:'flex', gap:6, marginTop:8}}>
                  <button onClick={()=>pullDocument('AADHAAR')} style={{flex:1, fontSize:10, padding:'6px', borderRadius:6, border:'1px solid #E5E7EB', background:'white'}}>Pull Aadhaar</button>
                  <button onClick={()=>pullDocument('PAN')} style={{flex:1, fontSize:10, padding:'6px', borderRadius:6, border:'1px solid #E5E7EB', background:'white'}}>Pull PAN</button>
                </div>
                {digiData.pulledDoc && (
                  <div style={{marginTop:8, background:'white', border:'1px solid #E2E8F0', borderRadius:6, padding:8, fontSize:10}}>
                    Pulled: {digiData.pulledDoc.docType} {digiData.pulledDoc.status} {digiData.pulledDoc.name || 'Verified'}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{marginTop:12, fontSize:10, color:'#6B7280', background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:6, padding:8, lineHeight:1.5}}>
        <strong>Real Integration:</strong> 1) App → DigiLocker OAuth (client_id, redirect_uri) → 2) User logs in to DigiLocker, consents → 3) Callback with code → 4) Exchange code for access_token → 5) Pull document via /api/digilocker/pull (Aadhaar, PAN, etc.) → 6) Verify and store KYC. Env: DIGILOCKER_CLIENT_ID, DIGILOCKER_CLIENT_SECRET, DIGILOCKER_REDIRECT_URI. See /api/kyc/digilocker/config. Mock for hackathon same interface.
      </div>
    </div>
  )
}
