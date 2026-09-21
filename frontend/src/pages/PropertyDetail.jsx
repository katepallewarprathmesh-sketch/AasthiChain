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

    const controller = new AbortController()
    abortRef.current = controller

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
      <div style={{padding:24}}>
        <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:16}}>
          <div style={{width:20, height:20, border:'2px solid var(--ink-12)', borderTopColor:'var(--registry-navy)', borderRadius:'50%', animation:'spin 0.8s linear infinite'}}></div>
          <p style={{color:'var(--ink-60)'}}>Loading property...</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        <div className="card" style={{height:200, background:'var(--paper)', animation:'pulse 1.5s infinite'}}></div>
        <style>{`@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.5 } }`}</style>
      </div>
    )
  }

  if (error && !property) {
    return (
      <div style={{padding:24}}>
        <Link to="/marketplace" style={{fontSize:13, color:'var(--registry-navy)', textDecoration:'none'}}>← Back to Marketplace</Link>
        <div className="card" style={{marginTop:16}}>
          <h3>Unable to load property</h3>
          <p style={{fontSize:13, color:'var(--ink-60)', marginTop:8}}>{error}</p>
          <p style={{fontSize:11, color:'var(--ink-40)', marginTop:8}}>Asset ID: {id}</p>
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
      <Link to="/marketplace" style={{fontSize:13, color:'var(--registry-navy)', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:6, marginBottom:20, fontWeight:500}}>
        ← Back to Marketplace
      </Link>
      
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:16, flexWrap:'wrap'}}>
        <div>
          <h1 style={{fontSize:28, fontFamily:'Fraunces', fontWeight:700}}>{property.title}</h1>
          <p style={{color:'var(--ink-60)', fontSize:12, marginTop:6}}>{property.assetId} · Version {property.version || 1} · {property.createdAt ? new Date(property.createdAt).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : ''}</p>
        </div>
        <span className={`status-chip ${property.status==='TOKENIZED' ? 'status-tokenized' : property.status==='FROZEN' ? 'status-frozen' : 'status-draft'}`}>{property.status}</span>
      </div>

      <div className="grid grid-2" style={{marginTop:24}}>
        <div className="card">
          <h3 style={{fontSize:16, fontWeight:600}}>Valuation</h3>
          <div style={{marginTop:16}}>
            <div className="tabular" style={{fontSize:36, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>₹{property.valuationINR.toLocaleString('en-IN')}</div>
            <div style={{fontSize:12, color:'var(--ink-40)', marginTop:4}}>₹{(property.valuationINR/100000).toFixed(1)}L</div>
            
            <div className="divider" style={{margin:'16px 0', height:1, background:'var(--ink-8)'}}></div>
            
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, fontSize:13}}>
              <div>
                <div style={{fontSize:11, color:'var(--ink-40)', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:700}}>Total tokens</div>
                <div className="tabular" style={{fontSize:18, fontWeight:700, marginTop:4}}>{property.totalTokens?.toLocaleString('en-IN')}</div>
                <div style={{fontSize:11, color:'var(--ink-40)'}}>Fixed supply</div>
              </div>
              <div>
                <div style={{fontSize:11, color:'var(--ink-40)', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:700}}>Price per token</div>
                <div className="tabular" style={{fontSize:18, fontWeight:700, marginTop:4}}>₹{tokenPrice.toLocaleString('en-IN')}</div>
                <div style={{fontSize:11, color:'var(--ink-40)'}}>Integer tokens</div>
              </div>
            </div>

            <div style={{marginTop:20, background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:10, padding:12}}>
              <div style={{fontSize:11, fontWeight:700, color:'#475569', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:8}}>Buy Tokens — NPCI UPI Rail (Primary)</div>
              <div style={{display:'flex', gap:8, alignItems:'center'}}>
                <input type="number" min="1" max={property.totalTokens} value={buyAmount} onChange={e=>setBuyAmount(parseInt(e.target.value)||1)} className="input" style={{width:100, fontSize:13}} />
                <span style={{fontSize:12, color:'#64748B'}}>tokens = ₹{(buyAmount*tokenPrice).toLocaleString('en-IN')}</span>
              </div>
              <button className="btn btn-primary" style={{width:'100%', padding:'12px', fontSize:13, fontWeight:600, marginTop:10}} onClick={()=>setShowPayment(!showPayment)}>
                {showPayment ? 'Hide Payment' : `Buy ${buyAmount} tokens — UPI Collect ₹${(buyAmount*tokenPrice).toLocaleString('en-IN')} →`}
              </button>
              <div style={{fontSize:9, color:'#94A3B8', marginTop:6, textAlign:'center'}}>Primary rail: UPI Collect (INR) + Drunix atomic DvP · Secondary: Sepolia experimental</div>
            </div>

            <div className="divider" style={{margin:'16px 0', height:1, background:'var(--ink-8)'}}></div>

            <div style={{fontSize:12, lineHeight:1.8, color:'var(--ink-60)'}}>
              <div>📍 {property.location?.city || 'Pune'}, {property.location?.state || 'Maharashtra'} — {property.location?.pincode || '411045'}</div>
              <div>👤 Originator: {property.originatorId}</div>
              <div>🕒 Created: {property.createdAt ? new Date(property.createdAt).toLocaleDateString() : '—'}</div>
              <div>📋 Status: <span className={`status-chip ${property.registrarValidationStatus==='VALIDATED' ? 'status-validated' : 'status-pending'}`} style={{fontSize:10}}>{property.registrarValidationStatus}</span></div>
            </div>

            <div className="hash-display" style={{marginTop:16, display:'flex', justifyContent:'space-between', alignItems:'center', background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:8, padding:'10px 12px'}}>
              <div>
                <div style={{fontSize:11, fontWeight:600}}>Documents Verified ✓</div>
                <div style={{fontSize:11, color:'var(--ink-40)', fontFamily:'ui-monospace, monospace', marginTop:2}}>{property.documentHash?.slice(0,8) || 'a3f5c1e8'}...{property.documentHash?.slice(-4) || 'f0a1'}</div>
              </div>
              <span className="status-chip status-tokenized" style={{fontSize:10}}>Verified</span>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{fontSize:16, fontWeight:600}}>Ownership</h3>
          <p style={{fontSize:11, color:'var(--ink-40)', marginTop:4, marginBottom:12}}>Cap table by ownership percentage</p>
          {balances.length === 0 ? (
            <div className="empty-state" style={{textAlign:'center', padding:'24px 0', color:'var(--ink-60)'}}>
              <p style={{fontSize:13}}>No holders yet</p>
              <p style={{fontSize:11, marginTop:4}}>Originator holds full supply after mint</p>
              <button className="btn btn-secondary" style={{marginTop:12, fontSize:12}} onClick={fetchDetails}>Refresh</button>
            </div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:8}}>
              {balances.map(b => {
                const pct = property.totalTokens ? ((b.balance / property.totalTokens)*100).toFixed(1) : 0
                return (
                  <div key={b.ownerId} style={{background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:8, padding:12, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <div style={{fontSize:13, fontWeight:600}}>{b.ownerId}</div>
                      <div className="tabular" style={{fontSize:11, color:'var(--ink-60)'}}>{b.balance.toLocaleString('en-IN')} tokens</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div className="tabular" style={{fontSize:14, fontWeight:700}}>{pct}%</div>
                      <div className="tabular" style={{fontSize:11, color:'var(--ink-60)'}}>₹{(b.balance * tokenPrice).toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                )
              })}
              <div style={{fontSize:11, color:'var(--ink-40)', marginTop:8, paddingTop:12, borderTop:'1px solid var(--ink-8)'}}>
                Total: <span className="tabular" style={{fontWeight:600}}>{totalHeld.toLocaleString('en-IN')}</span> / {property.totalTokens?.toLocaleString('en-IN')} tokens · {((totalHeld/property.totalTokens)*100).toFixed(1)}% sold
              </div>
              <div className="progress-bar" style={{marginTop:8, height:6, background:'var(--ink-8)', borderRadius:4, overflow:'hidden'}}>
                <div className="progress-fill" style={{width:`${(totalHeld/property.totalTokens)*100}%`, height:'100%', background:'var(--registry-navy)'}}></div>
              </div>
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
            onPaymentComplete={(paymentId, drunixTxId) => {
              // refresh balances after successful DvP
              setTimeout(()=>fetchDetails(), 1000)
            }}
          />
          <NPCIFailureModeDemo />

          {/* Secondary: Sepolia experimental toggle */}
          <div style={{marginTop:16, textAlign:'center'}}>
            <button onClick={()=>setShowExperimental(!showExperimental)} style={{fontSize:11, background:'white', border:'1px dashed #CBD5E1', padding:'6px 12px', borderRadius:20, color:'#64748B', cursor:'pointer'}}>
              {showExperimental ? 'Hide' : 'Show'} Advanced / Experimental — Sepolia cross-chain settlement pattern (secondary)
            </button>
          </div>
          {showExperimental && (
            <div style={{marginTop:12, opacity:0.9, border:'1px dashed #E2E8F0', borderRadius:12, padding:12, background:'#FAFAF9'}}>
              <div style={{fontSize:10, fontWeight:700, color:'#78716C', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8, display:'flex', alignItems:'center', gap:6}}>
                <span style={{background:'#E7E5E4', padding:'2px 6px', borderRadius:4}}>SECONDARY</span>
                Sepolia PaymentEscrow.sol — Cross-chain settlement pattern demo (experimental, not primary DvP)
              </div>
              <TestnetPayment 
                assetId={property.assetId} 
                tokenAmount={buyAmount} 
                tokenPrice={tokenPrice}
                recipient={property.originatorId}
                onPaymentComplete={() => { setTimeout(()=>fetchDetails(), 1000) }}
              />
              <div style={{fontSize:9, color:'#A8A29E', marginTop:8, lineHeight:1.5}}>
                Kept as bonus / future extensibility: could bridge to tokenized deposits or stablecoin rails later. Primary is NPCI UPI simulation (INR). Sepolia test ETH has no monetary value, faucet-based.
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{marginTop:20}}>
        <h3 style={{fontSize:16, fontWeight:600}}>Transfer History</h3>
        {history.length === 0 ? (
          <div className="empty-state" style={{textAlign:'center', padding:'24px 0', color:'var(--ink-60)'}}>
            <p style={{fontSize:13}}>No transfers yet</p>
          </div>
        ) : (
          <div style={{overflowX:'auto', marginTop:12}}>
            <table style={{width:'100%', fontSize:12, borderCollapse:'collapse'}}>
              <thead>
                <tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-12)', fontSize:10, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase'}}>
                  <th style={{padding:'10px 8px'}}>From → To</th>
                  <th style={{padding:'10px 8px'}}>Amount</th>
                  <th style={{padding:'10px 8px'}}>Time</th>
                  <th style={{padding:'10px 8px'}}>TXN</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.transferId} style={{borderBottom:'1px solid var(--ink-8)'}}>
                    <td style={{padding:'10px 8px'}}>{h.fromId} → {h.toId}</td>
                    <td className="tabular" style={{padding:'10px 8px', fontWeight:700}}>{h.amount}</td>
                    <td className="tabular" style={{padding:'10px 8px', color:'var(--ink-60)', fontSize:11}}>{new Date(h.txTimestamp).toLocaleDateString()}</td>
                    <td style={{padding:'10px 8px', fontFamily:'ui-monospace, monospace', fontSize:10, color:'var(--ink-40)'}}>{h.transferId.slice(0,12)}...</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
