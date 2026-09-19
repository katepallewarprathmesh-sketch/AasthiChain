import React, { useState, useEffect } from 'react'
import FailureModeDemo from '../components/FailureModeDemo.jsx'
import TestnetPayment from '../components/TestnetPayment.jsx'

// Simple Error Boundary fallback
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
  const [mode, setMode] = useState('testnet')
  const [testnetPayments, setTestnetPayments] = useState([])
  const [testnetConfig, setTestnetConfig] = useState(null)
  const [activeTab, setActiveTab] = useState('holdings')
  const [error, setError] = useState(null)

  // Fetch wallet — robust, no dependency on transferForm to avoid loop
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
      // Only auto-fill assetId if empty and we have balances
      setTransferForm(prev => {
        if (prev.assetId) return prev
        if (data.balances && data.balances.length > 0) {
          return { ...prev, assetId: data.balances[0].balance?.assetId || data.balances[0].balance?.assetId || '' }
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
        // Try without auth (config endpoint)
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

  const fetchTestnetConfig = async () => {
    try {
      const res = await fetch('/api/testnet/config', { cache: 'no-store' })
      if (!res.ok) throw new Error('config fetch failed')
      const data = await res.json()
      setTestnetConfig(data)
    } catch (e) {
      setTestnetConfig({
        chainId: '0xaa36a7',
        chainName: 'Sepolia Testnet',
        explorer: 'https://sepolia.etherscan.io',
        faucet: 'https://sepoliafaucet.com/',
        contractAddress: '0x0000000000000000000000000000000000000000',
        rpcUrl: 'https://rpc.sepolia.org'
      })
    }
  }

  useEffect(() => {
    let mounted = true
    const init = async () => {
      if (!mounted) return
      await fetchWallet()
      await fetchHistory()
      await fetchTestnetPayments()
      await fetchTestnetConfig()
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

  // Safe computed values — FIX min 0.001 issue: old /200000 gave dust <0.001, new /20000 + min 0.001
  let tokenPrice = 500, maxBal = 0, amountNum = 0, estimatedValue = 0, estimatedEth = '0.0010', isOverBalance = false
  try {
    tokenPrice = getTokenPrice()
    maxBal = getMaxBalance()
    amountNum = parseInt(transferForm.amount) || 0
    estimatedValue = amountNum * tokenPrice
    const raw = estimatedValue / 20000 // was 200000 → 10x larger to avoid dust
    estimatedEth = Math.max(raw, 0.001).toFixed(4)
    isOverBalance = amountNum > maxBal
  } catch {}

  if (loadingWallet && !wallet) {
    return (
      <div>
        <div style={{padding:40, textAlign:'center'}}>
          <div style={{fontSize:14, color:'var(--ink-60)'}}>Loading wallet — fetching balances from Drunix + Sepolia testnet escrow...</div>
          <div style={{marginTop:12, fontSize:12, color:'var(--ink-40)'}}>Composite key: balance~assetId~ownerId · Index idx_balance_owner</div>
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

      {/* Header */}
      <div style={{marginBottom:24}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12}}>
          <div>
            <h1 style={{fontSize:32, marginBottom:4, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap'}}>
              My Wallet
              <span style={{background:'var(--registry-navy)', color:'white', fontSize:11, padding:'3px 8px', borderRadius:4, fontWeight:700, letterSpacing:'0.05em'}}>TESTNET MONEY FLOW LIVE</span>
            </h1>
            <p style={{color:'var(--ink-60)', fontSize:13, maxWidth:'80ch'}}>
              Portfolio from Drunix (property tokens) + Sepolia testnet escrow demonstrating atomic DvP settlement pattern · Real on-chain testnet transactions when faucet ETH available, Sepolia test ETH has no monetary value · KYC always visible
            </p>
          </div>
          <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
            {[
              {id:'holdings', label:'Holdings'},
              {id:'transfer', label:'Transfer + DvP'},
              {id:'testnetHistory', label:'Testnet Escrow'}
            ].map(tab => (
              <button key={tab.id} onClick={()=>setActiveTab(tab.id)}
                style={{
                  fontSize:12, fontWeight:700, padding:'8px 14px', borderRadius:6,
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

      {/* Top Stats */}
      <div className="grid grid-3" style={{marginBottom:24}}>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>Total Portfolio Value</div>
          <div className="tabular" style={{fontSize:28, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>₹{wallet ? (Number(wallet.totalPortfolioValue||0)/100000).toFixed(2) : '0'}L</div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>≈ {(wallet ? Number(wallet.totalPortfolioValue||0)/200000 : 0).toFixed(2)} SepoliaETH @ ₹2L/ETH · tokenPrice × balance</div>
        </div>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>Assets + Escrows</div>
          <div className="tabular" style={{fontSize:28, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>{wallet?.balances?.length||0} + {testnetPayments.length}</div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>FabricMode: {wallet?.fabricMode||'mock'} · {testnetPayments.length} testnet escrows</div>
        </div>
        <div className="card" style={{borderLeft:`3px solid var(--verified-green)`}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>KYC + Testnet</div>
          <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            <span style={{fontSize:14, fontWeight:700, color:'var(--verified-green)'}}>Verified</span>
            <span className="status-chip status-tokenized">KYC ✓</span>
            <span style={{fontSize:10, background:'var(--registry-navy)', color:'white', padding:'2px 6px', borderRadius:4}}>Sepolia Ready</span>
          </div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>DigiLocker mock · MetaMask Sepolia for real testnet flow</div>
        </div>
      </div>

      {/* Faucet Banner */}
      {testnetConfig && (
        <div style={{background:'var(--registry-navy)', color:'white', borderRadius:8, padding:'12px 16px', marginBottom:24, display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
          <div style={{fontSize:13}}>
            <strong>💰 Sepolia Testnet Escrow — Atomic DvP Settlement Pattern</strong> — Real on-chain testnet txs demonstrating DvP pattern, SepoliaETH has no monetary value · Faucet: <a href={testnetConfig.faucet} target="_blank" rel="noreferrer" style={{color:'#FFD166', textDecoration:'underline'}}>{testnetConfig.faucet}</a> · Explorer: <a href={testnetConfig.explorer} target="_blank" rel="noreferrer" style={{color:'#FFD166', textDecoration:'underline'}}>{testnetConfig.explorer}</a>
          </div>
          <div style={{fontSize:11, background:'rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:4}}>
            {testnetConfig.chainName} {testnetConfig.chainId}
          </div>
        </div>
      )}

      {/* Holdings Tab */}
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
            <h3>Quick Transfer — Choose Mode</h3>
            <div style={{display:'flex', gap:8, marginBottom:12, marginTop:8}}>
              <button onClick={()=>setMode('direct')} style={{flex:1, padding:'8px', borderRadius:6, border: mode==='direct' ? '2px solid var(--registry-navy)' : '1px solid var(--ink-12)', background: mode==='direct' ? 'var(--surface)' : 'var(--paper)', fontWeight:700, fontSize:11, cursor:'pointer'}}>Direct Drunix<br/><span style={{fontWeight:400, fontSize:10}}>No payment rail</span></button>
              <button onClick={()=>setMode('testnet')} style={{flex:1, padding:'8px', borderRadius:6, border: mode==='testnet' ? '2px solid var(--registry-navy)' : '1px solid var(--ink-12)', background: mode==='testnet' ? 'var(--registry-navy)' : 'var(--paper)', color: mode==='testnet' ? 'white' : 'var(--ink)', fontWeight:700, fontSize:11, cursor:'pointer'}}>🔒 Atomic DvP Testnet<br/><span style={{fontWeight:400, fontSize:10}}>On-chain testnet txs, DvP pattern</span></button>
            </div>

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

              {mode==='direct' ? (
                <button type="submit" className="btn btn-primary" disabled={isOverBalance || !transferForm.amount} style={{width:'100%', padding:'10px'}}>
                  {confirmStep ? 'Confirm Direct Transfer' : 'Transfer — Direct'}
                </button>
              ) : (
                <div style={{background:'var(--surface)', border:'1px solid var(--registry-navy)', borderRadius:8, padding:10, fontSize:11}}>
                  <div style={{fontWeight:700, marginBottom:4}}>🔒 Testnet DvP Selected</div>
                  <div style={{color:'var(--ink-60)', marginBottom:8}}>Will lock {estimatedEth} SepoliaETH (no monetary value) in escrow → Drunix transfer → release — demonstrates atomic DvP settlement pattern.</div>
                  <button type="button" className="btn btn-secondary" style={{width:'100%', fontSize:11}} onClick={()=>setActiveTab('transfer')}>Go to Full Escrow UI →</button>
                </div>
              )}
            </form>

            {txStatus && mode==='direct' && (
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
        <div>
          <div className="card" style={{marginBottom:16}}>
            <h3>Transfer Mode</h3>
            <div style={{display:'flex', gap:10, marginTop:10}}>
              <button onClick={()=>setMode('direct')} className={mode==='direct' ? 'btn btn-primary' : 'btn btn-secondary'} style={{flex:1, fontSize:12}}>Direct Drunix — no payment rail</button>
              <button onClick={()=>setMode('testnet')} className={mode==='testnet' ? 'btn btn-primary' : 'btn btn-secondary'} style={{flex:1, fontSize:12, background: mode==='testnet' ? 'var(--registry-navy)' : ''}}>🔒 Atomic DvP — Sepolia Escrow — On-Chain Testnet Settlement Pattern</button>
            </div>
            <div style={{marginTop:8, fontSize:11, color:'var(--ink-60)'}}>Direct = only tokens move. Testnet DvP = Sepolia test ETH (no monetary value) locked → Drunix transfer → release — demonstrates atomic DvP settlement pattern. If Drunix fails, refundPayment() refunds.</div>
          </div>

          {mode==='direct' ? (
            <div className="card">
              <h3>Direct Transfer</h3>
              <form onSubmit={handleTransfer} style={{display:'flex', flexDirection:'column', gap:10, marginTop:12, maxWidth:480}}>
                <input className="input" value={transferForm.assetId} onChange={e=>setTransferForm({...transferForm, assetId:e.target.value})} placeholder="AssetId PROP-..." required />
                <input className="input" value={transferForm.toId} onChange={e=>setTransferForm({...transferForm, toId:e.target.value})} placeholder="Recipient investor2" required />
                <input className="input" type="number" value={transferForm.amount} onChange={e=>setTransferForm({...transferForm, amount:e.target.value})} placeholder="Amount tokens" required />
                <div style={{fontSize:11}}>Value: ₹{estimatedValue.toLocaleString('en-IN')} ≈ {estimatedEth} ETH · Max {maxBal}</div>
                <button type="submit" className="btn btn-primary">Transfer — Direct</button>
              </form>
              {msg && <div style={{marginTop:10, fontSize:11, color: msg.includes('failed') ? 'var(--error-rust)' : 'var(--verified-green)'}}>{msg}</div>}
            </div>
          ) : (
            <TestnetPayment 
              assetId={transferForm.assetId || wallet?.balances?.[0]?.balance?.assetId || 'PROP-demo'} 
              tokenAmount={amountNum || parseInt(transferForm.amount) || 100}
              tokenPrice={tokenPrice}
              recipient={transferForm.toId}
              onPaymentComplete={(pid, drunixId) => {
                try {
                  const pId = typeof pid === 'string' ? pid : pid?.paymentId || String(pid).slice(0,12)
                  const dId = typeof drunixId === 'string' ? drunixId : pid?.drunixTransferId || 'TXN-...'
                  setMsg(`✅ Atomic DvP complete — testnet ${String(pId).slice(0,12)}... ↔ Drunix ${String(dId).slice(0,16)}... — real on-chain testnet transactions demonstrating DvP settlement pattern`)
                  fetchWallet()
                  fetchHistory()
                  fetchTestnetPayments()
                } catch (e) {
                  setMsg(`DvP complete — ${String(e.message)}`)
                }
              }}
            />
          )}
        </div>
      )}

      {activeTab==='testnetHistory' && (
        <div className="card">
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8}}>
            <div>
              <h3>Testnet Escrow History — Atomic DvP Settlement Pattern</h3>
              <p style={{fontSize:11, color:'var(--ink-40)'}}>Sepolia payments linked to Drunix TXN via paymentId ↔ drunixTransferId · Etherscan verifiable</p>
            </div>
            <button className="btn btn-secondary" style={{fontSize:11}} onClick={fetchTestnetPayments}>Refresh</button>
          </div>

          {testnetPayments.length===0 ? (
            <div className="empty-state"><p>No testnet payments yet. Go to Transfer → Atomic DvP → Connect MetaMask Sepolia → Pay test ETH.</p></div>
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
          <div style={{marginTop:12, background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:6, padding:10, fontSize:10, color:'var(--ink-60)'}}>
            <strong>Atomic DvP:</strong> 1. initiatePayment() locks test ETH → 2. PaymentInitiated event → 3. TransferTokens on Drunix → 4. confirmDrunixTransfer() → 5. releasePayment(). If step 3 fails, refundPayment() refunds. No partial state.
          </div>
        </div>
      )}

      {/* Recent Activity — Always visible */}
      <div className="card" style={{marginTop:20}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10, flexWrap:'wrap', gap:8}}>
          <div>
            <h3 style={{fontSize:14}}>Recent activity — Drunix + Testnet linked</h3>
            <p style={{fontSize:10, color:'var(--ink-40)'}}>Immutable TransferRecord · Pagination bookmark · Total {pagination.total}</p>
          </div>
          <span style={{fontSize:10, color:'var(--ink-40)'}}>{history.length}/{pagination.total} · Testnet {testnetPayments.length}</span>
        </div>
        {history.length===0 ? (
          <div className="empty-state"><p>No transfers yet.</p></div>
        ) : (
          <>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:11, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-8)', fontSize:10, fontWeight:700, textTransform:'uppercase'}}><th style={{padding:'6px'}}>TXN ID</th><th>Asset</th><th>From→To</th><th>Amount</th><th>Linked Testnet</th><th>Time</th></tr></thead>
                <tbody>
                  {history.map(tx => {
                    try {
                      const linked = testnetPayments.find(p => p.drunixTransferId===tx.transferId)
                      return (
                        <tr key={tx.transferId} style={{borderBottom:'1px solid var(--ink-8)'}}>
                          <td style={{padding:'6px', fontFamily:'monospace', fontSize:9}}>{tx.transferId.slice(0,16)}...</td>
                          <td style={{fontSize:10}}>{tx.assetId.slice(0,10)}...</td>
                          <td style={{fontSize:10}}>{tx.fromId} → {tx.toId}</td>
                          <td style={{fontWeight:700}}>{tx.amount}</td>
                          <td style={{fontSize:9}}>{linked ? <a href={linked.sepoliaExplorer||`https://sepolia.etherscan.io/tx/${linked.txHash}`} target="_blank" rel="noreferrer" style={{color:'var(--registry-navy)'}}>{linked.paymentId.slice(0,8)}... ({linked.estimatedEth} ETH)</a> : <span style={{color:'var(--ink-40)'}}>Direct</span>}</td>
                          <td style={{fontSize:9, color:'var(--ink-60)'}}>{new Date(tx.txTimestamp).toLocaleString()}</td>
                        </tr>
                      )
                    } catch {
                      return <tr key={tx.transferId}><td colSpan={6} style={{fontSize:10}}>Error rendering {tx.transferId}</td></tr>
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
    </div>
  )
}
