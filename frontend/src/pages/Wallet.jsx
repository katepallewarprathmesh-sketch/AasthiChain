import React, { useState, useEffect } from 'react'
import FailureModeDemo from '../components/FailureModeDemo.jsx'
import NPCIFailureModeDemo from '../components/NPCIFailureModeDemo.jsx'

function ErrorFallback({ error, reset }) {
  return (
    <div style={{background:'rgba(161,61,46,0.08)', border:'1px solid rgba(161,61,46,0.2)', borderRadius:8, padding:16, marginBottom:16}}>
      <div style={{fontWeight:700, color:'var(--error-rust)', fontSize:14}}>Wallet render error — recovered</div>
      <div style={{fontSize:12, color:'var(--ink-60)', marginTop:6, fontFamily:'ui-monospace, monospace', whiteSpace:'pre-wrap'}}>{String(error?.message || error)}</div>
      <button className="btn btn-secondary" style={{marginTop:12, fontSize:12}} onClick={reset}>Reload Wallet</button>
    </div>
  )
}

export default function Wallet({ user }) {
  const [wallet, setWallet] = useState(null)
  const [loadingWallet, setLoadingWallet] = useState(true)
  const [transferForm, setTransferForm] = useState({ assetId: '', toId: 'investor2', amount: '' })
  const [history, setHistory] = useState([])
  const [pagination, setPagination] = useState({ bookmark: '', hasMore: false, total: 0, pageSize: 10 })
  const [txStatus, setTxStatus] = useState(null)
  const [confirmStep, setConfirmStep] = useState(false)
  const [msg, setMsg] = useState('')
  const [testnetPayments, setTestnetPayments] = useState([])
  const [npciPayments, setNpciPayments] = useState([])
  const [testnetConfig, setTestnetConfig] = useState(null)
  const [npciConfig, setNpciConfig] = useState(null)
  const [activeTab, setActiveTab] = useState('holdings')
  const [error, setError] = useState(null)

  const fetchWallet = async () => {
    setLoadingWallet(true)
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const res = await fetch(`/api/balances/wallet/${user.identityId}`, { 
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      })
      if (!res.ok) throw new Error(`Wallet fetch ${res.status}`)
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
      setWallet({ balances: [], totalPortfolioValue: 0, fabricMode: 'mock' })
      setError(e.message)
    } finally {
      setLoadingWallet(false)
    }
  }

  const fetchHistory = async (bookmark = '', append = false) => {
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const pageSize = 10
      const url = `/api/transfers/history?ownerId=${user.identityId}&pageSize=${pageSize}&bookmark=${encodeURIComponent(bookmark)}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) throw new Error(`History ${res.status}`)
      const data = await res.json()
      if (append) {
        setHistory(h => [...h, ...(data.transfers || [])])
      } else {
        setHistory(data.transfers || [])
      }
      setPagination({ bookmark: data.bookmark || '', hasMore: !!data.hasMore, total: data.total || 0, pageSize })
    } catch (e) {
      console.error('fetchHistory error', e)
    }
  }

  const fetchTestnetPayments = async () => {
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const res = await fetch('/api/testnet/payments', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) {
        const r2 = await fetch('/api/testnet/payments')
        if (!r2.ok) throw new Error('testnet payments fetch failed')
        const d2 = await r2.json()
        setTestnetPayments(d2.payments || [])
        return
      }
      const data = await res.json()
      setTestnetPayments(data.payments || [])
    } catch (e) {
      console.error('fetchTestnetPayments error', e)
      setTestnetPayments([])
    }
  }

  const fetchNpciPayments = async () => {
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const res = await fetch('/api/npci/payments', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) throw new Error('npci payments fetch failed')
      const data = await res.json()
      setNpciPayments(data.payments || [])
    } catch (e) {
      console.error('fetchNpciPayments', e)
      setNpciPayments([])
    }
  }

  const fetchTestnetConfig = async () => {
    try {
      const res = await fetch('/api/testnet/config', { cache: 'no-store' })
      if (!res.ok) throw new Error('config fetch failed')
      const data = await res.json()
      setTestnetConfig(data)
    } catch (e) {
      setTestnetConfig({ chainId: '0xaa36a7', chainName: 'Sepolia Testnet', explorer: 'https://sepolia.etherscan.io', faucet: 'https://sepoliafaucet.com/' })
    }
  }

  const fetchNpciConfig = async () => {
    try {
      const res = await fetch('/api/npci/config', { cache: 'no-store' })
      if (!res.ok) throw new Error('npci config fetch failed')
      const data = await res.json()
      setNpciConfig(data)
    } catch {
      setNpciConfig({ rail: 'UPI Collect P2M', currency: 'INR', isSimulation: true })
    }
  }

  useEffect(() => {
    let mounted = true
    const init = async () => {
      if (!mounted) return
      await fetchWallet()
      await fetchHistory()
      await fetchTestnetPayments()
      await fetchNpciPayments()
      await fetchTestnetConfig()
      await fetchNpciConfig()
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
      if (!res.ok) throw new Error(data.error || data.message || 'Transfer failed')
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

  let tokenPrice = 500, maxBal = 0, amountNum = 0, estimatedValue = 0, estimatedEth = '0.0010', isOverBalance = false
  try {
    tokenPrice = getTokenPrice()
    maxBal = getMaxBalance()
    amountNum = parseInt(transferForm.amount) || 0
    estimatedValue = amountNum * tokenPrice
    const raw = estimatedValue / 20000
    estimatedEth = Math.max(raw, 0.001).toFixed(4)
    isOverBalance = amountNum > maxBal
  } catch {}

  if (loadingWallet && !wallet) {
    return (
      <div>
        <div style={{padding:40, textAlign:'center'}}>
          <div style={{fontSize:14, color:'var(--ink-60)'}}>Loading wallet — fetching balances from Drunix + NPCI UPI rail + Sepolia secondary...</div>
          <div style={{marginTop:12, fontSize:12, color:'var(--ink-40)'}}>Composite key: balance~assetId~ownerId · Index idx_balance_owner · NPCI UTR reconciliation</div>
        </div>
      </div>
    )
  }

  return (
    <div>
      {error && (
        <div style={{background:'rgba(161,61,46,0.08)', border:'1px solid rgba(161,61,46,0.15)', padding:'10px 12px', borderRadius:6, fontSize:12, color:'var(--error-rust)', marginBottom:16}}>
          Wallet load warning: {error} — showing mock fallback. Refresh if needed.
        </div>
      )}

      <div style={{marginBottom:24}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12}}>
          <div>
            <h1 style={{fontSize:28, marginBottom:4, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
              My Wallet
              <span style={{background:'#1E3A5F', color:'white', fontSize:10, padding:'3px 8px', borderRadius:4, fontWeight:700}}>PRIMARY: UPI (INR)</span>
              <span style={{background:'#E7E5E4', color:'#57534E', fontSize:10, padding:'3px 8px', borderRadius:4, border:'1px dashed #A8A29E'}}>Secondary: Sepolia</span>
            </h1>
            <p style={{color:'var(--ink-60)', fontSize:12, maxWidth:'80ch'}}>
              Portfolio from Drunix (property tokens) + <strong>PRIMARY: NPCI UPI Collect P2M + IMPS UTR (INR)</strong> — simulation, no live NPCI — demonstrating atomic DvP · Secondary: Sepolia testnet escrow experimental cross-chain pattern · KYC always visible
            </p>
          </div>
          <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
            {[
              {id:'holdings', label:'Holdings'},
              {id:'transfer', label:'Transfer'},
              {id:'npciHistory', label:`UPI Payments (${npciPayments.length})`},
              {id:'testnetHistory', label:`Sepolia (${testnetPayments.length})`}
            ].map(tab => (
              <button key={tab.id} onClick={()=>setActiveTab(tab.id)}
                style={{
                  fontSize:11, fontWeight:700, padding:'7px 12px', borderRadius:6,
                  border: activeTab===tab.id ? '2px solid var(--registry-navy)' : '1px solid var(--ink-12)',
                  background: activeTab===tab.id ? 'var(--registry-navy)' : 'var(--paper)',
                  color: activeTab===tab.id ? 'white' : 'var(--ink-60)', cursor:'pointer'
                }}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-3" style={{marginBottom:24}}>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>Total Portfolio Value</div>
          <div className="tabular" style={{fontSize:28, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>₹{wallet ? (Number(wallet.totalPortfolioValue||0)/100000).toFixed(2) : '0'}L</div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>≈ {(wallet ? Number(wallet.totalPortfolioValue||0)/200000 : 0).toFixed(2)} SepoliaETH @ ₹20k/ETH · tokenPrice × balance</div>
        </div>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>Assets + UPI + Escrows</div>
          <div className="tabular" style={{fontSize:28, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>{wallet?.balances?.length||0} + {npciPayments.length} + {testnetPayments.length}</div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>FabricMode: {wallet?.fabricMode||'mock'} · {npciPayments.length} UPI · {testnetPayments.length} Sepolia</div>
        </div>
        <div className="card" style={{borderLeft:`3px solid var(--verified-green)`}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>KYC + Rails</div>
          <div style={{display:'flex', alignItems:'center', gap:6, flexWrap:'wrap'}}>
            <span style={{fontSize:13, fontWeight:700, color:'var(--verified-green)'}}>Verified</span>
            <span className="status-chip status-tokenized" style={{fontSize:9}}>KYC ✓</span>
            <span style={{fontSize:9, background:'#1E3A5F', color:'white', padding:'2px 6px', borderRadius:4}}>UPI Primary</span>
            <span style={{fontSize:9, background:'#E7E5E4', color:'#57534E', padding:'2px 6px', borderRadius:4, border:'1px dashed #A8A29E'}}>Sepolia Secondary</span>
          </div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>DigiLocker mock · UPI VPA investor@aasthichain · MetaMask Sepolia experimental</div>
        </div>
      </div>

      {npciConfig && (
        <div style={{background:'#1E3A5F', color:'white', borderRadius:8, padding:'12px 16px', marginBottom:16, display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
          <div style={{fontSize:12}}>
            <strong>💸 Primary: UPI Collect P2M + IMPS UTR (INR) — Simulation</strong> — {npciConfig.rail} · VPA: investor@aasthichain → originator@aasthichain · RRN 12-digit · UTR IMPS+RRN · Expiry 5 min · Idempotency X-Idempotency-Key · Atomic DvP with Drunix TransferTokens · No live NPCI credentials
          </div>
          <div style={{fontSize:10, background:'rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:4}}>INR Paise int64 · SIMULATION</div>
        </div>
      )}

      {testnetConfig && (
        <div style={{background:'white', border:'1px dashed #E7E5E4', color:'#57534E', borderRadius:8, padding:'10px 16px', marginBottom:20, display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
          <div style={{fontSize:11}}>
            <strong>Secondary Experimental:</strong> Sepolia Testnet Escrow — cross-chain settlement pattern demo (bonus future extensibility) — Real on-chain testnet txs when faucet ETH available, SepoliaETH no monetary value · Faucet: <a href={testnetConfig.faucet} target="_blank" rel="noreferrer" style={{color:'#1E3A5F', textDecoration:'underline'}}>{testnetConfig.faucet}</a> · Explorer: <a href={testnetConfig.explorer} target="_blank" rel="noreferrer" style={{color:'#1E3A5F', textDecoration:'underline'}}>{testnetConfig.explorer}</a>
          </div>
          <div style={{fontSize:10, background:'#F5F5F4', padding:'4px 8px', borderRadius:4, border:'1px dashed #D6D3D1'}}>{testnetConfig.chainName} {testnetConfig.chainId} · Secondary</div>
        </div>
      )}

      {activeTab==='holdings' && (
        <div className="grid grid-2">
          <div className="card">
            <h3>Holdings — Drunix Property Tokens</h3>
            <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:12}}>Each token = fractional ownership in SPV holding legal title · Tabular numbers aligned</p>
            {!wallet || !wallet.balances || wallet.balances.length===0 ? (
              <div className="empty-state"><p>No tokens held. Originator holds full supply after mint.</p></div>
            ) : (
              <div style={{display:'flex', flexDirection:'column', gap:10}}>
                {wallet.balances.map((item, i) => {
                  try {
                    return (
                      <div key={i} style={{background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:8, padding:14, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                        <div>
                          <div style={{fontSize:13, fontWeight:600}}>{item.propertyTitle || item.balance?.assetId?.slice(0,20) || 'Property'}</div>
                          <div style={{fontSize:11, color:'var(--ink-60)', marginTop:2}}>{(item.balance?.assetId||'').slice(0,24)}... · ₹{item.tokenPrice||0}/token</div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <div className="tabular" style={{fontSize:18, fontFamily:'Fraunces', fontWeight:700}}>{item.balance?.balance||0}</div>
                          <div style={{fontSize:10, color:'var(--ink-40)', textTransform:'uppercase', fontWeight:700}}>tokens</div>
                          <div className="tabular" style={{fontSize:11, color:'var(--ink-60)', marginTop:4}}>₹{Number(item.valueINR||0).toLocaleString('en-IN')}</div>
                        </div>
                      </div>
                    )
                  } catch (e) {
                    return <div key={i} style={{fontSize:11, color:'var(--error-rust)'}}>Error rendering holding {i}: {String(e.message)}</div>
                  }
                })}
              </div>
            )}
          </div>

          <div className="card">
            <h3>Quick Transfer — Direct Drunix (no payment rail)</h3>
            <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:10}}>For direct token moves without payment — primary DvP with UPI is in Property Detail → Buy Tokens → UPI Collect</p>
            <form onSubmit={handleTransfer} style={{display:'flex', flexDirection:'column', gap:12}}>
              <div>
                <label style={{fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'var(--ink-40)'}}>Property</label>
                <input className="input" style={{marginTop:4, width:'100%'}} value={transferForm.assetId} onChange={e=>setTransferForm({...transferForm, assetId:e.target.value})} placeholder="PROP-..." required />
              </div>
              <div>
                <label style={{fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'var(--ink-40)'}}>Recipient</label>
                <input className="input" style={{marginTop:4, width:'100%'}} value={transferForm.toId} onChange={e=>setTransferForm({...transferForm, toId:e.target.value})} required placeholder="investor2" />
              </div>
              <div>
                <label style={{fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'var(--ink-40)'}}>Amount</label>
                <div style={{display:'flex', gap:6, marginTop:4}}>
                  <input className={`input ${isOverBalance ? 'error' : ''}`} style={{flex:1}} type="number" min="1" value={transferForm.amount} onChange={e=>setTransferForm({...transferForm, amount:e.target.value})} required placeholder="500" />
                  <span style={{fontSize:11, background:'var(--paper)', border:'1px solid var(--ink-12)', padding:'8px 10px', borderRadius:6, color:'var(--ink-40)'}}>tokens</span>
                </div>
                {transferForm.amount && (
                  <div style={{fontSize:11, marginTop:6, color: isOverBalance ? 'var(--error-rust)' : 'var(--ink-60)'}}>
                    {isOverBalance ? `Insufficient: have ${maxBal}, need ${amountNum}` : `${amountNum} × ₹${tokenPrice} = ₹${estimatedValue.toLocaleString('en-IN')} ≈ ${estimatedEth} ETH · Max ${maxBal}`}
                  </div>
                )}
                <div style={{display:'flex', gap:6, marginTop:8}}>
                  {[0.25,0.5,0.75,1].map(pct => (
                    <button key={pct} type="button" onClick={()=>setTransferForm({...transferForm, amount: String(Math.floor(maxBal*pct)||0)})}
                      style={{fontSize:10, fontWeight:600, padding:'4px 8px', borderRadius:4, border:'1px solid var(--ink-12)', background:'var(--paper)', cursor:'pointer'}}>
                      {pct===1 ? 'Max' : `${pct*100}%`}
                    </button>
                  ))}
                </div>
              </div>

              <button type="submit" className="btn btn-primary" disabled={isOverBalance || !transferForm.amount} style={{width:'100%', padding:'10px'}}>
                {confirmStep ? 'Confirm Direct Transfer' : 'Transfer — Direct Drunix'}
              </button>
            </form>

            {txStatus && (
              <div style={{marginTop:12, background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:8, padding:12}}>
                <div style={{fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8}}>Fabric Lifecycle</div>
                {['submitting','endorsing','committing','confirmed'].map(s => (
                  <div key={s} style={{display:'flex', alignItems:'center', gap:8, fontSize:12, padding:'4px 0'}}>
                    <span>{txStatus.step===s ? '⟳' : (['submitting','endorsing','committing'].indexOf(txStatus.step) > ['submitting','endorsing','committing'].indexOf(s) || txStatus.step==='confirmed') ? '✓' : '○'}</span>
                    <span style={{textTransform:'capitalize'}}>{s}</span>
                    <span style={{fontSize:10, color:'var(--ink-40)'}}>{txStatus.transferId?.slice(0,12) || ''}</span>
                  </div>
                ))}
              </div>
            )}
            {msg && <div style={{marginTop:10, padding:'8px 10px', borderRadius:6, fontSize:12, background: msg.includes('failed') ? 'rgba(161,61,46,0.08)' : 'rgba(47,107,79,0.08)', color: msg.includes('failed') ? 'var(--error-rust)' : 'var(--verified-green)'}}>{msg}</div>}
          </div>
        </div>
      )}

      {activeTab==='transfer' && (
        <div className="card">
          <h3>Direct Transfer — Drunix Only (No Payment Rail)</h3>
          <p style={{fontSize:11, color:'var(--ink-60)', marginTop:4}}>Primary DvP with UPI Collect is in Property Detail → Buy Tokens. This tab is direct token move only.</p>
          <form onSubmit={handleTransfer} style={{display:'flex', flexDirection:'column', gap:10, marginTop:12, maxWidth:480}}>
            <input className="input" value={transferForm.assetId} onChange={e=>setTransferForm({...transferForm, assetId:e.target.value})} placeholder="AssetId PROP-..." required />
            <input className="input" value={transferForm.toId} onChange={e=>setTransferForm({...transferForm, toId:e.target.value})} placeholder="Recipient investor2" required />
            <input className="input" type="number" value={transferForm.amount} onChange={e=>setTransferForm({...transferForm, amount:e.target.value})} placeholder="Amount tokens" required />
            <div style={{fontSize:11}}>Value: ₹{estimatedValue.toLocaleString('en-IN')} ≈ {estimatedEth} ETH · Max {maxBal}</div>
            <button type="submit" className="btn btn-primary">Transfer — Direct</button>
          </form>
          {msg && <div style={{marginTop:10, fontSize:11, color: msg.includes('failed') ? 'var(--error-rust)' : 'var(--verified-green)'}}>{msg}</div>}
        </div>
      )}

      {activeTab==='npciHistory' && (
        <div className="card">
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8}}>
            <div>
              <h3 style={{display:'flex', alignItems:'center', gap:8}}><span style={{background:'#1E3A5F', color:'white', fontSize:10, padding:'2px 6px', borderRadius:4}}>PRIMARY</span> UPI Collect History — INR + Atomic DvP</h3>
              <p style={{fontSize:11, color:'var(--ink-40)'}}>UPI payments with RRN, UTR, UPI Txn ID linked to Drunix TXN via drunixTransferId · Simulation, no live NPCI</p>
            </div>
            <button className="btn btn-secondary" style={{fontSize:11}} onClick={fetchNpciPayments}>Refresh</button>
          </div>

          {npciPayments.length===0 ? (
            <div className="empty-state"><p>No UPI payments yet. Go to Marketplace → Property → Buy Tokens → UPI Collect.</p></div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:11, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-8)', fontSize:10, fontWeight:700, textTransform:'uppercase'}}><th style={{padding:'6px'}}>PaymentId</th><th>UPI Txn ID / RRN / UTR</th><th>Asset / Tokens</th><th>Amount INR</th><th>Payer→Payee VPA</th><th>Drunix TXN</th><th>Status</th><th>Time</th></tr></thead>
                <tbody>
                  {npciPayments.map((p, i) => {
                    try {
                      return (
                        <tr key={i} style={{borderBottom:'1px solid var(--ink-8)'}}>
                          <td style={{padding:'6px', fontFamily:'monospace', fontSize:9}}>{(p.paymentId||'').slice(0,14)}...</td>
                          <td style={{fontSize:9, fontFamily:'monospace'}}><div>{(p.upiTxnId||'').slice(0,16)}...</div><div style={{color:'#64748B'}}>RRN {p.rrn||''} / UTR {(p.utr||'').slice(0,16)}...</div></td>
                          <td style={{fontSize:10}}>{(p.assetId||'').slice(0,10)}... / {p.tokenAmount||0}</td>
                          <td style={{fontWeight:700}}>₹{Number(p.amountINR||0).toLocaleString('en-IN')}</td>
                          <td style={{fontSize:9}}>{p.payerVpa||''} → {p.payeeVpa||''}</td>
                          <td style={{fontSize:9, fontFamily:'monospace'}}>{(p.drunixTransferId||'pending').slice(0,12)}</td>
                          <td><span style={{fontSize:9, background: p.status==='RELEASED' ? 'rgba(47,107,79,0.1)' : p.status==='PENDING' ? 'rgba(200,150,0,0.1)' : 'rgba(161,61,46,0.1)', color: p.status==='RELEASED' ? '#2F6B4F' : p.status==='PENDING' ? '#8A6D00' : '#A13D2E', padding:'2px 6px', borderRadius:4, fontWeight:700}}>{p.status||'PENDING'}</span></td>
                          <td style={{fontSize:9, color:'var(--ink-60)'}}>{p.createdAt ? new Date(p.createdAt).toLocaleString() : '-'}</td>
                        </tr>
                      )
                    } catch {
                      return <tr key={i}><td colSpan={8} style={{fontSize:10, color:'var(--error-rust)'}}>Error rendering payment {i}</td></tr>
                    }
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div style={{marginTop:12, background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:6, padding:10, fontSize:10, color:'var(--ink-60)'}}>
            <strong>Primary DvP:</strong> 1. UPI Collect P2M initiated (PENDING + UPI Txn ID + RRN + UTR + expiry 5min) → 2. Payer approves in UPI app (KYC+balance → CONFIRMED + webhook) → 3. TransferTokens on Drunix (TXN-...) → 4. Release (IMPS UTR credited → RELEASED). If Drunix fails, Refund (REFUNDED) — atomic, no partial. INR paise int64, VPA regex, idempotency X-Idempotency-Key.
          </div>
        </div>
      )}

      {activeTab==='testnetHistory' && (
        <div className="card" style={{border:'1px dashed #E7E5E4', background:'#FAFAF9'}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8}}>
            <div>
              <h3 style={{display:'flex', alignItems:'center', gap:8}}><span style={{background:'#E7E5E4', color:'#57534E', fontSize:10, padding:'2px 6px', borderRadius:4, border:'1px dashed #A8A29E'}}>SECONDARY</span> Sepolia Escrow History — Experimental Cross-Chain Pattern</h3>
              <p style={{fontSize:11, color:'var(--ink-40)'}}>Bonus / future extensibility — could bridge to tokenized deposits/stablecoin rails later — not primary DvP — kept behind secondary label</p>
            </div>
            <button className="btn btn-secondary" style={{fontSize:11}} onClick={fetchTestnetPayments}>Refresh</button>
          </div>

          {testnetPayments.length===0 ? (
            <div className="empty-state"><p>No Sepolia payments yet. Go to Property Detail → Buy Tokens → Show Advanced → Sepolia Escrow.</p></div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:11, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-8)', fontSize:10, fontWeight:700, textTransform:'uppercase'}}><th style={{padding:'6px'}}>PaymentId</th><th>Asset</th><th>Tokens→ETH</th><th>Tx Hash→Etherscan</th><th>Drunix TXN</th><th>Status</th><th>Time</th></tr></thead>
                <tbody>
                  {testnetPayments.map((p, i) => {
                    try {
                      return (
                        <tr key={i} style={{borderBottom:'1px solid var(--ink-8)'}}>
                          <td style={{padding:'6px', fontFamily:'monospace', fontSize:9}}>{(p.paymentId||'').slice(0,14)}...</td>
                          <td style={{fontSize:10}}>{(p.assetId||'').slice(0,10)}...</td>
                          <td>{p.tokenAmount||0} → {p.estimatedEth||0} ETH</td>
                          <td style={{fontSize:9, fontFamily:'monospace'}}><a href={p.sepoliaExplorer || `https://sepolia.etherscan.io/tx/${p.txHash||''}`} target="_blank" rel="noreferrer" style={{color:'var(--registry-navy)'}}>{(p.txHash||'').slice(0,12)}... → Etherscan</a></td>
                          <td style={{fontSize:9, fontFamily:'monospace'}}>{(p.drunixTransferId||'pending').slice(0,12)}</td>
                          <td><span style={{fontSize:9, background: p.status==='RELEASED' ? 'rgba(47,107,79,0.1)' : 'rgba(200,150,0,0.1)', padding:'2px 6px', borderRadius:4}}>{p.status||'PENDING'}</span></td>
                          <td style={{fontSize:9, color:'var(--ink-60)'}}>{p.createdAt ? new Date(p.createdAt).toLocaleString() : '-'}</td>
                        </tr>
                      )
                    } catch {
                      return <tr key={i}><td colSpan={7} style={{fontSize:10, color:'var(--error-rust)'}}>Error rendering payment {i}</td></tr>
                    }
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div style={{marginTop:12, background:'white', border:'1px solid #E7E5E4', borderRadius:6, padding:10, fontSize:10, color:'#78716C'}}>
            <strong>Secondary Experimental:</strong> 1. initiatePayment() locks test ETH → 2. PaymentInitiated event → 3. TransferTokens on Drunix → 4. confirmDrunixTransfer() → 5. releasePayment(). If step 3 fails, refundPayment() refunds. No partial state. Production path: mainnet USDC/INR stablecoin + Chainlink oracle, same escrow logic — shows future extensibility.
          </div>
        </div>
      )}

      <div className="card" style={{marginTop:20}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10, flexWrap:'wrap', gap:8}}>
          <div>
            <h3 style={{fontSize:14}}>Recent activity — Drunix + UPI + Sepolia linked</h3>
            <p style={{fontSize:10, color:'var(--ink-40)'}}>Immutable TransferRecord · Pagination bookmark · Total {pagination.total} · UPI {npciPayments.length} · Sepolia {testnetPayments.length}</p>
          </div>
          <span style={{fontSize:10, color:'var(--ink-40)'}}>{history.length}/{pagination.total} · UPI {npciPayments.length} · Testnet {testnetPayments.length}</span>
        </div>
        {history.length===0 ? (
          <div className="empty-state"><p>No transfers yet.</p></div>
        ) : (
          <>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:11, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-8)', fontSize:10, fontWeight:700, textTransform:'uppercase'}}><th style={{padding:'6px'}}>TXN ID</th><th>Asset</th><th>From→To</th><th>Amount</th><th>Linked UPI (Primary)</th><th>Linked Sepolia (Secondary)</th><th>Time</th></tr></thead>
                <tbody>
                  {history.map(tx => {
                    try {
                      const linkedUpi = npciPayments.find(p => p.drunixTransferId===tx.transferId)
                      const linked = testnetPayments.find(p => p.drunixTransferId===tx.transferId)
                      return (
                        <tr key={tx.transferId} style={{borderBottom:'1px solid var(--ink-8)'}}>
                          <td style={{padding:'6px', fontFamily:'monospace', fontSize:9}}>{tx.transferId.slice(0,16)}...</td>
                          <td style={{fontSize:10}}>{tx.assetId.slice(0,10)}...</td>
                          <td style={{fontSize:10}}>{tx.fromId} → {tx.toId}</td>
                          <td style={{fontWeight:700}}>{tx.amount}</td>
                          <td style={{fontSize:9}}>{linkedUpi ? <span style={{fontFamily:'monospace', background:'#F0FDF4', border:'1px solid #BBF7D0', padding:'2px 4px', borderRadius:4}}>{linkedUpi.paymentId.slice(0,8)}... ₹{linkedUpi.amountINR} UTR {linkedUpi.utr.slice(0,10)}...</span> : <span style={{color:'var(--ink-40)'}}>Direct</span>}</td>
                          <td style={{fontSize:9}}>{linked ? <a href={linked.sepoliaExplorer||`https://sepolia.etherscan.io/tx/${linked.txHash}`} target="_blank" rel="noreferrer" style={{color:'var(--registry-navy)'}}>{linked.paymentId.slice(0,8)}... ({linked.estimatedEth} ETH)</a> : <span style={{color:'var(--ink-40)'}}>-</span>}</td>
                          <td style={{fontSize:9, color:'var(--ink-60)'}}>{new Date(tx.txTimestamp).toLocaleString()}</td>
                        </tr>
                      )
                    } catch {
                      return <tr key={tx.transferId}><td colSpan={7} style={{fontSize:10}}>Error rendering {tx.transferId}</td></tr>
                    }
                  })}
                </tbody>
              </table>
            </div>
            {pagination.hasMore && (
              <button className="btn btn-secondary" style={{marginTop:10, fontSize:11}} onClick={() => fetchHistory(pagination.bookmark, true)}>
                Load more — {pagination.bookmark.slice(0,10)}...
              </button>
            )}
          </>
        )}
      </div>

      <FailureModeDemo user={user} />
      <NPCIFailureModeDemo />
    </div>
  )
}
