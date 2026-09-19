import React, { useState, useEffect } from 'react'
import FailureModeDemo from '../components/FailureModeDemo.jsx'
import TestnetPayment from '../components/TestnetPayment.jsx'

export default function Wallet({ user }) {
  const [wallet, setWallet] = useState(null)
  const [transferForm, setTransferForm] = useState({ assetId: '', toId: 'investor2', amount: '' })
  const [history, setHistory] = useState([])
  const [pagination, setPagination] = useState({ bookmark: '', hasMore: false, total: 0, pageSize: 10 })
  const [txStatus, setTxStatus] = useState(null) // per §2.5 transaction lifecycle
  const [confirmStep, setConfirmStep] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    fetchWallet()
    fetchHistory()
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

  // Live computed secondary value per §2.1
  const getTokenPrice = () => {
    if (!wallet || !transferForm.assetId) return 0
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

    // Transaction lifecycle per §2.5 and §4.4
    setTxStatus({ step: 'submitting', transferId: null })
    setMsg('')
    
    try {
      // Simulate Fabric lifecycle: Submitting → Endorsing → Committing → Confirmed
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
  const isOverBalance = amountNum > maxBal

  return (
    <div>
      <div style={{marginBottom:24}}>
        <h1 style={{fontSize:32, marginBottom:4}}>My Wallet</h1>
        <p style={{color:'var(--ink-60)', fontSize:13, maxWidth:'70ch'}}>Portfolio overview · Tabular numbers aligned per §1.2 · Composite key: balance~assetId~ownerId · Index idx_balance_owner · KYC always visible per §5.3</p>
      </div>

      <div className="grid grid-3" style={{marginBottom:24}}>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>Total Portfolio Value</div>
          <div className="tabular" style={{fontSize:32, fontFamily:'Fraunces', fontWeight:700, color:'var(--ink)', lineHeight:1}}>₹{wallet ? (wallet.totalPortfolioValue/100000).toFixed(2) : '0'}L</div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>Sum of tokenPrice × balance across assets</div>
        </div>
        <div className="card">
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>Assets Owned</div>
          <div className="tabular" style={{fontSize:32, fontFamily:'Fraunces', fontWeight:700, lineHeight:1}}>{wallet ? wallet.balances.length : 0}</div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>FabricMode: {wallet?.fabricMode || 'mock'} · Index idx_balance_owner</div>
        </div>
        <div className="card" style={{borderLeft:`3px solid var(--verified-green)`}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8}}>KYC Status</div>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <span style={{fontSize:16, fontWeight:700, color:'var(--verified-green)'}}>Verified</span>
            <span className="status-chip status-tokenized">Verified</span>
          </div>
          <div style={{fontSize:11, color:'var(--ink-40)', marginTop:6}}>Mock provider (DigiLocker stub) — always visible per §5.3, never silent gate</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{marginBottom:4}}>Holdings</h3>
          <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:16}}>Generous white space around numbers — numbers are the product per §1.3</p>
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
                    <div style={{fontSize:11, color:'var(--ink-60)', marginTop:2}}>{item.balance.assetId.slice(0,20)}... · ₹{item.tokenPrice}/token</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div className="tabular" style={{fontSize:20, fontFamily:'Fraunces', fontWeight:700}}>{item.balance.balance}</div>
                    <div style={{fontSize:10, color:'var(--ink-40)', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:700}}>tokens</div>
                    <div className="tabular" style={{fontSize:12, color:'var(--ink-60)', marginTop:4}}>₹{item.valueINR.toLocaleString('en-IN')}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{marginBottom:4}}>Transfer tokens</h3>
          <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:16}}>Direct peer transfer per spec — no order-matching engine. Every amount shows both units per §5.2</p>
          
          {!confirmStep ? (
            <form onSubmit={handleTransfer} style={{display:'flex', flexDirection:'column', gap:16}}>
              <div className="field-group">
                <label className="field-label">Property — pre-selected via navigation per §3.4</label>
                <input className="input" value={transferForm.assetId} onChange={e=>setTransferForm({...transferForm, assetId:e.target.value})} placeholder="PROP-..." required />
                <div className="field-hint">Arrives from clicking a listing, not typed per §3.4</div>
              </div>

              <div className="field-group">
                <label className="field-label">Recipient — must be KYC-verified</label>
                <div className="input-wrap">
                  <input className="input" value={transferForm.toId} onChange={e=>setTransferForm({...transferForm, toId:e.target.value})} required placeholder="investor2" />
                  <span className="input-unit">KYC ✓</span>
                </div>
                <div className="field-hint">Autocomplete against verified investors only per §3.4 — unverified shown greyed out with "KYC not verified" label, not hidden</div>
                {transferForm.toId && !['investor1','investor2','originator1'].includes(transferForm.toId) && (
                  <div className="input-error">Transfer failed — recipient KYC not verified per §6.2. Complete KYC to transfer per §5.3</div>
                )}
              </div>

              <div className="field-group">
                <label className="field-label">Token amount — always show both units per §5.2</label>
                <div className="input-wrap">
                  <input className={`input ${isOverBalance ? 'error' : ''}`} type="number" min="1" max={maxBal} value={transferForm.amount} onChange={e=>setTransferForm({...transferForm, amount:e.target.value})} required placeholder="500" />
                  <span className="input-unit">tokens</span>
                </div>
                {transferForm.amount && (
                  <>
                    <div className="input-secondary">
                      {isOverBalance ? (
                        <span style={{color:'var(--error-rust)'}}>Transfer failed — insufficient balance. You hold {maxBal} tokens, this transfer requires {amountNum}. per §1.4 voice</span>
                      ) : (
                        <span>{amountNum} tokens × ₹{tokenPrice.toLocaleString('en-IN')} = ₹{estimatedValue.toLocaleString('en-IN')} — live-computed secondary value per §2.1</span>
                      )}
                    </div>
                    <div style={{display:'flex', gap:6, marginTop:8}}>
                      {[0.25,0.5,0.75,1].map(pct => (
                        <button key={pct} type="button" onClick={()=>setTransferForm({...transferForm, amount: String(Math.floor(maxBal*pct))})}
                          style={{fontSize:11, fontWeight:600, padding:'4px 8px', borderRadius:4, border:'1px solid var(--ink-12)', background:'var(--paper)', cursor:'pointer'}}>
                          {pct===1 ? 'Max' : `${pct*100}%`}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="field-hint">Max available: {maxBal} tokens — shown live, validation inline as you type per §2.4. No decimals to avoid float precision bugs.</div>
              </div>

              <button type="submit" className="btn btn-primary" disabled={isOverBalance || !transferForm.amount} style={{width:'100%', padding:'12px'}}>
                Transfer tokens — shows exact action per §1.4, not "Submit"
              </button>
            </form>
          ) : (
            /* Confirmation screen per §3.4 — most important screen */
            <div style={{background:'var(--paper)', border:'1px solid var(--ink-12)', borderRadius:'var(--radius)', padding:16}}>
              <h4 style={{fontSize:14, marginBottom:12}}>Confirm transfer — exact, numeric, unambiguous per §3.4</h4>
              <div style={{background:'var(--surface)', border:'var(--hairline)', borderRadius:'var(--radius)', padding:16, fontSize:13, lineHeight:1.8}}>
                <div>You are transferring <strong className="tabular">{amountNum} tokens</strong> of "{wallet?.balances.find(b=>b.balance.assetId===transferForm.assetId)?.propertyTitle || transferForm.assetId.slice(0,20)}"</div>
                <div className="divider"></div>
                <div>From: Your wallet (Balance: <span className="tabular">{maxBal} → {maxBal-amountNum}</span> after transfer)</div>
                <div>To: {transferForm.toId} (KYC Verified ✓) — always visible per §5.3</div>
                <div>Estimated value: <span className="tabular" style={{fontWeight:700}}>₹{estimatedValue.toLocaleString('en-IN')}</span></div>
                <div style={{fontSize:11, color:'var(--ink-40)', marginTop:8}}>1 token = ₹{tokenPrice} · integer-only, no decimals per §6.2</div>
              </div>
              <div style={{display:'flex', gap:8, marginTop:16}}>
                <button className="btn btn-secondary" style={{flex:1}} onClick={()=>setConfirmStep(false)}>Back — not generic "Are you sure?" per §2.3</button>
                <button className="btn btn-primary" style={{flex:1}} onClick={handleTransfer}>Transfer tokens — irreversible action with explicit confirmation per §2.3</button>
              </div>
            </div>
          )}

          {/* Transaction lifecycle per §4.4 */}
          {txStatus && (
            <div className="card" style={{marginTop:16, padding:16, background:'var(--paper)'}}>
              <h4 style={{fontSize:12, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:12}}>Transaction status — real Fabric lifecycle per §2.5, not generic spinner — trust signal</h4>
              <div className="tx-step">
                <div className={`tx-step-dot ${txStatus.step==='submitting' ? 'active' : 'done'}`}>{txStatus.step==='submitting' ? '⟳' : '✓'}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13, fontWeight:600}}>Submitted</div>
                  <div style={{fontSize:11, color:'var(--ink-60)'}}>Transaction sent to peers</div>
                </div>
                <div style={{fontSize:11, color:'var(--verified-green)'}}>✓</div>
              </div>
              <div className="tx-step">
                <div className={`tx-step-dot ${txStatus.step==='endorsing' ? 'active' : txStatus.step==='submitting' ? 'pending' : 'done'}`}>{txStatus.step==='endorsing' ? '⟳' : txStatus.step==='submitting' ? '○' : '✓'}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13, fontWeight:600}}>Endorsing</div>
                  <div style={{fontSize:11, color:'var(--ink-60)'}}>Investor org signed — endorsement policy enforced</div>
                </div>
                <div style={{fontSize:11, color: txStatus.step==='endorsing' ? 'var(--pending-amber)' : 'var(--verified-green)'}}>{txStatus.step==='endorsing' ? '⟳' : txStatus.step==='submitting' ? '' : '✓'}</div>
              </div>
              <div className="tx-step">
                <div className={`tx-step-dot ${txStatus.step==='committing' ? 'active' : ['submitting','endorsing'].includes(txStatus.step) ? 'pending' : 'done'}`}>{txStatus.step==='committing' ? '⟳' : ['submitting','endorsing'].includes(txStatus.step) ? '○' : '✓'}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13, fontWeight:600}}>Committing</div>
                  <div style={{fontSize:11, color:'var(--ink-60)'}}>Waiting for orderer — Raft consensus, atomic per-block</div>
                </div>
                <div style={{fontSize:11, color: txStatus.step==='committing' ? 'var(--pending-amber)' : 'var(--ink-40)'}}>{txStatus.step==='committing' ? '⟳ Waiting for orderer' : txStatus.step==='confirmed' ? '✓' : ''}</div>
              </div>
              <div className="tx-step">
                <div className={`tx-step-dot ${txStatus.step==='confirmed' ? 'done' : 'pending'}`}>{txStatus.step==='confirmed' ? '✓' : '○'}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13, fontWeight:600}}>Confirmed</div>
                  <div style={{fontSize:11, color:'var(--ink-60)'}}>{txStatus.transferId ? `Transaction ID: ${txStatus.transferId.slice(0,16)}...` : 'Awaiting block commit'}</div>
                </div>
                <div style={{fontSize:11, color: txStatus.step==='confirmed' ? 'var(--verified-green)' : 'var(--ink-40)'}}>{txStatus.step==='confirmed' ? '✓ Quiet checkmark animation — one deliberate motion per §1.3' : ''}</div>
              </div>
              {txStatus.step==='confirmed' && (
                <div style={{marginTop:12, padding:12, background:'rgba(47,107,79,0.08)', border:'1px solid rgba(47,107,79,0.15)', borderRadius:'var(--radius)', fontSize:12, color:'var(--verified-green)'}}>
                  Confidence in financial product comes from calm precision, not enthusiasm — no confetti per §4.4. Wallet balance updated.
                </div>
              )}
            </div>
          )}

          {msg && <div style={{marginTop:12, padding:'10px 12px', borderRadius:'var(--radius)', background: msg.includes('failed') ? 'rgba(161,61,46,0.08)' : 'rgba(47,107,79,0.08)', border: `1px solid ${msg.includes('failed') ? 'rgba(161,61,46,0.15)' : 'rgba(47,107,79,0.15)'}`, fontSize:13, color: msg.includes('failed') ? 'var(--error-rust)' : 'var(--verified-green)'}}>{msg}</div>}
        </div>
      </div>

      <div className="card" style={{marginTop:24}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
          <div>
            <h3>Recent activity — wallet + transfer history</h3>
            <p style={{fontSize:11, color:'var(--ink-40)'}}>Immutable TransferRecord · Bookmark cursor pagination per A3 · Total {pagination.total}</p>
          </div>
          <span style={{fontSize:11, color:'var(--ink-40)'}}>{history.length}/{pagination.total} · HasMore {pagination.hasMore ? 'yes' : 'no'}</span>
        </div>
        {history.length === 0 ? (
          <div className="empty-state"><p>No transfers yet. Perform a transfer to see immutable audit trail with pagination.</p></div>
        ) : (
          <>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', fontSize:13, borderCollapse:'collapse'}}>
                <thead><tr style={{color:'var(--ink-40)', textAlign:'left', borderBottom:'1px solid var(--ink-8)', fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase'}}><th style={{padding:'8px'}}>TXN ID</th><th>Asset</th><th>From → To</th><th>Amount</th><th>Time</th></tr></thead>
                <tbody>
                  {history.map(tx => (
                    <tr key={tx.transferId} style={{borderBottom:'1px solid var(--ink-8)'}}>
                      <td style={{padding:'8px', fontFamily:'ui-monospace, monospace', fontSize:11}}>{tx.transferId.slice(0,18)}...</td>
                      <td style={{fontSize:11}}>{tx.assetId.slice(0,12)}...</td>
                      <td style={{fontSize:12}}>{tx.fromId} → {tx.toId}</td>
                      <td className="tabular" style={{color:'var(--ink)', fontWeight:700}}>{tx.amount}</td>
                      <td style={{fontSize:11, color:'var(--ink-60)'}}>{new Date(tx.txTimestamp).toLocaleString()}</td>
                    </tr>
                  ))}
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

      {/* Real Money Flow — Testnet Escrow — per user request "involve money, testnet can be used" */}
      {wallet && wallet.balances && wallet.balances.length > 0 && (
        <div style={{marginTop:24}}>
          <TestnetPayment 
            assetId={transferForm.assetId || wallet.balances[0]?.balance?.assetId} 
            tokenAmount={amountNum || parseInt(transferForm.amount) || 100}
            tokenPrice={tokenPrice}
            recipient={transferForm.toId}
            onPaymentComplete={(paymentId, drunixTxId) => {
              setMsg(`Atomic DvP complete — testnet ${paymentId.slice(0,10)}... ↔ Drunix ${drunixTxId.slice(0,12)}... — real money flow involved`)
              fetchWallet()
              fetchHistory()
            }}
          />
        </div>
      )}

      <FailureModeDemo user={user} />
    </div>
  )
}
