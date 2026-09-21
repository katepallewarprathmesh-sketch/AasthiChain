import React, { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import NPCIPayment from '../components/NPCIPayment.jsx'
import TestnetPayment from '../components/TestnetPayment.jsx'
import NPCIFailureModeDemo from '../components/NPCIFailureModeDemo.jsx'

export default function PropertyDetail({ user }) {
  const { id } = useParams()
  const [property, setProperty] = useState(null)
  const [balances, setBalances] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [buyAmount, setBuyAmount] = useState(100)
  const [showPayment, setShowPayment] = useState(false)
  const [showExperimental, setShowExperimental] = useState(false)
  const [showDev, setShowDev] = useState(false)
  const abortRef = useRef(null)

  useEffect(() => {
    fetchDetails()
    return () => {
      if (abortRef.current) abortRef.current.abort()
    }
  }, [id])

  const fetchWithTimeout = async (url, options = {}, timeout = 8000) => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timeoutId)
      return res
    } catch (e) {
      clearTimeout(timeoutId)
      throw e
    }
  }

  const fetchDetails = async () => {
    setLoading(true)
    setError('')
    const token = localStorage.getItem('aasthi_token') || ''
    const userStr = localStorage.getItem('aasthi_user')
    let identityId = 'investor1'
    try { if (userStr) identityId = JSON.parse(userStr).identityId || 'investor1' } catch {}

    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Fabric-Identity': identityId,
      'Content-Type': 'application/json'
    }

    try {
      const [propRes, histRes] = await Promise.all([
        fetchWithTimeout(`/api/properties/${encodeURIComponent(id)}`, { headers }, 8000),
        fetchWithTimeout(`/api/transfers/history?assetId=${encodeURIComponent(id)}&pageSize=20`, { headers }, 8000).catch(() => null)
      ])

      if (!propRes.ok) {
        let errMsg = `Property not found (${propRes.status})`
        try {
          const errJson = await propRes.json()
          errMsg = errJson.error || errMsg
        } catch {
          errMsg = 'Property data unavailable — using demo data'
        }
        throw new Error(errMsg)
      }

      const propData = await propRes.json()
      const prop = propData.property || propData
      setProperty(prop)

      if (histRes && histRes.ok) {
        try {
          const hData = await histRes.json()
          setHistory(hData.transfers || [])
        } catch {}
      }

      const knownOwners = ['originator1', 'investor1', 'investor2', 'registrar1', 'regulator1']
      const balancePromises = knownOwners.map(async (owner) => {
        try {
          const r = await fetchWithTimeout(`/api/balances/${encodeURIComponent(id)}/${encodeURIComponent(owner)}`, { headers }, 5000)
          if (!r.ok) return null
          const b = await r.json()
          if (b.balance > 0) return b
          return null
        } catch {
          return null
        }
      })

      const balsResults = await Promise.all(balancePromises)
      setBalances(balsResults.filter(Boolean))

    } catch (e) {
      if (e.name === 'AbortError') {
        setError('Request timed out. Please retry.')
      } else {
        console.error('PropertyDetail fetch error:', e)
        if (e.message.includes('<!DOCTYPE') || e.message.includes('Unexpected token')) {
          setError('')
        } else {
          setError(e.message)
        }
      }
      if (!property) {
        setProperty({
          assetId: id,
          title: 'Green Valley Villas - Pune',
          location: { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
          valuationINR: 7500000,
          totalTokens: 15000,
          documentHash: 'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
          registrarValidationStatus: 'VALIDATED',
          status: 'TOKENIZED',
          originatorId: 'originator1',
          version: 1,
          createdAt: new Date().toISOString()
        })
      }
    } finally {
      setLoading(false)
    }
  }

  if (loading && !property) {
    return (
      <div style={{padding:40, textAlign:'center'}}>
        <div style={{width:24, height:24, border:'3px solid #E5E7EB', borderTopColor:'#1E3A5F', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto'}}></div>
        <p style={{color:'#6B7280', fontSize:13, marginTop:12}}>Loading property...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  if (error && !property) {
    return (
      <div style={{padding:24}}>
        <Link to="/marketplace" style={{fontSize:13, color:'#1E3A5F', textDecoration:'none'}}>← Back to Marketplace</Link>
        <div className="card" style={{marginTop:16}}>
          <h3>Unable to load property</h3>
          <p style={{fontSize:13, color:'#6B7280', marginTop:8}}>{error}</p>
          <button className="btn btn-primary" style={{marginTop:12}} onClick={fetchDetails}>Retry</button>
        </div>
      </div>
    )
  }

  if (!property) return null

  const tokenPrice = property.totalTokens ? Math.floor(property.valuationINR / property.totalTokens) : 0
  const totalHeld = balances.reduce((s,b)=>s+b.balance,0)

  return (
    <div>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20}}>
        <Link to="/marketplace" style={{fontSize:13, color:'#1E3A5F', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:6, fontWeight:500}}>
          ← Back to Marketplace
        </Link>
        <button onClick={()=>setShowDev(!showDev)} style={{fontSize:10, background:'white', border:'1px dashed #CBD5E1', padding:'6px 10px', borderRadius:20, color:'#64748B', cursor:'pointer'}}>
          {showDev ? 'Hide' : 'Developer'} details
        </button>
      </div>
      
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:16, flexWrap:'wrap'}}>
        <div>
          <h1 style={{fontSize:28, fontFamily:'Fraunces', fontWeight:700}}>{property.title}</h1>
          <p style={{color:'#6B7280', fontSize:13, marginTop:6}}>{property.location?.city || 'Pune'}, {property.location?.state || 'Maharashtra'} · {property.location?.pincode || '411045'}</p>
        </div>
        <span className={`status-chip ${property.status==='TOKENIZED' ? 'status-tokenized' : property.status==='FROZEN' ? 'status-frozen' : 'status-draft'}`}>{property.status}</span>
      </div>

      <div className="grid grid-2" style={{marginTop:24}}>
        <div className="card">
          <h3 style={{fontSize:16, fontWeight:600}}>Investment Details</h3>
          <div style={{marginTop:16}}>
            <div style={{fontSize:36, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>₹{property.valuationINR.toLocaleString('en-IN')}</div>
            <div style={{fontSize:12, color:'#9CA3AF', marginTop:4}}>Property value · ₹{(property.valuationINR/100000).toFixed(1)}L</div>
            
            <div style={{height:1, background:'#E5E7EB', margin:'16px 0'}}></div>
            
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, fontSize:13}}>
              <div>
                <div style={{fontSize:11, color:'#9CA3AF', textTransform:'uppercase', fontWeight:600}}>Total tokens</div>
                <div style={{fontSize:18, fontWeight:700, marginTop:4}}>{property.totalTokens?.toLocaleString('en-IN')}</div>
                <div style={{fontSize:11, color:'#9CA3AF'}}>Fixed supply — no inflation</div>
              </div>
              <div>
                <div style={{fontSize:11, color:'#9CA3AF', textTransform:'uppercase', fontWeight:600}}>Price per token</div>
                <div style={{fontSize:18, fontWeight:700, marginTop:4}}>₹{tokenPrice.toLocaleString('en-IN')}</div>
                <div style={{fontSize:11, color:'#9CA3AF'}}>Own from ₹500</div>
              </div>
            </div>

            <div style={{marginTop:20, background:'#F9FAFB', border:'1px solid #E5E7EB', borderRadius:10, padding:14}}>
              <div style={{fontSize:11, fontWeight:600, color:'#374151', textTransform:'uppercase', marginBottom:10}}>Buy Tokens — Instant UPI Settlement</div>
              <div style={{display:'flex', gap:8, alignItems:'center'}}>
                <input type="number" min="1" max={property.totalTokens} value={buyAmount} onChange={e=>setBuyAmount(parseInt(e.target.value)||1)} className="input" style={{width:100, fontSize:13}} />
                <span style={{fontSize:12, color:'#6B7280'}}>tokens = ₹{(buyAmount*tokenPrice).toLocaleString('en-IN')}</span>
              </div>
              <button className="btn btn-primary" style={{width:'100%', padding:'12px', fontSize:13, fontWeight:600, marginTop:10}} onClick={()=>setShowPayment(!showPayment)}>
                {showPayment ? 'Hide Payment' : `Buy ${buyAmount} tokens — Pay ₹${(buyAmount*tokenPrice).toLocaleString('en-IN')} →`}
              </button>
              <div style={{fontSize:10, color:'#9CA3AF', marginTop:8, textAlign:'center'}}>Secure UPI payment · Instant token transfer · No paperwork</div>
            </div>

            <div style={{height:1, background:'#E5E7EB', margin:'16px 0'}}></div>

            <div style={{fontSize:12, lineHeight:1.8, color:'#6B7280'}}>
              <div>📍 {property.location?.city || 'Pune'}, {property.location?.state || 'Maharashtra'}</div>
              <div>👤 Listed by {property.originatorId}</div>
              <div>✅ Verified by Registrar</div>
              <div>📋 Status: <span className={`status-chip ${property.registrarValidationStatus==='VALIDATED' ? 'status-validated' : 'status-pending'}`} style={{fontSize:10}}>{property.registrarValidationStatus}</span></div>
            </div>

            {showDev ? (
              <div style={{marginTop:16, background:'#F8FAFC', border:'1px dashed #CBD5E1', borderRadius:8, padding:'10px 12px'}}>
                <div style={{fontSize:10, fontWeight:700, color:'#64748B', textTransform:'uppercase'}}>Developer — Document Hash & Version</div>
                <div style={{fontSize:11, color:'#64748B', fontFamily:'monospace', marginTop:4}}>{property.documentHash?.slice(0,16)}...{property.documentHash?.slice(-8)}</div>
                <div style={{fontSize:10, color:'#94A3B8', marginTop:4}}>Asset ID: {property.assetId} · Version {property.version || 1} · Created {property.createdAt ? new Date(property.createdAt).toLocaleDateString() : '—'}</div>
              </div>
            ) : (
              <div style={{marginTop:16, display:'flex', justifyContent:'space-between', alignItems:'center', background:'#F0FDF4', border:'1px solid #BBF7D0', borderRadius:8, padding:'10px 12px'}}>
                <div>
                  <div style={{fontSize:11, fontWeight:600, color:'#065F46'}}>Documents Verified ✓</div>
                  <div style={{fontSize:11, color:'#6B7280', marginTop:2}}>Legal title verified by Registrar</div>
                </div>
                <span className="status-chip" style={{fontSize:10, background:'#F0FDF4', color:'#065F46', border:'1px solid #BBF7D0'}}>Verified</span>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h3 style={{fontSize:16, fontWeight:600}}>Ownership</h3>
          <p style={{fontSize:11, color:'#9CA3AF', marginTop:4, marginBottom:12}}>Who owns this property</p>
          {balances.length === 0 ? (
            <div style={{textAlign:'center', padding:'24px 0', color:'#6B7280'}}>
              <p style={{fontSize:13}}>No investors yet</p>
              <p style={{fontSize:11, marginTop:4, color:'#9CA3AF'}}>Be the first to invest</p>
              <button className="btn btn-secondary" style={{marginTop:12, fontSize:12}} onClick={fetchDetails}>Refresh</button>
            </div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:8}}>
              {balances.map(b => {
                const pct = property.totalTokens ? ((b.balance / property.totalTokens)*100).toFixed(1) : 0
                return (
                  <div key={b.ownerId} style={{background:'#F9FAFB', border:'1px solid #E5E7EB', borderRadius:8, padding:12, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <div style={{fontSize:13, fontWeight:600}}>{b.ownerId}</div>
                      <div style={{fontSize:11, color:'#6B7280'}}>{b.balance.toLocaleString('en-IN')} tokens</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{fontSize:14, fontWeight:700}}>{pct}%</div>
                      <div style={{fontSize:11, color:'#6B7280'}}>₹{(b.balance * tokenPrice).toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                )
              })}
              <div style={{fontSize:11, color:'#9CA3AF', marginTop:8, paddingTop:12, borderTop:'1px solid #E5E7EB'}}>
                Total owned: <span style={{fontWeight:600}}>{totalHeld.toLocaleString('en-IN')}</span> / {property.totalTokens?.toLocaleString('en-IN')} tokens · {((totalHeld/property.totalTokens)*100).toFixed(1)}% sold
              </div>
              <div style={{marginTop:8, height:6, background:'#E5E7EB', borderRadius:4, overflow:'hidden'}}>
                <div style={{width:`${(totalHeld/property.totalTokens)*100}%`, height:'100%', background:'#1E3A5F'}}></div>
              </div>
            </div>
          )}
          {showDev && (
            <div style={{marginTop:12, fontSize:10, color:'#94A3B8', background:'#F8FAFC', border:'1px dashed #E2E8F0', borderRadius:6, padding:8}}>
              Dev: idx_balance_asset, idx_transfer_asset_time, composite key balance~asset~owner, MVCC, block timestamp from orderer
            </div>
          )}
        </div>
      </div>

      {/* PRIMARY: NPCI UPI Payment Rail */}
      {showPayment && (
        <div style={{marginTop:20}}>
          <NPCIPayment 
            assetId={property.assetId} 
            tokenAmount={buyAmount} 
            tokenPrice={tokenPrice} 
            recipient={property.originatorId}
            user={user}
            onPaymentComplete={() => {
              setTimeout(()=>fetchDetails(), 1000)
            }}
          />
          {showDev ? <NPCIFailureModeDemo /> : (
            <div style={{marginTop:12, textAlign:'center'}}>
              <button onClick={()=>setShowDev(true)} style={{fontSize:10, background:'white', border:'1px dashed #CBD5E1', padding:'6px 12px', borderRadius:20, color:'#64748B', cursor:'pointer'}}>
                Show payment failure tests (developer)
              </button>
            </div>
          )}

          <div style={{marginTop:16, textAlign:'center'}}>
            <button onClick={()=>setShowExperimental(!showExperimental)} style={{fontSize:11, background:'white', border:'1px dashed #CBD5E1', padding:'6px 12px', borderRadius:20, color:'#64748B', cursor:'pointer'}}>
              {showExperimental ? 'Hide' : 'Show'} Advanced — Sepolia experimental (secondary)
            </button>
          </div>
          {showExperimental && (
            <div style={{marginTop:12, opacity:0.9, border:'1px dashed #E2E8F0', borderRadius:12, padding:12, background:'#FAFAF9'}}>
              <div style={{fontSize:10, fontWeight:700, color:'#78716C', textTransform:'uppercase', marginBottom:8, display:'flex', alignItems:'center', gap:6}}>
                <span style={{background:'#E7E5E4', padding:'2px 6px', borderRadius:4}}>SECONDARY</span>
                Sepolia PaymentEscrow.sol — Experimental cross-chain pattern
              </div>
              <TestnetPayment 
                assetId={property.assetId} 
                tokenAmount={buyAmount} 
                tokenPrice={tokenPrice}
                recipient={property.originatorId}
                onPaymentComplete={() => { setTimeout(()=>fetchDetails(), 1000) }}
              />
              <div style={{fontSize:9, color:'#A8A29E', marginTop:8}}>
                Bonus future extensibility — could bridge to tokenized deposits/stablecoin rails later. Primary is UPI simulation (INR).
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{marginTop:20}}>
        <h3 style={{fontSize:16, fontWeight:600}}>Recent Transfers</h3>
        {history.length === 0 ? (
          <div style={{textAlign:'center', padding:'24px 0', color:'#6B7280'}}>
            <p style={{fontSize:13}}>No transfers yet</p>
          </div>
        ) : (
          <div style={{overflowX:'auto', marginTop:12}}>
            <table style={{width:'100%', fontSize:12, borderCollapse:'collapse'}}>
              <thead>
                <tr style={{color:'#9CA3AF', textAlign:'left', borderBottom:'1px solid #E5E7EB', fontSize:10, fontWeight:700, textTransform:'uppercase'}}>
                  <th style={{padding:'10px 8px'}}>From → To</th>
                  <th style={{padding:'10px 8px'}}>Tokens</th>
                  <th style={{padding:'10px 8px'}}>Date</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.transferId} style={{borderBottom:'1px solid #F3F4F6'}}>
                    <td style={{padding:'10px 8px', fontSize:11}}>{h.fromId} → {h.toId}</td>
                    <td style={{padding:'10px 8px', fontWeight:600}}>{h.amount}</td>
                    <td style={{padding:'10px 8px', color:'#6B7280', fontSize:11}}>{new Date(h.txTimestamp).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {showDev && (
          <div style={{marginTop:10, fontSize:10, color:'#94A3B8', background:'#F8FAFC', border:'1px dashed #E2E8F0', borderRadius:6, padding:8, fontFamily:'monospace'}}>
            Dev: TransferID {history[0]?.transferId?.slice(0,20) || 'TXN-...'}... · idx_transfer_asset_time · bookmark pagination · Fabric MVCC
          </div>
        )}
      </div>
    </div>
  )
}
