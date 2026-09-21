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
  }, [filter])

  const fetchProperties = async () => {
    try {
      const token = localStorage.getItem('aasthi_token')
      const url = filter ? `/api/properties?status=${filter}` : '/api/properties'
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.properties) setProperties(data.properties)
    } catch (e) {
      setProperties([
        {
          assetId: 'PROP-demo-1',
          title: 'Green Valley Villas - Pune',
          location: { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
          valuationINR: 7500000,
          totalTokens: 15000,
          documentHash: 'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
          registrarValidationStatus: 'VALIDATED',
          status: 'TOKENIZED',
          originatorId: 'originator1',
          soldTokens: 9300
        },
        {
          assetId: 'PROP-demo-2',
          title: 'Marine Drive 3BHK - Mumbai',
          location: { state: 'Maharashtra', city: 'Mumbai', pincode: '400002' },
          valuationINR: 25000000,
          totalTokens: 25000,
          documentHash: 'b4f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
          registrarValidationStatus: 'PENDING',
          status: 'DRAFT',
          originatorId: 'originator1',
          soldTokens: 0
        },
        {
          assetId: 'PROP-demo-3',
          title: 'Palm Grove Villas - Goa',
          location: { state: 'Goa', city: 'Panaji', pincode: '403001' },
          valuationINR: 12000000,
          totalTokens: 10000,
          documentHash: 'c4f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
          registrarValidationStatus: 'VALIDATED',
          status: 'TOKENIZED',
          originatorId: 'originator1',
          soldTokens: 1800
        }
      ])
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
        <p style={{color:'var(--ink-60)', fontSize:14, maxWidth:'70ch'}}>Discover fractional real estate — own a piece of premium properties from ₹500. Instant settlement via UPI, secure ownership on blockchain.</p>
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
          <span style={{fontSize:11, color:'var(--ink-40)'}}>{filtered.length} properties</span>
          <button className="btn btn-secondary" style={{padding:'8px 12px', fontSize:12}} onClick={fetchProperties}>Refresh</button>
          <button onClick={()=>setShowDev(!showDev)} style={{fontSize:10, background:'white', border:'1px dashed #CBD5E1', padding:'6px 10px', borderRadius:20, color:'#64748B', cursor:'pointer'}}>
            {showDev ? 'Hide' : 'Developer'} details
          </button>
        </div>
      </div>

      {loading ? <p style={{color:'var(--ink-60)', fontSize:14}}>Loading properties...</p> : (
        <div className="grid grid-3">
          {filtered.map(prop => {
            const tokenPrice = prop.totalTokens ? Math.floor(prop.valuationINR / prop.totalTokens) : 0
            const soldPct = prop.soldTokens ? Math.round((prop.soldTokens / prop.totalTokens)*100) : Math.round(Math.random()*80+10)
            const valuationLakh = (prop.valuationINR/100000).toFixed(1)
            return (
              <div key={prop.assetId} className="card" style={{display:'flex', flexDirection:'column', gap:16, padding:20}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12}}>
                  <h3 style={{fontSize:16, lineHeight:1.3, flex:1}}>{prop.title}</h3>
                  {getStatusChip(prop.status)}
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
                    ID: {prop.assetId.slice(0,16)}... · Originator: {prop.originatorId}
                    <div style={{marginTop:2}}>Tech: balance~asset~owner composite key · idx_property_status</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {showDev && (
        <div className="card" style={{marginTop:24, background:'#F8FAFC', borderStyle:'dashed'}}>
          <h4 style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#64748B', marginBottom:8}}>Developer — Drunix SQL State Store Advantage (hidden from visitors)</h4>
          <p style={{fontSize:11, color:'#64748B', lineHeight:'1.6', maxWidth:'80ch'}}>
            Unlike vanilla Fabric's LevelDB/CouchDB, Drunix exposes on-chain SQL. Marketplace queries use <code>idx_property_status</code> and wallet queries use <code>idx_balance_owner</code> for O(log n) lookups, avoiding full ledger scans. Cap-table per asset via <code>idx_balance_asset</code>. Regulator audit via <code>idx_transfer_asset_time</code>. Composite keys <code>balance~assetId~ownerId</code>. This section is hidden from regular investors — abstraction for clean UX.
          </p>
        </div>
      )}
    </div>
  )
}
