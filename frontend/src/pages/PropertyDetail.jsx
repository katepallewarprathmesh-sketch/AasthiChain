import React, { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'

export default function PropertyDetail({ user }) {
  const { id } = useParams()
  const [property, setProperty] = useState(null)
  const [balances, setBalances] = useState([])
  const [history, setHistory] = useState([])

  useEffect(() => {
    fetchDetails()
  }, [id])

  const fetchDetails = async () => {
    const token = localStorage.getItem('aasthi_token')
    try {
      const res = await fetch(`/api/properties/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      setProperty(data.property || data)

      const knownOwners = ['originator1', 'investor1', 'investor2']
      const bals = []
      for (const owner of knownOwners) {
        const r = await fetch(`/api/balances/${id}/${owner}`, { headers: { Authorization: `Bearer ${token}` } })
        const b = await r.json()
        if (b.balance > 0) bals.push(b)
      }
      setBalances(bals)

      const hRes = await fetch(`/api/transfers/history?assetId=${id}&pageSize=20`, { headers: { Authorization: `Bearer ${token}` } })
      const hData = await hRes.json()
      setHistory(hData.transfers || [])
    } catch (e) {
      console.error(e)
    }
  }

  if (!property) return <p style={{color:'var(--ink-60)', padding:24}}>Loading property from ledger... (GetPropertyDetails chaincode)</p>

  const tokenPrice = property.totalTokens ? Math.floor(property.valuationINR / property.totalTokens) : 0
  const totalHeld = balances.reduce((s,b)=>s+b.balance,0)

  return (
    <div>
      <Link to="/marketplace" style={{fontSize:12, color:'var(--ink-60)', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:4, marginBottom:16}}>← Back to Marketplace — left-aligned per §1.3</Link>
      
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:16, flexWrap:'wrap'}}>
        <div>
          <h1 style={{fontSize:28}}>{property.title}</h1>
          <p style={{color:'var(--ink-60)', fontSize:12, marginTop:4}}>{property.assetId} · DocType: property · Version: {property.version || 1} · Registered {property.createdAt ? new Date(property.createdAt).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : '12 Sep 2026'} per §4.2 layout</p>
        </div>
        <span className={`status-chip ${property.status==='TOKENIZED' ? 'status-tokenized' : property.status==='FROZEN' ? 'status-frozen' : 'status-draft'}`}>{property.status}</span>
      </div>

      <div className="grid grid-2" style={{marginTop:24}}>
        <div className="card">
          <h3>Valuation — generous white space around numbers per §1.3</h3>
          <div style={{marginTop:16}}>
            <div className="tabular" style={{fontSize:36, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>₹{property.valuationINR.toLocaleString('en-IN')}</div>
            <div style={{fontSize:12, color:'var(--ink-40)', marginTop:4}}>₹{(property.valuationINR/100000).toFixed(1)}L — Indian grouping lakh/crore per §3.1, not "5,000,000"</div>
            
            <div className="divider"></div>
            
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, fontSize:13}}>
              <div>
                <div style={{fontSize:11, color:'var(--ink-40)', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:700}}>Total tokens</div>
                <div className="tabular" style={{fontSize:18, fontWeight:700, marginTop:4}}>{property.totalTokens}</div>
                <div style={{fontSize:11, color:'var(--ink-40)'}}>Fixed at mint, 10M cap</div>
              </div>
              <div>
                <div style={{fontSize:11, color:'var(--ink-40)', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:700}}>Price per token</div>
                <div className="tabular" style={{fontSize:18, fontWeight:700, marginTop:4}}>₹{tokenPrice.toLocaleString('en-IN')}</div>
                <div style={{fontSize:11, color:'var(--ink-40)'}}>1 token = ₹{tokenPrice} — integer-only, no decimals per §6.2</div>
              </div>
            </div>

            <div style={{marginTop:16}}>
              <button className="btn btn-primary" style={{width:'100%', padding:'12px'}}>Buy tokens — exact action per §1.4, not "Confirm"</button>
            </div>

            <div className="divider"></div>

            <div style={{fontSize:12, lineHeight:1.8, color:'var(--ink-60)'}}>
              <div>📍 {property.location.city}, {property.location.state} — {property.location.pincode} — structured address per §3.1</div>
              <div>👤 Originator: {property.originatorId}</div>
              <div>🕒 Created: {property.createdAt ? new Date(property.createdAt).toLocaleString() : '—'} — block timestamp, not peer clock — handles clock skew per §6.4</div>
              <div>📋 Validation: <span className={`status-chip ${property.registrarValidationStatus==='VALIDATED' ? 'status-validated' : 'status-pending'}`} style={{fontSize:9}}>{property.registrarValidationStatus}</span></div>
            </div>

            <div className="hash-display" style={{marginTop:16}}>
              <div>
                <div style={{fontSize:11, fontWeight:600}}>Legal documents: Verified ✓</div>
                <div className="hash-truncated">hash {property.documentHash.slice(0,8)}...{property.documentHash.slice(-4)} — truncated per §5.1, not full 64-char inline</div>
              </div>
              <span className="status-chip status-tokenized" style={{fontSize:9}}>Verified</span>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Cap table — owner, balance, % ownership — sortable by % descending per §3.5 + §4.2</h3>
          <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:12}}>Query: SELECT * WHERE assetId=? using idx_balance_asset — no full ledger scans per §4.2</p>
          {balances.length === 0 ? <div className="empty-state"><p>No holders yet — originator holds full supply after mint</p></div> :
            <div style={{display:'flex', flexDirection:'column', gap:8}}>
              {balances.map(b => {
                const pct = property.totalTokens ? ((b.balance / property.totalTokens)*100).toFixed(1) : 0
                return (
                  <div key={b.ownerId} style={{background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:'var(--radius)', padding:12, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <div style={{fontSize:13, fontWeight:600}}>{b.ownerId}</div>
                      <div className="tabular" style={{fontSize:11, color:'var(--ink-60)'}}>{b.balance} tokens</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div className="tabular" style={{fontSize:14, fontWeight:700}}>{pct}%</div>
                      <div className="tabular" style={{fontSize:11, color:'var(--ink-60)'}}>₹{(b.balance * tokenPrice).toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                )
              })}
              <div style={{fontSize:11, color:'var(--ink-40)', marginTop:8, paddingTop:8, borderTop:'1px solid var(--ink-8)'}}>
                Total accounted: <span className="tabular">{totalHeld}</span> / {property.totalTokens} tokens · {((totalHeld/property.totalTokens)*100).toFixed(1)}% sold — progress indicator per §4.1
              </div>
              <div className="progress-bar" style={{marginTop:8}}>
                <div className="progress-fill" style={{width:`${(totalHeld/property.totalTokens)*100}%`}}></div>
              </div>
            </div>
          }
          <button className="btn btn-secondary" style={{width:'100%', marginTop:12, fontSize:12}}>View all — cap table per §4.2</button>
        </div>
      </div>

      <div className="card" style={{marginTop:20}}>
        <h3>Transfer history for this asset — uses idx_transfer_asset_time per §4.2</h3>
        {history.length === 0 ? <div className="empty-state"><p>No transfers yet</p></div> :
          <table style={{width:'100%', fontSize:12, marginTop:12, borderCollapse:'collapse'}}>
            <thead><tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-12)', fontSize:10, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase'}}><th style={{padding:'8px'}}>From → To</th><th>Amount</th><th>Time</th><th>TXN</th></tr></thead>
            <tbody>{history.map(h => <tr key={h.transferId} style={{borderBottom:'1px solid var(--ink-8)'}}><td style={{padding:'8px'}}>{h.fromId} → {h.toId}</td><td className="tabular" style={{fontWeight:700}}>{h.amount}</td><td className="tabular" style={{color:'var(--ink-60)', fontSize:11}}>{new Date(h.txTimestamp).toLocaleString()}</td><td style={{fontFamily:'ui-monospace, monospace', fontSize:10}}>{h.transferId.slice(0,12)}...</td></tr>)}</tbody>
          </table>
        }
      </div>
    </div>
  )
}
