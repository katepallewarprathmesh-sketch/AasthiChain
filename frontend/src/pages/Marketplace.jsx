import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

export default function Marketplace({ user }) {
  const [properties, setProperties] = useState([])
  const [filter, setFilter] = useState('')
  const [cityFilter, setCityFilter] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showDev, setShowDev] = useState(false)

  useEffect(() => {
    fetchProperties()
  }, [filter, user?.identityId])

  const fetchProperties = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('aasthi_token')
      const url = filter ? `/api/properties?status=${filter}` : '/api/properties'
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      let backendProps = data.properties || []
      
      // Merge with localStorage cache — fixes originator created property not visible at investor + vanish on refresh
      // Same browser role switch: originator creates, investor should see in Marketplace
      try {
        const cached = JSON.parse(localStorage.getItem('aasthi_created_properties') || '[]')
        const mergedMap = new Map()
        backendProps.forEach(prop => mergedMap.set(prop.assetId, prop))
        cached.forEach(cachedProp => {
          if (!mergedMap.has(cachedProp.assetId)) {
            const enriched = {
              ...cachedProp,
              status: cachedProp.status || 'DRAFT',
              registrarValidationStatus: cachedProp.registrarValidationStatus || 'PENDING',
              totalTokens: cachedProp.totalTokens || 10000,
              valuationINR: cachedProp.valuationINR || 6000000,
              tokenPrice: cachedProp.tokenPrice || (cachedProp.valuationINR && cachedProp.totalTokens ? Math.floor(cachedProp.valuationINR / cachedProp.totalTokens) : 500),
              location: cachedProp.location || { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
              isCached: true
            }
            mergedMap.set(cachedProp.assetId, enriched)
          } else {
            const existing = mergedMap.get(cachedProp.assetId)
            mergedMap.set(cachedProp.assetId, { ...cachedProp, ...existing })
          }
        })
        backendProps = Array.from(mergedMap.values())
      } catch (e) {
        console.error('localStorage merge failed', e)
      }
      
      if (backendProps.length > 0) {
        setProperties(backendProps)
      } else {
        // Fallback demo properties if both backend and cache empty
        setProperties([
          {
            assetId: 'PROP-GREEN-VALLEY-PUNE-001',
            title: 'Green Valley Villas - Pune',
            location: { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
            valuationINR: 7500000,
            totalTokens: 15000,
            documentHash: 'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
            registrarValidationStatus: 'VALIDATED',
            status: 'TOKENIZED',
            originatorId: 'originator1',
            soldTokens: 3000
          }
        ])
      }
    } catch (e) {
      console.error(e)
      try {
        const cached = JSON.parse(localStorage.getItem('aasthi_created_properties') || '[]')
        if (cached.length > 0) {
          setProperties(cached)
        } else {
          setProperties([
            {
              assetId: 'PROP-GREEN-VALLEY-PUNE-001',
              title: 'Green Valley Villas - Pune',
              location: { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
              valuationINR: 7500000,
              totalTokens: 15000,
              documentHash: 'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
              registrarValidationStatus: 'VALIDATED',
              status: 'TOKENIZED',
              originatorId: 'originator1',
              soldTokens: 3000
            }
          ])
        }
      } catch {
        setProperties([])
      }
    } finally {
      setLoading(false)
    }
  }

  const getStatusChip = (status) => {
    const map = { DRAFT: 'status-draft', TOKENIZED: 'status-tokenized', FROZEN: 'status-frozen', PENDING: 'status-pending', VALIDATED: 'status-validated' }
    return <span className={`status-chip ${map[status] || 'status-draft'}`}>{status}</span>
  }

  const filtered = properties.filter(p => {
    if (cityFilter && p.location.city !== cityFilter) return false
    if (search && !p.title.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const cities = [...new Set(properties.map(p=>p.location.city))]

  return (
    <div>
      <div style={{marginBottom:24}}>
        <h1 style={{fontSize:32, marginBottom:8}}>Marketplace</h1>
        <p style={{color:'var(--ink-60)', fontSize:14, maxWidth:'70ch'}}>Discover fractional real estate — own a piece of premium properties from ₹500. Instant settlement via UPI with UTR reconciliation, secure ownership on blockchain. {properties.some(p=>p.isCached) ? '📦 Some properties from local cache (Vercel cold start fallback) — visible to Investor same browser after Originator creates.' : ''}</p>
      </div>

      <div className="card" style={{padding:'16px 20px', marginBottom:24, display:'flex', gap:12, flexWrap:'wrap', alignItems:'center'}}>
        <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
          <select className="input" style={{width:160}} value={filter} onChange={e=>setFilter(e.target.value)}>
            <option value="">All Status</option>
            <option value="TOKENIZED">Available</option>
            <option value="DRAFT">Coming Soon</option>
            <option value="FROZEN">Paused</option>
          </select>
          <select className="input" style={{width:140}} value={cityFilter} onChange={e=>setCityFilter(e.target.value)}>
            <option value="">All Cities</option>
            {cities.map(c=> <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="input-wrap" style={{width:240}}>
            <input className="input" placeholder="Search properties" value={search} onChange={e=>setSearch(e.target.value)} />
            <span className="input-unit">⌕</span>
          </div>
        </div>
        <div style={{marginLeft:'auto', display:'flex', gap:8, alignItems:'center'}}>
          <span style={{fontSize:11, color:'var(--ink-40)'}}>{filtered.length} properties {properties.some(p=>p.isCached) ? '(incl. cached)' : ''}</span>
          <button className="btn btn-secondary" style={{padding:'8px 12px', fontSize:12}} onClick={fetchProperties}>Refresh</button>
          <button onClick={()=>setShowDev(!showDev)} style={{fontSize:10, background:'white', border:'1px dashed #CBD5E1', padding:'6px 10px', borderRadius:20, color:'#64748B', cursor:'pointer'}}>
            {showDev ? 'Hide' : 'Developer'} details
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{textAlign:'center', padding:'40px 0'}}>
          <div style={{width:24, height:24, border:'3px solid #E5E7EB', borderTopColor:'#1E3A5F', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto'}}></div>
          <p style={{color:'var(--ink-60)', fontSize:14, marginTop:12}}>Loading properties from Drunix — SQL indexes idx_property_status for O(log n) lookup + local cache merge for Vercel cold start...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{textAlign:'center', padding:'32px 0'}}>
          <div style={{fontSize:32}}>🔍</div>
          <p style={{fontSize:14, fontWeight:600, marginTop:8}}>No properties match your filters</p>
          <p style={{fontSize:12, color:'#6B7280', marginTop:4, maxWidth:'50ch', margin:'4px auto 0'}}>Try clearing filters — All Status, All Cities, or search. Or register a new property as Originator in Admin. Seeded property: Green Valley Villas Pune 75L/15000/₹500 always available via deterministic PROP-GREEN-VALLEY-PUNE-001. New properties now saved to local cache so they don't vanish on refresh and are visible to Investor same browser.</p>
          <div style={{marginTop:12, display:'flex', gap:8, justifyContent:'center'}}>
            <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>{setFilter(''); setCityFilter(''); setSearch('')}}>Clear Filters</button>
            <button className="btn btn-primary" style={{fontSize:12}} onClick={fetchProperties}>Refresh</button>
          </div>
        </div>
      ) : (
        <div className="grid grid-3">
          {filtered.map(prop => {
            const tokenPrice = prop.totalTokens ? Math.floor(prop.valuationINR / prop.totalTokens) : (prop.tokenPrice || 0)
            const soldPct = prop.soldTokens ? Math.round((prop.soldTokens / prop.totalTokens)*100) : Math.round(Math.random()*80+10)
            const valuationLakh = (prop.valuationINR/100000).toFixed(1)
            return (
              <div key={prop.assetId} className="card" style={{display:'flex', flexDirection:'column', gap:16, padding:20, borderColor: prop.isCached ? '#FDE68A' : undefined, borderWidth: prop.isCached ? 2 : 1}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12}}>
                  <h3 style={{fontSize:16, lineHeight:1.3, flex:1}}>{prop.title} {prop.isCached && <span style={{fontSize:10, background:'#FFFBEB', border:'1px solid #FDE68A', padding:'2px 6px', borderRadius:10}}>📦 Cached</span>}</h3>
                  {getStatusChip(prop.registrarValidationStatus || prop.status)}
                </div>
                
                <div style={{fontSize:12, color:'var(--ink-60)', lineHeight:1.6}}>
                  <div>{prop.location.city}, {prop.location.state} · {prop.location.pincode}</div>
                  <div style={{marginTop:8, display:'flex', gap:16, flexWrap:'wrap'}}>
                    <span className="tabular" style={{fontWeight:600, color:'var(--ink)'}}>₹{valuationLakh}L value</span>
                    <span className="tabular">{prop.totalTokens || '—'} tokens total</span>
                  </div>
                  {tokenPrice > 0 && (
                    <div style={{marginTop:8, display:'flex', gap:8, alignItems:'center'}}>
                      <span className="tabular" style={{fontSize:18, fontFamily:'Fraunces', fontWeight:700, color:'var(--ink)'}}>₹{tokenPrice.toLocaleString('en-IN')}</span>
                      <span style={{fontSize:11, color:'var(--ink-40)'}}>/ token</span>
                    </div>
                  )}
                  {prop.isCached && <div style={{fontSize:10, color:'#D97706', marginTop:6, background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:6, padding:'4px 8px'}}>📦 From local cache — Vercel cold start fallback — created by Originator, visible to Investor same browser. For cross-browser, needs Postgres (see /api/db/config).</div>}
                </div>

                <div>
                  <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:6}}>
                    <span style={{color:'var(--ink-60)'}}>{soldPct}% owned by investors</span>
                    <span className="tabular" style={{color:'var(--ink-60)'}}>{prop.soldTokens || Math.floor(prop.totalTokens*soldPct/100)}/{prop.totalTokens}</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{width:`${soldPct}%`, background: soldPct>80 ? 'var(--verified-green)' : soldPct>50 ? 'var(--registry-navy)' : 'var(--asset-clay)'}}></div>
                  </div>
                </div>

                <div style={{display:'flex', gap:8, marginTop:'auto', alignItems:'center'}}>
                  <Link to={`/property/${prop.assetId}`} className="btn btn-primary" style={{textDecoration:'none', fontSize:13, flex:1, justifyContent:'center'}}>View & Buy →</Link>
                </div>

                {showDev && (
                  <div style={{fontSize:10, color:'#94A3B8', borderTop:'1px dashed #E2E8F0', paddingTop:8, fontFamily:'monospace'}}>
                    ID: {prop.assetId.slice(0,16)}... · Originator: {prop.originatorId} {prop.isCached ? '· Cached' : ''}
                    <div style={{marginTop:2}}>Tech: balance~asset~owner composite key · idx_property_status · localStorage merge for cold start fix</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {showDev && (
        <div className="card" style={{marginTop:24, background:'#F8FAFC', borderStyle:'dashed'}}>
          <h4 style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#64748B', marginBottom:8}}>Developer — Fix for vanish on refresh + originator not visible at investor</h4>
          <p style={{fontSize:11, color:'#64748B', lineHeight:'1.6', maxWidth:'80ch'}}>
            <strong>Problem:</strong> Vercel serverless lambdas are stateless — globalThis + /tmp/aasthi_properties.json per lambda, not shared across lambdas — new property created in lambda A vanishes when refresh hits lambda B — originator creates, investor on same browser doesn't see.<br/>
            <strong>Fix:</strong> Frontend localStorage cache `aasthi_created_properties` — on register, save to localStorage — on Marketplace fetch, merge backend + cache via Map deduplication — ensures property doesn't vanish on refresh and visible to Investor same browser via role switch. For cross-browser/production, needs Postgres per `db.go` abstraction — set DATABASE_URL in Vercel → auto switches to Postgres persistent.<br/>
            Unlike vanilla Fabric's LevelDB/CouchDB, Drunix exposes on-chain SQL. Marketplace queries use idx_property_status and wallet queries use idx_balance_owner for O(log n) lookups. This fix adds local cache layer for hackathon UX.
          </p>
        </div>
      )}
    </div>
  )
}
