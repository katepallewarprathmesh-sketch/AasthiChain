import React, { useState, useEffect } from 'react'
import FailureModeDemo from '../components/FailureModeDemo.jsx'
import TestnetPayment from '../components/TestnetPayment.jsx'

export default function Wallet({ user }) {
  const [wallet, setWallet] = useState(null)
  const [transferForm, setTransferForm] = useState({ assetId: '', toId: 'investor2', amount: '' })
  const [history, setHistory] = useState([])
  const [pagination, setPagination] = useState({ bookmark: '', hasMore: false, total: 0, pageSize: 10 })
  const [txStatus, setTxStatus] = useState(null)
  const [confirmStep, setConfirmStep] = useState(false)
  const [msg, setMsg] = useState('')
  const [mode, setMode] = useState('testnet') // 'direct' or 'testnet' — default testnet to show real money flow
  const [testnetPayments, setTestnetPayments] = useState([])
  const [testnetConfig, setTestnetConfig] = useState(null)
  const [activeTab, setActiveTab] = useState('holdings') // holdings, transfer, testnetHistory

  useEffect(() => {
    fetchWallet()
    fetchHistory()
    fetchTestnetPayments()
    fetchTestnetConfig()
  }, [])

  const fetchWallet = async () => {
    try {
      const token = localStorage.getItem('aasthi_token')
      const res = await fetch(`/api/balances/wallet/${user.identityId}`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      setWallet(data)
      if (data.balances && data.balances.length > 0 && !transferForm.assetId) {
        setTransferForm(f => ({ ...f, assetId: data.balances[0].balance.assetId }))
      }
    } catch (e) {
      setWallet({ balances: [], totalPortfolioValue: 0 })
    }
  }

  const fetchHistory = async (bookmark = '', append = false) => {
    try {
      const token = localStorage.getItem('aasthi_token')
      const pageSize = pagination.pageSize
      const url = `/api/transfers/history?ownerId=${user.identityId}&pageSize=${pageSize}&bookmark=${bookmark}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (append) {
        setHistory(h => [...h, ...(data.transfers || [])])
      } else {
        setHistory(data.transfers || [])
      }
      setPagination({ bookmark: data.bookmark || '', hasMore: data.hasMore || false, total: data.total || 0, pageSize })
    } catch {}
  }

  const fetchTestnetPayments = async () => {
    try {
      const token = localStorage.getItem('aasthi_token')
      const res = await fetch('/api/testnet/payments', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      setTestnetPayments(data.payments || [])
    } catch {
      setTestnetPayments([])
    }
  }

  const fetchTestnetConfig = async () => {
    try {
      const res = await fetch('/api/testnet/config')
      const data = await res.json()
      setTestnetConfig(data)
    } catch {
      setTestnetConfig({
        chainId: '0xaa36a7',
        chainName: 'Sepolia Testnet',
        explorer: 'https://sepolia.etherscan.io',
        faucet: 'https://sepoliafaucet.com/',
        contractAddress: '0x0000000000000000000000000000000000000000'
      })
    }
  }

  const getTokenPrice = () => {
    if (!wallet || !transferForm.assetId) return 500
    const item = wallet.balances.find(b => b.balance.assetId === transferForm.assetId)
    return item ? item.tokenPrice : 500
  }

  const getMaxBalance = () => {
    if (!wallet || !transferForm.assetId) return 0
    const item = wallet.balances.find(b => b.balance.assetId === transferForm.assetId)
    return item ? item.balance.balance : 0
  }

  const handleTransfer = async (e) => {
    e.preventDefault()
    if (!confirmStep) {
      setConfirmStep(true)
      return
    }
    setTxStatus({ step: 'submitting', transferId: null })
    setMsg('')
    try {
      setTimeout(() => setTxStatus(s => s ? { ...s, step: 'endorsing' } : null), 400)
      setTimeout(() => setTxStatus(s => s ? { ...s, step: 'committing' } : null), 900)
      const token = localStorage.getItem('aasthi_token')
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          assetId: transferForm.assetId,
          toId: transferForm.toId,
          amount: parseInt(transferForm.amount)
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || data.message)
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

  const tokenPrice = getTokenPrice()
  const maxBal = getMaxBalance()
  const amountNum = parseInt(transferForm.amount) || 0
  const estimatedValue = amountNum * tokenPrice
  const estimatedEth = (estimatedValue / 200000).toFixed(4)
  const isOverBalance = amountNum > maxBal

  return (
    <div>
      {/* Header */}
      <div style={{marginBottom:24}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12}}>
          <div>
            <h1 style={{fontSize:32, marginBottom:4, display:'flex', alignItems:'center', gap:12}}>
              My Wallet
              <span style={{background:'var(--registry-navy)', color:'white', fontSize:11, padding:'3px 8px', borderRadius:4, fontWeight:700, letterSpacing:'0.05em'}}>TESTNET MONEY FLOW LIVE</span>
            </h1>
            <p style={{color:'var(--ink-60)', fontSize:13, maxWidth:'80ch'}}>
              Portfolio overview · Holdings from Drunix (property tokens) + Testnet Escrow (Sepolia payments) = atomic DvP · Composite key: balance~assetId~ownerId · Real money flow via Sepolia test ETH, no real money risk
            </p>
          </div>
          <div style={{display:'flex', gap:8}}>
            {['holdings','transfer','testnetHistory'].map(tab => (
              <button key={tab} onClick={()=>setActiveTab(tab)}
                style={{
                  fontSize:12, fontWeight:700, padding:'8px 14px', borderRadius:6,
                  border: activeTab===tab ? '2px solid var(--registry-navy)' : '1px solid var(--ink-12)',
                  background: activeTab===tab ? 'var(--registry-navy)' : 'var(--paper)',
                  color: activeTab===tab ? 'white' : 'var(--ink-60)', cursor:'pointer', textTransform:'capitalize'
                }}>
                {tab==='testnetHistory' ? 'Testnet Escrow History' : tab}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Top Stats */}
      <div className="grid grid-3" style={{marginBottom:24}}>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>Total Portfolio Value</div>
          <div className="tabular" style={{fontSize:32, fontFamily:'Fraunces', fontWeight:700, color:'var(--ink)', lineHeight:1}}>₹{wallet ? (wallet.totalPortfolioValue/100000).toFixed(2) : '0'}L</div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>≈ {(wallet ? wallet.totalPortfolioValue/200000 : 0).toFixed(2)} SepoliaETH @ ₹2L/ETH mock oracle · Sum tokenPrice × balance</div>
        </div>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>Assets Owned + Testnet Payments</div>
          <div className="tabular" style={{fontSize:32, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>{wallet ? wallet.balances.length : 0} + {testnetPayments.length}</div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>FabricMode: {wallet?.fabricMode || 'mock'} · Testnet: {testnetPayments.length} escrows · Index idx_balance_owner</div>
        </div>
        <div className="card" style={{borderLeft:`3px solid var(--verified-green)`}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>KYC + Testnet Wallet</div>
          <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            <span style={{fontSize:14, fontWeight:700, color:'var(--verified-green)'}}>KYC Verified</span>
            <span className="status-chip status-tokenized">Verified</span>
            <span style={{fontSize:10, background:'var(--registry-navy)', color:'white', padding:'2px 6px', borderRadius:4}}>Sepolia Ready</span>
          </div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>Mock DigiLocker · MetaMask Sepolia for real testnet money flow per §5.3</div>
        </div>
      </div>

      {/* Faucet Banner */}
      {testnetConfig && (
        <div style={{background:'var(--registry-navy)', color:'white', borderRadius:'var(--radius)', padding:'12px 16px', marginBottom:24, display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
          <div style={{fontSize:13}}>
            <strong>💰 Real Money Flow Involved — Sepolia Testnet</strong> — No real money risk · Get 0.5 free SepoliaETH from faucet for 100+ tx · Contract: {testnetConfig.contractAddress?.slice(0,10)}... · 
            <a href={testnetConfig.faucet} target="_blank" style={{color:'#FFD166', textDecoration:'underline', marginLeft:6}}>{testnetConfig.faucet}</a> · 
            <a href={testnetConfig.explorer} target="_blank" style={{color:'#FFD166', textDecoration:'underline', marginLeft:6}}>Etherscan Sepolia</a>
          </div>
          <div style={{fontSize:11, background:'rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:4}}>
            Chain: {testnetConfig.chainName} {testnetConfig.chainId} · RPC: {testnetConfig.rpcUrl}
          </div>
        </div>
      )}

      {/* Holdings Tab */}
      {activeTab==='holdings' && (
        <div className="grid grid-2">
          <div className="card">
            <h3 style={{marginBottom:4}}>Holdings — Drunix Property Tokens</h3>
            <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:16}}>Generous white space around numbers — numbers are the product per §1.3 · Each token = fractional ownership in SPV holding legal title</p>
            {!wallet || wallet.balances.length === 0 ? (
              <div className="empty-state">
                <p>No tokens held yet. Originator holds full supply after mint. Transfer tokens from originator to see holdings here.</p>
                <button className="btn btn-secondary" style={{fontSize:12}}>Learn about tokenization</button>
              </div>
            ) : (
              <div style={{display:'flex', flexDirection:'column', gap:12}}>
                {wallet.balances.map((item, i) => (
                  <div key={i} style={{background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:'var(--radius)', padding:16, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <div style={{fontSize:13, fontWeight:600}}>{item.propertyTitle || item.balance.assetId.slice(0,20)}</div>
                      <div style={{fontSize:11, color:'var(--ink-60)', marginTop:2}}>{item.balance.assetId.slice(0,24)}... · ₹{item.tokenPrice}/token · {(item.tokenPrice/200000).toFixed(5)} ETH/token</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div className="tabular" style={{fontSize:20, fontFamily:'Fraunces', fontWeight:700}}>{item.balance.balance}</div>
                      <div style={{fontSize:10, color:'var(--ink-40)', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:700}}>tokens</div>
                      <div className="tabular" style={{fontSize:12, color:'var(--ink-60)', marginTop:4}}>₹{item.valueINR.toLocaleString('en-IN')} · {(item.valueINR/200000).toFixed(3)} ETH</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{marginBottom:4}}>Quick Transfer — Choose Mode</h3>
            <div style={{display:'flex', gap:8, marginBottom:16}}>
              <button onClick={()=>setMode('direct')} style={{flex:1, padding:'8px', borderRadius:6, border: mode==='direct' ? '2px solid var(--registry-navy)' : '1px solid var(--ink-12)', background: mode==='direct' ? 'var(--surface)' : 'var(--paper)', fontWeight:700, fontSize:12, cursor:'pointer'}}>
                Direct Drunix<br/><span style={{fontWeight:400, fontSize:10}}>No payment rail</span>
              </button>
              <button onClick={()=>setMode('testnet')} style={{flex:1, padding:'8px', borderRadius:6, border: mode==='testnet' ? '2px solid var(--registry-navy)' : '1px solid var(--ink-12)', background: mode==='testnet' ? 'var(--registry-navy)' : 'var(--paper)', color: mode==='testnet' ? 'white' : 'var(--ink)', fontWeight:700, fontSize:12, cursor:'pointer'}}>
                🔒 Atomic DvP Testnet<br/><span style={{fontWeight:400, fontSize:10}}>Real money flow (test ETH)</span>
              </button>
            </div>

            <form onSubmit={handleTransfer} style={{display:'flex', flexDirection:'column', gap:14}}>
              <div className="field-group">
                <label className="field-label">Property</label>
                <input className="input" value={transferForm.assetId} onChange={e=>setTransferForm({...transferForm, assetId:e.target.value})} placeholder="PROP-..." required />
              </div>
              <div className="field-group">
                <label className="field-label">Recipient — KYC-verified</label>
                <input className="input" value={transferForm.toId} onChange={e=>setTransferForm({...transferForm, toId:e.target.value})} required placeholder="investor2" />
                {transferForm.toId && !['investor1','investor2','originator1'].includes(transferForm.toId) && (
                  <div className="input-error">Recipient KYC not verified per §6.2</div>
                )}
              </div>
              <div className="field-group">
                <label className="field-label">Amount — both units per §5.2</label>
                <div className="input-wrap">
                  <input className={`input ${isOverBalance ? 'error' : ''}`} type="number" min="1" max={maxBal} value={transferForm.amount} onChange={e=>setTransferForm({...transferForm, amount:e.target.value})} required placeholder="500" />
                  <span className="input-unit">tokens</span>
                </div>
                {transferForm.amount && (
                  <div className="input-secondary">
                    {isOverBalance ? (
                      <span style={{color:'var(--error-rust)'}}>Insufficient: have {maxBal}, need {amountNum}</span>
                    ) : (
                      <span>{amountNum} × ₹{tokenPrice} = ₹{estimatedValue.toLocaleString('en-IN')} ≈ {estimatedEth} SepoliaETH · Max {maxBal}</span>
                    )}
                  </div>
                )}
                <div style={{display:'flex', gap:6, marginTop:8}}>
                  {[0.25,0.5,0.75,1].map(pct => (
                    <button key={pct} type="button" onClick={()=>setTransferForm({...transferForm, amount: String(Math.floor(maxBal*pct))})}
                      style={{fontSize:11, fontWeight:600, padding:'4px 8px', borderRadius:4, border:'1px solid var(--ink-12)', background:'var(--paper)', cursor:'pointer'}}>
                      {pct===1 ? 'Max' : `${pct*100}%`}
                    </button>
                  ))}
                </div>
              </div>
              {mode==='direct' ? (
                <button type="submit" className="btn btn-primary" disabled={isOverBalance || !transferForm.amount} style={{width:'100%', padding:'12px'}}>
                  {confirmStep ? 'Confirm Direct Transfer' : 'Transfer tokens — direct (no payment)'}
                </button>
              ) : (
                <div style={{background:'var(--surface)', border:'1px solid var(--registry-navy)', borderRadius:'var(--radius)', padding:12, fontSize:12}}>
                  <div style={{fontWeight:700, marginBottom:6}}>🔒 Testnet DvP Mode Selected — Real Money Flow</div>
                  <div style={{fontSize:11, color:'var(--ink-60)', marginBottom:8}}>Below component will lock {estimatedEth} test ETH in escrow, then Drunix transfer, then release — atomic DvP. If Drunix fails, refundPayment() refunds.</div>
                  <button type="button" className="btn btn-secondary" style={{width:'100%'}} onClick={()=>setActiveTab('transfer')}>
                    Go to Testnet Payment → Full Escrow UI
                  </button>
                </div>
              )}
            </form>

            {txStatus && mode==='direct' && (
              <div className="card" style={{marginTop:16, padding:16, background:'var(--paper)'}}>
                <h4 style={{fontSize:12, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:12}}>Fabric Lifecycle — trust signal</h4>
                {['submitting','endorsing','committing','confirmed'].map((step, idx) => (
                  <div key={step} className="tx-step">
                    <div className={`tx-step-dot ${txStatus.step===step ? 'active' : ['submitting','endorsing','committing'].indexOf(txStatus.step) > idx || txStatus.step==='confirmed' ? 'done' : 'pending'}`}>{txStatus.step===step ? '⟳' : txStatus.step==='confirmed' || ['submitting','endorsing','committing'].indexOf(txStatus.step) > idx ? '✓' : '○'}</div>
                    <div style={{flex:1}}><div style={{fontSize:13, fontWeight:600, textTransform:'capitalize'}}>{step}</div></div>
                    <div style={{fontSize:11, color: txStatus.step===step ? 'var(--pending-amber)' : 'var(--verified-green)'}}>{txStatus.step===step ? '⟳' : txStatus.step==='confirmed' ? '✓' : ''}</div>
                  </div>
                ))}
                {txStatus.transferId && <div style={{fontSize:11, fontFamily:'ui-monospace, monospace', marginTop:8}}>TXN: {txStatus.transferId}</div>}
              </div>
            )}
            {msg && <div style={{marginTop:12, padding:'10px 12px', borderRadius:'var(--radius)', background: msg.includes('failed') ? 'rgba(161,61,46,0.08)' : 'rgba(47,107,79,0.08)', border: `1px solid ${msg.includes('failed') ? 'rgba(161,61,46,0.15)' : 'rgba(47,107,79,0.15)'}`, fontSize:13, color: msg.includes('failed') ? 'var(--error-rust)' : 'var(--verified-green)'}}>{msg}</div>}
          </div>
        </div>
      )}

      {/* Transfer Tab — Full DvP */}
      {activeTab==='transfer' && (
        <div>
          <div className="card" style={{marginBottom:24}}>
            <h3 style={{marginBottom:4}}>Transfer Mode — Real Money Flow via Testnet</h3>
            <div style={{display:'flex', gap:12, marginTop:12}}>
              <button onClick={()=>setMode('direct')} className={mode==='direct' ? 'btn btn-primary' : 'btn btn-secondary'} style={{flex:1}}>
                Direct Drunix Transfer — no payment rail (mock)
              </button>
              <button onClick={()=>setMode('testnet')} className={mode==='testnet' ? 'btn btn-primary' : 'btn btn-secondary'} style={{flex:1, background: mode==='testnet' ? 'var(--registry-navy)' : ''}}>
                🔒 Atomic DvP — Sepolia Testnet Escrow — Real Money Flow
              </button>
            </div>
            <div style={{marginTop:12, fontSize:11, color:'var(--ink-60)'}}>
              Direct = only Drunix tokens move. Testnet DvP = test ETH locked in PaymentEscrow.sol → Drunix transfer → releasePayment() → atomic Delivery vs Payment. If Drunix fails, refundPayment() refunds investor. No real money risk.
            </div>
          </div>

          {mode==='direct' ? (
            <div className="card">
              <h3>Direct Transfer Form</h3>
              <form onSubmit={handleTransfer} style={{display:'flex', flexDirection:'column', gap:14, marginTop:16, maxWidth:480}}>
                <input className="input" value={transferForm.assetId} onChange={e=>setTransferForm({...transferForm, assetId:e.target.value})} placeholder="AssetId PROP-..." required />
                <input className="input" value={transferForm.toId} onChange={e=>setTransferForm({...transferForm, toId:e.target.value})} placeholder="Recipient investor2" required />
                <input className="input" type="number" value={transferForm.amount} onChange={e=>setTransferForm({...transferForm, amount:e.target.value})} placeholder="Amount tokens" required />
                <div style={{fontSize:12}}>Value: ₹{estimatedValue.toLocaleString('en-IN')} ≈ {estimatedEth} ETH · Max {maxBal}</div>
                <button type="submit" className="btn btn-primary">Transfer — Direct</button>
              </form>
              {msg && <div style={{marginTop:12, fontSize:12, color: msg.includes('failed') ? 'var(--error-rust)' : 'var(--verified-green)'}}>{msg}</div>}
            </div>
          ) : (
            <TestnetPayment 
              assetId={transferForm.assetId || wallet?.balances[0]?.balance?.assetId || 'PROP-demo'} 
              tokenAmount={amountNum || parseInt(transferForm.amount) || 100}
              tokenPrice={tokenPrice}
              recipient={transferForm.toId}
              onPaymentComplete={(pid, drunixId) => {
                const pId = typeof pid === 'string' ? pid : pid?.paymentId || pid
                const dId = typeof drunixId === 'string' ? drunixId : pid?.drunixTransferId || 'TXN-...'
                setMsg(`✅ Atomic DvP complete — testnet ${String(pId).slice(0,12)}... ↔ Drunix ${String(dId).slice(0,16)}... — real money flow involved, no real money risk`)
                fetchWallet()
                fetchHistory()
                fetchTestnetPayments()
              }}
            />
          )}
        </div>
      )}

      {/* Testnet History Tab */}
      {activeTab==='testnetHistory' && (
        <div className="card">
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:12}}>
            <div>
              <h3>Testnet Escrow History — Real Money Flow</h3>
              <p style={{fontSize:11, color:'var(--ink-40)'}}>Sepolia Testnet payments linked to Drunix TransferRecord via paymentId ↔ drunixTransferId · Etherscan verifiable · No real money risk</p>
            </div>
            <button className="btn btn-secondary" style={{fontSize:11}} onClick={fetchTestnetPayments}>Refresh Escrow History</button>
          </div>

          {testnetPayments.length===0 ? (
            <div className="empty-state">
              <p>No testnet payments yet. Go to Transfer tab → Atomic DvP mode → Connect MetaMask Sepolia → Pay test ETH → see DvP flow.</p>
              <div style={{fontSize:11, color:'var(--ink-40)', marginTop:8}}>
                Faucet: <a href="https://sepoliafaucet.com/" target="_blank" style={{color:'var(--registry-navy)'}}>sepoliafaucet.com</a> — 0.5 SepoliaETH free
              </div>
            </div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:12, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-8)', fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase'}}>
                  <th style={{padding:'8px'}}>PaymentId</th><th>Asset</th><th>Tokens → ETH</th><th>Tx Hash → Etherscan</th><th>Drunix TXN</th><th>Status</th><th>Time</th>
                </tr></thead>
                <tbody>
                  {testnetPayments.map((p, i) => (
                    <tr key={i} style={{borderBottom:'1px solid var(--ink-8)'}}>
                      <td style={{padding:'8px', fontFamily:'ui-monospace, monospace', fontSize:10}}>{p.paymentId?.slice(0,16)}...</td>
                      <td style={{fontSize:11}}>{p.assetId?.slice(0,12)}...</td>
                      <td className="tabular">{p.tokenAmount} → {p.estimatedEth} ETH</td>
                      <td style={{fontSize:10, fontFamily:'ui-monospace, monospace'}}>
                        <a href={p.sepoliaExplorer || `https://sepolia.etherscan.io/tx/${p.txHash}`} target="_blank" style={{color:'var(--registry-navy)'}}>
                          {p.txHash?.slice(0,16)}... → Etherscan
                        </a>
                      </td>
                      <td style={{fontSize:10, fontFamily:'ui-monospace, monospace'}}>{p.drunixTransferId?.slice(0,16) || 'pending...'}</td>
                      <td><span className={`status-chip ${p.status==='RELEASED' ? 'status-tokenized' : p.status==='PENDING' ? 'status-pending' : 'status-draft'}`} style={{fontSize:9}}>{p.status}</span></td>
                      <td style={{fontSize:10, color:'var(--ink-60)'}}>{p.createdAt ? new Date(p.createdAt).toLocaleString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{marginTop:16, background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:'var(--radius)', padding:12, fontSize:11, color:'var(--ink-60)'}}>
            <strong>How atomic DvP works:</strong> 1. Investor calls initiatePayment() locking test ETH in PaymentEscrow.sol (real Sepolia tx with gas) → 2. Backend listens PaymentInitiated event → 3. Calls TransferTokens on Drunix (property tokens move) → 4. Calls confirmDrunixTransfer() linking TXN-... → 5. releasePayment() sends test ETH to originator. If step 3 fails, refundPayment() refunds investor. No partial state — either both legs succeed or both refunded. Production: replace test ETH with mainnet USDC + Chainlink oracle, same logic.
          </div>
        </div>
      )}

      {/* Recent Activity — Always visible below tabs */}
      <div className="card" style={{marginTop:24}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
          <div>
            <h3>Recent activity — wallet + transfer history</h3>
            <p style={{fontSize:11, color:'var(--ink-40)'}}>Immutable TransferRecord · Bookmark cursor pagination per A3 · Total {pagination.total} Drunix transfers</p>
          </div>
          <span style={{fontSize:11, color:'var(--ink-40)'}}>{history.length}/{pagination.total} · HasMore {pagination.hasMore ? 'yes' : 'no'} · Testnet {testnetPayments.length} escrows</span>
        </div>
        {history.length === 0 ? (
          <div className="empty-state"><p>No transfers yet. Perform a transfer to see immutable audit trail with pagination.</p></div>
        ) : (
          <>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:13, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-8)', fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase'}}><th style={{padding:'8px'}}>TXN ID</th><th>Asset</th><th>From → To</th><th>Amount</th><th>Linked Testnet Payment</th><th>Time</th></tr></thead>
                <tbody>
                  {history.map(tx => {
                    const linked = testnetPayments.find(p => p.drunixTransferId===tx.transferId)
                    return (
                      <tr key={tx.transferId} style={{borderBottom:'1px solid var(--ink-8)'}}>
                        <td style={{padding:'8px', fontFamily:'ui-monospace, monospace', fontSize:11}}>{tx.transferId.slice(0,18)}...</td>
                        <td style={{fontSize:11}}>{tx.assetId.slice(0,12)}...</td>
                        <td style={{fontSize:12}}>{tx.fromId} → {tx.toId}</td>
                        <td className="tabular" style={{color:'var(--ink)', fontWeight:700}}>{tx.amount}</td>
                        <td style={{fontSize:10}}>
                          {linked ? (
                            <a href={linked.sepoliaExplorer} target="_blank" style={{color:'var(--registry-navy)'}}>
                              {linked.paymentId.slice(0,10)}... ({linked.estimatedEth} ETH) → Etherscan
                            </a>
                          ) : (
                            <span style={{color:'var(--ink-40)'}}>Direct (no escrow)</span>
                          )}
                        </td>
                        <td style={{fontSize:11, color:'var(--ink-60)'}}>{new Date(tx.txTimestamp).toLocaleString()}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {pagination.hasMore && (
              <button className="btn btn-secondary" style={{marginTop:12, fontSize:12}} onClick={() => fetchHistory(pagination.bookmark, true)}>
                Load more — bookmark {pagination.bookmark.slice(0,12)}...
              </button>
            )}
          </>
        )}
      </div>

      <FailureModeDemo user={user} />
    </div>
  )
}
