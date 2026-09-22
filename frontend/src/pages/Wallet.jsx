import React, { useState, useEffect } from 'react'
import FailureModeDemo from '../components/FailureModeDemo.jsx'
import NPCIFailureModeDemo from '../components/NPCIFailureModeDemo.jsx'

export default function Wallet({ user }) {
  const [wallet, setWallet] = useState(null)
  const [loadingWallet, setLoadingWallet] = useState(true)
  const [transferForm, setTransferForm] = useState({ assetId: '', toId: 'investor2', amount: '' })
  const [history, setHistory] = useState([])
  const [pagination, setPagination] = useState({ bookmark: '', hasMore: false, total: 0 })
  const [txStatus, setTxStatus] = useState(null)
  const [confirmStep, setConfirmStep] = useState(false)
  const [msg, setMsg] = useState('')
  const [testnetPayments, setTestnetPayments] = useState([])
  const [npciPayments, setNpciPayments] = useState([])
  const [activeTab, setActiveTab] = useState('holdings')
  const [showDev, setShowDev] = useState(false)

  const fetchWallet = async () => {
    setLoadingWallet(true)
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const res = await fetch(`/api/balances/wallet/${encodeURIComponent(user.identityId)}`, { 
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      })
      if (!res.ok) {
        // Try to parse error but don't throw 500 to UI — return empty gracefully
        let errText = `Wallet fetch ${res.status}`
        try { const j = await res.json(); errText = j.error || errText } catch {}
        throw new Error(errText)
      }
      const data = await res.json()
      setWallet(data)
      setTransferForm(prev => {
        if (prev.assetId) return prev
        if (data.balances && data.balances.length > 0) {
          return { ...prev, assetId: data.balances[0].balance?.assetId || '' }
        }
        return prev
      })
    } catch (e) {
      console.error('fetchWallet error', e)
      // Graceful fallback — no scary technical message, just empty portfolio
      setWallet({ balances: [], totalPortfolioValue: 0 })
    } finally {
      setLoadingWallet(false)
    }
  }

  const fetchHistory = async (bookmark = '', append = false) => {
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const pageSize = 10
      const url = `/api/transfers/history?ownerId=${encodeURIComponent(user.identityId)}&pageSize=${pageSize}&bookmark=${encodeURIComponent(bookmark)}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (append) {
        setHistory(h => [...h, ...(data.transfers || [])])
      } else {
        setHistory(data.transfers || [])
      }
      setPagination({ bookmark: data.bookmark || '', hasMore: !!data.hasMore, total: data.total || 0 })
    } catch (e) {
      console.error('fetchHistory error', e)
    }
  }

  const fetchNpciPayments = async () => {
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const res = await fetch('/api/npci/payments', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setNpciPayments(data.payments || [])
    } catch (e) {
      setNpciPayments([])
    }
  }

  const fetchTestnetPayments = async () => {
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const res = await fetch('/api/testnet/payments', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) {
        const r2 = await fetch('/api/testnet/payments')
        if (!r2.ok) return
        const d2 = await r2.json()
        setTestnetPayments(d2.payments || [])
        return
      }
      const data = await res.json()
      setTestnetPayments(data.payments || [])
    } catch (e) {
      setTestnetPayments([])
    }
  }

  useEffect(() => {
    let mounted = true
    const init = async () => {
      if (!mounted) return
      await fetchWallet()
      await fetchHistory()
      await fetchNpciPayments()
      await fetchTestnetPayments()
    }
    init()
    return () => { mounted = false }
  }, [user.identityId])

  const getTokenPrice = () => {
    try {
      if (!wallet || !wallet.balances || !transferForm.assetId) return 500
      const item = wallet.balances.find(b => b.balance?.assetId === transferForm.assetId)
      return item ? (item.tokenPrice || 500) : 500
    } catch { return 500 }
  }

  const getMaxBalance = () => {
    try {
      if (!wallet || !wallet.balances || !transferForm.assetId) return 0
      const item = wallet.balances.find(b => b.balance?.assetId === transferForm.assetId)
      return item ? (item.balance?.balance || 0) : 0
    } catch { return 0 }
  }

  const handleTransfer = async (e) => {
    if (e) e.preventDefault()
    if (!confirmStep) {
      setConfirmStep(true)
      return
    }
    setTxStatus({ step: 'submitting', transferId: null })
    setMsg('')
    try {
      setTimeout(() => setTxStatus(s => s ? { ...s, step: 'endorsing' } : null), 400)
      setTimeout(() => setTxStatus(s => s ? { ...s, step: 'committing' } : null), 900)
      const token = localStorage.getItem('aasthi_token') || ''
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          assetId: transferForm.assetId,
          toId: transferForm.toId,
          amount: parseInt(transferForm.amount) || 0
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Transfer failed')
      setTimeout(() => {
        setTxStatus({ step: 'confirmed', transferId: data.transferId })
        setMsg(`Transfer confirmed — ${data.transferId}`)
        fetchWallet()
        fetchHistory()
        setConfirmStep(false)
      }, 1400)
    } catch (err) {
      setTxStatus(null)
      setConfirmStep(false)
      setMsg(`Transfer failed — ${err.message}`)
    }
  }

  let tokenPrice = 500, maxBal = 0, amountNum = 0, estimatedValue = 0, isOverBalance = false
  try {
    tokenPrice = getTokenPrice()
    maxBal = getMaxBalance()
    amountNum = parseInt(transferForm.amount) || 0
    estimatedValue = amountNum * tokenPrice
    isOverBalance = amountNum > maxBal
  } catch {}

  // Human-friendly error messages per §1.4 voice — trust-critical moment, no "Oops!"
  const getFriendlyError = (msg) => {
    if (!msg) return ''
    if (msg.includes('ERR_INSUFFICIENT_BALANCE')) {
      const match = msg.match(/have (\d+) need (\d+)/)
      if (match) return `You hold ${match[1]} tokens, this transfer requires ${match[2]}. Reduce amount or buy more from Marketplace.`
      return 'Insufficient tokens — you cannot transfer more than you own. No partial transfers per atomic design.'
    }
    if (msg.includes('ERR_INVALID_TRANSFER')) return 'Self-transfer not allowed — you cannot send tokens to yourself.'
    if (msg.includes('ERR_KYC_NOT_VERIFIED')) return 'Receiver KYC not verified — per Asset Tokenisation Bill 2026, receiver must be VERIFIED. Ask them to complete KYC.'
    if (msg.includes('ERR_ASSET_FROZEN')) return 'Asset frozen by Regulator — no transfers possible until unfrozen. Safety action per §3.5.'
    if (msg.includes('ERR_BALANCE_NOT_FOUND')) return 'Balance not found — property may be on different server instance due to Vercel cold start. Backend auto-creates balance for demo — try again, second attempt should work. Or check Marketplace balances.'
    return msg
  }


  if (loadingWallet && !wallet) {
    return (
      <div style={{padding:40, textAlign:'center'}}>
        <div style={{width:24, height:24, border:'3px solid #E5E7EB', borderTopColor:'#1E3A5F', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto'}}></div>
        <div style={{fontSize:13, color:'#6B7280', marginTop:12}}>Loading your portfolio...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  return (
    <div>
      {/* Header — clean, no tech */}
      <div style={{marginBottom:24}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12}}>
          <div>
            <h1 style={{fontSize:28, marginBottom:4}}>My Portfolio</h1>
            <p style={{color:'#6B7280', fontSize:13, maxWidth:'70ch'}}>
              Your fractional property ownership — secure, instant, and tradable. Payments via UPI, ownership on blockchain.
            </p>
          </div>
          <div style={{display:'flex', gap:6, flexWrap:'wrap', alignItems:'center'}}>
            {[
              {id:'holdings', label:'Holdings'},
              {id:'transfer', label:'Transfer'},
              {id:'npciHistory', label:`Payments (${npciPayments.length})`},
            ].map(tab => (
              <button key={tab.id} onClick={()=>setActiveTab(tab.id)}
                style={{
                  fontSize:12, fontWeight:600, padding:'8px 14px', borderRadius:8,
                  border: activeTab===tab.id ? '2px solid #1E3A5F' : '1px solid #E5E7EB',
                  background: activeTab===tab.id ? '#1E3A5F' : 'white',
                  color: activeTab===tab.id ? 'white' : '#6B7280', cursor:'pointer'
                }}>
                {tab.label}
              </button>
            ))}
            <button onClick={()=>setShowDev(!showDev)} style={{fontSize:10, background:'white', border:'1px dashed #CBD5E1', padding:'6px 10px', borderRadius:20, color:'#64748B', cursor:'pointer'}}>
              {showDev ? 'Hide' : 'Developer'}
            </button>
          </div>
        </div>
      </div>

      {/* Top Stats — clean */}
      <div className="grid grid-3" style={{marginBottom:24}}>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#9CA3AF', marginBottom:8}}>Total Value</div>
          <div style={{fontSize:28, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>₹{wallet ? (Number(wallet.totalPortfolioValue||0)/100000).toFixed(2) : '0'}L</div>
          <div style={{fontSize:11, color:'#9CA3AF', marginTop:6}}>Across {wallet?.balances?.length||0} properties</div>
        </div>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#9CA3AF', marginBottom:8}}>Properties Owned</div>
          <div style={{fontSize:28, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>{wallet?.balances?.length||0}</div>
          <div style={{fontSize:11, color:'#9CA3AF', marginTop:6}}>{npciPayments.length} payments · {history.length} transfers</div>
        </div>
        <div className="card" style={{borderLeft:`3px solid #059669`}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#9CA3AF', marginBottom:8}}>Account Status</div>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <span style={{fontSize:14, fontWeight:700, color:'#059669'}}>Verified</span>
            <span style={{fontSize:10, background:'#F0FDF4', color:'#059669', border:'1px solid #BBF7D0', padding:'2px 6px', borderRadius:4}}>KYC ✓</span>
          </div>
          <div style={{fontSize:11, color:'#9CA3AF', marginTop:6}}>Ready to trade</div>
        </div>
      </div>

      {showDev && (
        <div style={{background:'#F8FAFC', border:'1px dashed #CBD5E1', borderRadius:8, padding:'12px 16px', marginBottom:20}}>
          <div style={{fontSize:11, fontWeight:700, color:'#64748B', textTransform:'uppercase'}}>Developer Details (hidden from visitors)</div>
          <div style={{fontSize:11, color:'#64748B', marginTop:6, lineHeight:1.6}}>
            <div>Composite key: <code>balance~assetId~ownerId</code> · Indexes: <code>idx_balance_owner</code>, <code>idx_balance_asset</code>, <code>idx_property_status</code>, <code>idx_transfer_asset_time</code></div>
            <div>FabricMode: {wallet?.fabricMode || 'mock (Vercel)'} · SQL state store O(log n) · MVCC double-spend protection · Tabular numbers · Block timestamp from orderer</div>
            <div>Payment rails: Primary UPI Collect P2M + IMPS UTR (INR) simulation · Secondary Sepolia PaymentEscrow.sol experimental</div>
          </div>
        </div>
      )}

      {activeTab==='holdings' && (
        <div className="grid grid-2">
          <div className="card">
            <h3 style={{fontSize:16, fontWeight:600}}>Your Holdings</h3>
            <p style={{fontSize:11, color:'#9CA3AF', marginBottom:12}}>Fractional ownership in premium properties</p>
            {!wallet || !wallet.balances || wallet.balances.length===0 ? (
              <div style={{textAlign:'center', padding:'32px 0', color:'#6B7280'}}>
                <div style={{fontSize:32}}>🏠</div>
                <p style={{fontSize:13, marginTop:8, fontWeight:600}}>No properties yet — start investing from ₹500</p>
                <p style={{fontSize:11, marginTop:4, color:'#9CA3AF', maxWidth:'40ch', margin:'4px auto 0', lineHeight:1.5}}>Your portfolio is empty. Browse Marketplace → Green Valley Villas Pune (₹75L, 15k tokens @ ₹500) → Buy 100 tokens for ₹50k via UPI Collect P2M. Payment and tokens move together atomically — no risk. Try Quick Demo Access on landing if you haven't logged in.</p>
                <div style={{marginTop:12, display:'flex', gap:8, justifyContent:'center', flexWrap:'wrap'}}>
                  <a href="/marketplace" className="btn btn-primary" style={{fontSize:12, padding:'8px 14px', textDecoration:'none'}}>Explore Marketplace →</a>
                  <button className="btn btn-secondary" style={{fontSize:11, padding:'8px 12px'}} onClick={fetchWallet}>Refresh Portfolio</button>
                </div>
              </div>
            ) : (
              <div style={{display:'flex', flexDirection:'column', gap:10}}>
                {wallet.balances.map((item, i) => {
                  try {
                    return (
                      <div key={i} style={{background:'#F9FAFB', border:'1px solid #E5E7EB', borderRadius:10, padding:14, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                        <div>
                          <div style={{fontSize:13, fontWeight:600}}>{item.propertyTitle || item.balance?.assetId?.slice(0,20) || 'Property'}</div>
                          <div style={{fontSize:11, color:'#6B7280', marginTop:2}}>₹{item.tokenPrice||0} per token</div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <div style={{fontSize:18, fontFamily:'Fraunces', fontWeight:700}}>{item.balance?.balance||0}</div>
                          <div style={{fontSize:10, color:'#9CA3AF', textTransform:'uppercase', fontWeight:700}}>tokens</div>
                          <div style={{fontSize:11, color:'#6B7280', marginTop:4}}>₹{Number(item.valueINR||0).toLocaleString('en-IN')}</div>
                        </div>
                      </div>
                    )
                  } catch {
                    return <div key={i} style={{fontSize:11, color:'#DC2626'}}>Error rendering holding</div>
                  }
                })}
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{fontSize:16, fontWeight:600}}>Quick Transfer</h3>
            <p style={{fontSize:11, color:'#9CA3AF', marginBottom:12}}>Send tokens to another investor — instant settlement</p>
            <form onSubmit={handleTransfer} style={{display:'flex', flexDirection:'column', gap:12}}>
              <div>
                <label style={{fontSize:11, fontWeight:600, color:'#6B7280'}}>Property</label>
                <input className="input" style={{marginTop:4, width:'100%'}} value={transferForm.assetId} onChange={e=>setTransferForm({...transferForm, assetId:e.target.value})} placeholder="Select property" required />
              </div>
              <div>
                <label style={{fontSize:11, fontWeight:600, color:'#6B7280'}}>Send to</label>
                <input className="input" style={{marginTop:4, width:'100%'}} value={transferForm.toId} onChange={e=>setTransferForm({...transferForm, toId:e.target.value})} required placeholder="Investor ID" />
              </div>
              <div>
                <label style={{fontSize:11, fontWeight:600, color:'#6B7280'}}>Tokens</label>
                <div style={{display:'flex', gap:6, marginTop:4}}>
                  <input className={`input ${isOverBalance ? 'error' : ''}`} style={{flex:1}} type="number" min="1" value={transferForm.amount} onChange={e=>setTransferForm({...transferForm, amount:e.target.value})} required placeholder="Amount" />
                </div>
                {transferForm.amount && (
                  <div style={{fontSize:11, marginTop:6, color: isOverBalance ? '#DC2626' : '#6B7280'}}>
                    {isOverBalance ? `You have ${maxBal}, need ${amountNum}` : `${amountNum} tokens = ₹${estimatedValue.toLocaleString('en-IN')} · Max ${maxBal}`}
                  </div>
                )}
                <div style={{display:'flex', gap:6, marginTop:8}}>
                  {[0.25,0.5,0.75,1].map(pct => (
                    <button key={pct} type="button" onClick={()=>setTransferForm({...transferForm, amount: String(Math.floor(maxBal*pct)||0)})}
                      style={{fontSize:10, fontWeight:600, padding:'4px 8px', borderRadius:6, border:'1px solid #E5E7EB', background:'white', cursor:'pointer'}}>
                      {pct===1 ? 'Max' : `${pct*100}%`}
                    </button>
                  ))}
                </div>
              </div>

              <button type="submit" className="btn btn-primary" disabled={isOverBalance || !transferForm.amount} style={{width:'100%', padding:'12px'}}>
                {confirmStep ? 'Confirm Transfer' : 'Send Tokens →'}
              </button>
            </form>

            {txStatus && (
              <div style={{marginTop:12, background:'#F9FAFB', border:'1px solid #E5E7EB', borderRadius:8, padding:12}}>
                <div style={{fontSize:11, fontWeight:600, marginBottom:8}}>Processing...</div>
                {['submitting','endorsing','committing','confirmed'].map(s => (
                  <div key={s} style={{display:'flex', alignItems:'center', gap:8, fontSize:12, padding:'3px 0', color: txStatus.step===s ? '#1E3A5F' : '#9CA3AF'}}>
                    <span>{txStatus.step===s ? '⟳' : (['submitting','endorsing','committing'].indexOf(txStatus.step) > ['submitting','endorsing','committing'].indexOf(s) || txStatus.step==='confirmed') ? '✓' : '○'}</span>
                    <span style={{textTransform:'capitalize'}}>{s}</span>
                  </div>
                ))}
              </div>
            )}
            {msg && <div style={{marginTop:10, padding:'10px 12px', borderRadius:8, fontSize:12, lineHeight:1.5, background: msg.includes('failed') ? '#FEF2F2' : '#F0FDF4', color: msg.includes('failed') ? '#991B1B' : '#065F46', border: `1px solid ${msg.includes('failed') ? '#FECACA' : '#BBF7D0'}`}}>{getFriendlyError(msg)}</div>}
          </div>
        </div>
      )}

      {activeTab==='transfer' && (
        <div className="card">
          <h3>Transfer Tokens</h3>
          <p style={{fontSize:11, color:'#9CA3AF', marginTop:4}}>Direct transfer without payment rail — for primary UPI payments, use Property page → Buy Tokens</p>
          <form onSubmit={handleTransfer} style={{display:'flex', flexDirection:'column', gap:10, marginTop:12, maxWidth:480}}>
            <input className="input" value={transferForm.assetId} onChange={e=>setTransferForm({...transferForm, assetId:e.target.value})} placeholder="Property ID" required />
            <input className="input" value={transferForm.toId} onChange={e=>setTransferForm({...transferForm, toId:e.target.value})} placeholder="Recipient" required />
            <input className="input" type="number" value={transferForm.amount} onChange={e=>setTransferForm({...transferForm, amount:e.target.value})} placeholder="Amount" required />
            <div style={{fontSize:11, color:'#6B7280'}}>Value: ₹{estimatedValue.toLocaleString('en-IN')} · Max {maxBal}</div>
            <button type="submit" className="btn btn-primary">Transfer</button>
          </form>
          {msg && <div style={{marginTop:10, fontSize:11}}>{msg}</div>}
        </div>
      )}

      {activeTab==='npciHistory' && (
        <div className="card">
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8}}>
            <div>
              <h3>Payment History — UPI</h3>
              <p style={{fontSize:11, color:'#9CA3AF'}}>Your INR payments with instant settlement</p>
            </div>
            <button className="btn btn-secondary" style={{fontSize:11}} onClick={fetchNpciPayments}>Refresh</button>
          </div>

          {npciPayments.length===0 ? (
            <div style={{textAlign:'center', padding:'32px 0', color:'#6B7280'}}>
              <p style={{fontSize:13}}>No payments yet</p>
              <p style={{fontSize:11, marginTop:4, color:'#9CA3AF'}}>Buy tokens from a property page to see payments here</p>
            </div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:12, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'#9CA3AF', textAlign:'left', borderBottom:'1px solid #E5E7EB', fontSize:10, fontWeight:700, textTransform:'uppercase'}}><th style={{padding:'8px'}}>Property</th><th>Tokens</th><th>Amount</th><th>To</th><th>Status</th><th>Date</th></tr></thead>
                <tbody>
                  {npciPayments.map((p, i) => (
                    <tr key={i} style={{borderBottom:'1px solid #F3F4F6'}}>
                      <td style={{padding:'8px', fontSize:11}}>{(p.assetId||'').slice(0,12)}...</td>
                      <td style={{padding:'8px'}}>{p.tokenAmount||0}</td>
                      <td style={{padding:'8px', fontWeight:700}}>₹{Number(p.amountINR||0).toLocaleString('en-IN')}</td>
                      <td style={{padding:'8px', fontSize:11}}>{p.payeeVpa||''}</td>
                      <td style={{padding:'8px'}}><span style={{fontSize:10, background: p.status==='RELEASED' ? '#F0FDF4' : p.status==='PENDING' ? '#FFFBEB' : '#FEF2F2', color: p.status==='RELEASED' ? '#065F46' : p.status==='PENDING' ? '#92400E' : '#991B1B', padding:'3px 8px', borderRadius:12, fontWeight:600}}>{p.status||'PENDING'}</span></td>
                      <td style={{padding:'8px', fontSize:11, color:'#6B7280'}}>{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {showDev && (
            <div style={{marginTop:12, background:'#F8FAFC', border:'1px dashed #E2E8F0', borderRadius:6, padding:10, fontSize:10, color:'#64748B'}}>
              Dev: UPI Txn ID, RRN, UTR, drunixTransferId, idempotencyKey, paise int64, expiry 5min — hidden from regular investors.
              <div style={{marginTop:4, fontFamily:'monospace'}}>{npciPayments[0]?.upiTxnId || ''} · RRN {npciPayments[0]?.rrn || ''} · UTR {npciPayments[0]?.utr || ''}</div>
            </div>
          )}
        </div>
      )}

      {/* Recent activity — clean */}
      <div className="card" style={{marginTop:20}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10, flexWrap:'wrap', gap:8}}>
          <div>
            <h3 style={{fontSize:14}}>Recent Activity</h3>
            <p style={{fontSize:11, color:'#9CA3AF'}}>{pagination.total} transfers · {npciPayments.length} payments</p>
          </div>
          <span style={{fontSize:11, color:'#9CA3AF'}}>{history.length}/{pagination.total}</span>
        </div>
        {history.length===0 ? (
          <div style={{textAlign:'center', padding:'20px 0', color:'#9CA3AF', fontSize:12}}>No activity yet</div>
        ) : (
          <>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:12, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'#9CA3AF', textAlign:'left', borderBottom:'1px solid #E5E7EB', fontSize:10, fontWeight:700, textTransform:'uppercase'}}><th style={{padding:'8px'}}>Property</th><th>From → To</th><th>Tokens</th><th>Date</th></tr></thead>
                <tbody>
                  {history.map(tx => (
                    <tr key={tx.transferId} style={{borderBottom:'1px solid #F3F4F6'}}>
                      <td style={{padding:'8px', fontSize:11}}>{tx.assetId.slice(0,12)}...</td>
                      <td style={{padding:'8px', fontSize:11}}>{tx.fromId} → {tx.toId}</td>
                      <td style={{padding:'8px', fontWeight:600}}>{tx.amount}</td>
                      <td style={{padding:'8px', fontSize:11, color:'#6B7280'}}>{new Date(tx.txTimestamp).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination.hasMore && (
              <button className="btn btn-secondary" style={{marginTop:12, fontSize:11}} onClick={() => fetchHistory(pagination.bookmark, true)}>
                Load more
              </button>
            )}
          </>
        )}
      </div>

      {showDev ? (
        <>
          <FailureModeDemo user={user} />
          <NPCIFailureModeDemo />
        </>
      ) : (
        <div style={{marginTop:16, textAlign:'center'}}>
          <button onClick={()=>setShowDev(true)} style={{fontSize:11, background:'white', border:'1px dashed #CBD5E1', padding:'8px 14px', borderRadius:20, color:'#64748B', cursor:'pointer'}}>
            Show developer tools — failure modes, SQL indexes, composite keys
          </button>
        </div>
      )}
    </div>
  )
}
