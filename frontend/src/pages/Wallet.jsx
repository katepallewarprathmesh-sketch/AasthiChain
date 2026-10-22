import React, { useState, useEffect } from 'react'
import { money } from '../lib/format.js'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import UMIPortfolioPanel from '../components/UMIPortfolioPanel.jsx'
import TransactionHistory from '../components/TransactionHistory.jsx'
import { useLocalCache } from '../hooks/useLocalCache.js'
import {
  Button, Badge, SimBadge, Card as AxCard, Metric as AxMetric, Num, Mono,
  EmptyState, ErrorState, Skeleton, inr, InfoTip,
} from '../components/ui.jsx'

// SOLID: Single Responsibility Only wallet display + transfer for layman

function SimpleHoldingCard({ holding }) {
  const balance = holding.balance
  const propertyTitle = holding.propertyTitle || balance.assetId?.slice(0, 16) || 'Property'
  const tokenPrice = holding.tokenPrice || 500
  const value = holding.valueINR || (balance.balance * tokenPrice)

  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14,
      flexWrap: 'wrap', border: '1px solid var(--ax-line)', borderRadius: 'var(--ax-r)',
      padding: '14px 16px', background: '#fff', minWidth: 0,
    }}>
      <div style={{ minWidth: 0, flex: '1 1 200px' }}>
        <Link
          to={`/property/${encodeURIComponent(balance.assetId)}`}
          style={{ fontSize: 15, fontWeight: 650, color: 'var(--ax-ink)', textDecoration: 'none', overflowWrap: 'anywhere' }}
        >{propertyTitle}</Link>
        <p className="ax-hint" style={{ marginTop: 3 }}>
          <Num>{Number(balance.balance || 0).toLocaleString('en-IN')}</Num> tokens
          {tokenPrice ? <> · <Num>{inr(tokenPrice)}</Num> each</> : null}
        </p>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="ax-metric-value" style={{ fontSize: 19, marginTop: 0 }}><Num>{inr(value)}</Num></div>
        <p className="ax-hint" style={{ marginTop: 2 }}>at last valuation</p>
      </div>
    </div>
  )
}

const TRANSFER_ERRORS = {
  ERR_BALANCE_NOT_FOUND: 'We could not find your tokens on the server just now. Tap Refresh and try again in a few seconds.',
  ERR_INSUFFICIENT_BALANCE: 'Not enough tokens for that amount. Check how many you own above.',
  ERR_ASSET_FROZEN: 'This property is temporarily frozen by the regulator. Transfers are paused.',
  ERR_ASSET_NOT_FOUND: 'Property not found. Tap Refresh and try again.',
  ERR_INVALID_TRANSFER: 'You cannot send tokens to yourself.',
  ERR_KYC_NOT_VERIFIED: 'The person receiving has not finished verification. Try sending to investor2.'
}

export default function Wallet({ user }) {
  const { loadHoldings, adjustHolding, syncHoldingFromServer } = useLocalCache()
  const [wallet, setWallet] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [transferForm, setTransferForm] = useState({ assetId: '', toId: '', amount: '' })
  const [transferMsg, setTransferMsg] = useState('')

  const identityId = user?.identityId || 'investor1'

  const fetchWallet = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getWallet(identityId)
      // Merge server holdings with local receipts a cold server instance may not
      // have balances yet, but your verified purchases on this device still count
      const local = loadHoldings(identityId)
      const byAsset = {}
      ;(data.balances || []).forEach(b => { byAsset[b.balance.assetId] = b })
      Object.keys(local).forEach(assetId => {
        const h = local[assetId]
        if (!h || !(h.balance > 0)) return
        if (byAsset[assetId]) {
          if ((byAsset[assetId].balance?.balance || 0) < h.balance) {
            byAsset[assetId] = {
              ...byAsset[assetId],
              balance: { ...byAsset[assetId].balance, balance: h.balance },
              valueINR: (h.tokenPrice || byAsset[assetId].tokenPrice || 0) * h.balance,
              fromDevice: true
            }
          } else {
            // Server authoritative sync local down
            syncHoldingFromServer(identityId, assetId, byAsset[assetId].balance?.balance || 0)
          }
        } else {
          byAsset[assetId] = {
            balance: { docType: 'balance', assetId, ownerId: identityId, balance: h.balance },
            propertyTitle: h.title || assetId.slice(0, 16),
            tokenPrice: h.tokenPrice || 0,
            valueINR: (h.tokenPrice || 0) * h.balance,
            fromDevice: true
          }
        }
      })
      const merged = Object.values(byAsset)
      const total = merged.reduce((s, b) => s + (b.valueINR || 0), 0)
      setWallet({ ...data, balances: merged, totalPortfolioValue: total })
    } catch (e) {
      setError(e.message)
      setWallet({ balances: [], totalPortfolioValue: 0 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchWallet()
  }, [identityId])

  const handleTransfer = async (e) => {
    e.preventDefault()
    setTransferMsg('')
    const amount = parseInt(transferForm.amount)
    const local = loadHoldings(identityId)
    const h = local[transferForm.assetId]
    const holding = (wallet?.balances || []).find(b => b.balance.assetId === transferForm.assetId)
    const effectiveBalance = Math.max(holding?.balance?.balance || 0, h?.balance || 0)

    if (amount > effectiveBalance) {
      setTransferMsg(`You own ${effectiveBalance} tokens of this property you cannot send ${amount}.`)
      return
    }

    try {
      const result = await api.transferTokens(
        transferForm.assetId,
        identityId,
        transferForm.toId.trim(),
        amount,
        {
          claimedBalance: effectiveBalance,
          property: h ? {
            assetId: transferForm.assetId,
            title: h.title,
            valuationINR: h.valuationINR,
            totalTokens: h.totalTokens,
            originatorId: h.originatorId,
            status: 'TOKENIZED',
            registrarValidationStatus: 'VALIDATED'
          } : undefined,
          receipts: (h?.receipts || []).map(r => ({
            paymentId: r.paymentId,
            assetId: transferForm.assetId,
            payerId: r.payerId,
            tokenAmount: r.tokenAmount,
            amountINR: r.amountINR,
            status: r.status,
            upiTxnId: r.upiTxnId,
            createdAt: r.createdAt
          }))
        }
      )
      // Move local overlay down so the next screen agrees
      adjustHolding(identityId, transferForm.assetId, -amount)
      setTransferMsg(`✓ Sent ${result.amount} tokens to ${result.toId} done!`)
      setTransferForm({ assetId: '', toId: '', amount: '' })
      fetchWallet()
    } catch (err) {
      const code = err.data?.error || ''
      const friendly = TRANSFER_ERRORS[code] || TRANSFER_ERRORS[Object.keys(TRANSFER_ERRORS).find(k => code.startsWith(k))] || err.message
      setTransferMsg(friendly)
    }
  }

  const totalValue = wallet?.totalPortfolioValue || 0
  const holdings = wallet?.balances || []
  const [nav, setNav] = useState(null)
  const [loans, setLoans] = useState([])
  const [allProps, setAllProps] = useState([])
  const [swapForm, setSwapForm] = useState({ giveAssetId: '', giveTokens: '', getAssetId: '', getTokens: '', counterparty: 'investor2' })
  const [swapMsg, setSwapMsg] = useState(null)
  const [swapErr, setSwapErr] = useState(null)
  const [repayMsg, setRepayMsg] = useState(null)

  const loadOwnership = async () => {
    try { setNav(await api.portfolioNav(identityId)) } catch {}
    try { setLoans((await api.getLoans(identityId)).loans || []) } catch {}
  }
  useEffect(() => { loadOwnership() }, [identityId])
  useEffect(() => {
    api.listProperties().then(d => setAllProps(d.properties || [])).catch(() => {})
  }, [])

  const handleSwap = async (e) => {
    e.preventDefault(); setSwapMsg(null); setSwapErr(null)
    try {
      const r = await api.atomicSwap(swapForm.giveAssetId, parseInt(swapForm.giveTokens), swapForm.getAssetId, parseInt(swapForm.getTokens), swapForm.counterparty)
      setSwapMsg(`✓ Swap ${r.swapId} settled atomically on block #${r.blockHeight}: gave ${r.gave.tokens} of ${r.gave.assetId.slice(0,14)}…, received ${r.received.tokens} of ${r.received.assetId.slice(0,14)}…`)
      setSwapForm({ giveAssetId: '', giveTokens: '', getAssetId: '', getTokens: '', counterparty: 'investor2' })
      loadOwnership(); fetchWallet()
    } catch (err) {
      setSwapErr(err.data?.message || err.message || 'Swap failed, nothing moved')
    }
  }

  const handleRepay = async (loanId) => {
    setRepayMsg(null)
    try {
      const r = await api.repayLoan(loanId)
      setRepayMsg(`✓ ${r.message} (block #${r.blockHeight})`)
      loadOwnership()
    } catch (err) {
      setRepayMsg(err.data?.message || err.message || 'Repay failed')
    }
  }

  return (
    <main className="ax ax-wrap" style={{ maxWidth: 980, paddingTop: 26, paddingBottom: 64, minWidth: 0 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18, flexWrap: 'wrap' }}>
        <div>
          <p className="ax-eyebrow">Wallet</p>
          <h1 className="ax-display ax-h2">Your holdings and cash</h1>
          <p className="ax-lede" style={{ fontSize: 15.5 }}>
            Property tokens you hold, their value at the last recorded price, and the payment record
            behind each movement.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button to="/marketplace" variant="secondary" size="sm">Browse properties</Button>
          <Button size="sm" onClick={fetchWallet} disabled={loading}>{loading ? 'Refreshing' : 'Refresh'}</Button>
        </div>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14, marginTop: 22 }}>
        <AxMetric
          label="Token value held"
          value={loading ? <Skeleton h={26} w="70%" /> : <Num>{inr(totalValue)}</Num>}
          foot={<><Num>{holdings.length}</Num> {holdings.length === 1 ? 'property' : 'properties'} · valuation, not a quoted price</>}
          tip="Tokens valued at the price recorded against each property. Nobody has offered to buy them at this price."
        />
        <AxMetric
          label="Portfolio net asset value"
          value={nav ? <Num>{inr(nav.navINR)}</Num> : 'Not available'}
          foot={nav ? 'Marked to the last trade price, after loans' : 'The valuation service did not answer'}
        />
        <AxMetric
          label="Credit outstanding"
          value={nav ? <Num>{inr(nav.outstandingDebtINR)}</Num> : 'Not available'}
          foot={nav ? <><Num>{nav.activeLoans}</Num> active loan(s) against pledged tokens</> : 'Unknown while the valuation service is down'}
        />
      </section>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        <SimBadge>Cash legs are simulated</SimBadge>
        <Badge tone="info">Test payment providers only</Badge>
      </div>
      <p className="ax-hint" style={{ marginTop: 8, maxWidth: '84ch' }}>
        The digital rupee balance below is simulated central bank money on this rail. Card and UPI
        flows run against test providers. No real money moves anywhere in this product, and a payment
        marked settled here is a settled simulation.
      </p>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorState title="The wallet did not load fully" detail={error} onRetry={fetchWallet} />
        </div>
      )}

      <AxCard
        title="Properties you hold"
        sub="Each one links to its property page, where the register and the verification checks live."
        style={{ marginTop: 20 }}
      >
        {loading ? (
          <div style={{ display: 'grid', gap: 10 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={62} />)}</div>
        ) : holdings.length === 0 ? (
          <EmptyState
            title="No properties yet"
            body="Fractional ownership starts at ₹500. When you buy tokens, they appear here with their valuation and the settlement that created them."
            action={<Button to="/marketplace" size="sm">Explore properties</Button>}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {holdings.map((h, i) => <SimpleHoldingCard key={i} holding={h} />)}
          </div>
        )}
      </AxCard>

      <UMIPortfolioPanel identityId={identityId} />

      <TransactionHistory
        identityId={identityId}
        titleFor={(assetId) => (allProps.find(p => p.assetId === assetId) || {}).title}
        priceFor={(assetId) => {
          const p = allProps.find(p => p.assetId === assetId) || {}
          return p.pricePerTokenINR || p.tokenPrice || 0
        }}
      />

      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 24, minWidth: 0 }}>
        {nav && (
          <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
              <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Portfolio NAV</h3>
                <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Continuous net asset value, marked to last trade price</p>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#1E3A5F', overflowWrap: 'anywhere' }}>{money(nav.navINR)}</div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              {[['Assets', money(nav.assetsValueINR), '#111827'], ['Yield earned', '+' + money(nav.yieldEarnedINR), '#065F46'], ['Loan due', '-' + money(nav.outstandingDebtINR), '#991B1B'], ['Active loans', String(nav.activeLoans), '#374151']].map(([k, v, c]) => (
                <div key={k} style={{ flex: 1, minWidth: 110, background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 700 }}>{k}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: c, marginTop: 3 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loans.filter(l => l.status === 'ACTIVE').length > 0 && (
          <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 16 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Credit against your tokens</h3>
            {repayMsg && <div style={{ fontSize: 12, color: '#065F46', marginTop: 8 }}>{repayMsg}</div>}
            {loans.filter(l => l.status === 'ACTIVE').map(l => (
              <div key={l.loanId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 8, padding: 12, marginTop: 10, minWidth: 0 }}>
                <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', overflowWrap: 'anywhere' }}>{money(l.principalINR)} borrowed · {l.tokens} tokens pledged</div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2, overflowWrap: 'anywhere' }}>Repay {money(Math.round(l.principalINR * 1.01 * 100) / 100)} (1% fee) to unlock · {l.loanId}</div>
                </div>
                <button onClick={() => handleRepay(l.loanId)} style={{ padding: '8px 14px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Repay now</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Multi-property swap</h3>
          <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Exchange tokens across two properties in one atomic transaction. Either both legs move, or neither.</p>
          {swapMsg && <div style={{ fontSize: 12, color: '#065F46', marginTop: 8, wordBreak: 'break-all' }}>{swapMsg}</div>}
          {swapErr && <div style={{ fontSize: 12, color: '#991B1B', marginTop: 8 }}>{swapErr}</div>}
          <form onSubmit={handleSwap} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <div className="acx-r2x" style={{ gap: 10 }}>
              <select required value={swapForm.giveAssetId} onChange={e => setSwapForm({ ...swapForm, giveAssetId: e.target.value })} style={{ padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, background: 'white' }}>
                <option value="">You give (your property)</option>
                {holdings.map((h, i) => <option key={i} value={h.balance.assetId}>{h.propertyTitle} (you own {(h.balance.balance || 0).toLocaleString('en-IN')})</option>)}
              </select>
              <input required type="number" min="1" placeholder="Tokens you give" value={swapForm.giveTokens} onChange={e => setSwapForm({ ...swapForm, giveTokens: e.target.value })} style={{ padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13 }} />
            </div>
            <div className="acx-r2x" style={{ gap: 10 }}>
              <select required value={swapForm.getAssetId} onChange={e => setSwapForm({ ...swapForm, getAssetId: e.target.value })} style={{ padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, background: 'white' }}>
                <option value="">You get (their property)</option>
                {allProps.filter(p2 => p2.status === 'TOKENIZED' && p2.assetId !== swapForm.giveAssetId).map(p2 => <option key={p2.assetId} value={p2.assetId}>{p2.title}</option>)}
              </select>
              <input required type="number" min="1" placeholder="Tokens you get" value={swapForm.getTokens} onChange={e => setSwapForm({ ...swapForm, getTokens: e.target.value })} style={{ padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13 }} />
            </div>
            <div className="acx-r2x" style={{ gap: 10 }}>
              <select value={swapForm.counterparty} onChange={e => setSwapForm({ ...swapForm, counterparty: e.target.value })} style={{ padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, background: 'white' }}>
                {['investor1', 'investor2', 'originator1', 'registrar1'].filter(x => x !== identityId).map(x => <option key={x} value={x}>{x}</option>)}
              </select>
              <button type="submit" style={{ padding: '11px 16px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Swap atomically →</button>
            </div>
          </form>
        </div>

        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Transfer Tokens</h3>
        <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Send tokens to another person</p>

        <form onSubmit={handleTransfer} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          {holdings.length > 0 ? (
            <select
              value={transferForm.assetId}
              onChange={e => setTransferForm({ ...transferForm, assetId: e.target.value })}
              style={{
                padding: '10px 12px',
                border: '1px solid #E5E7EB',
                borderRadius: 8,
                fontSize: 13,
                background: 'white'
              }}
              required
            >
              <option value="">Which property?</option>
              {holdings.map((h, i) => (
                <option key={i} value={h.balance.assetId}>
                  {h.propertyTitle} you own {(h.balance.balance || 0).toLocaleString('en-IN')}
                </option>
              ))}
            </select>
          ) : (
            <input
              placeholder="Which property? Its name, or its ledger reference"
              value={transferForm.assetId}
              onChange={e => setTransferForm({ ...transferForm, assetId: e.target.value })}
              style={{
                padding: '10px 12px',
                border: '1px solid #E5E7EB',
                borderRadius: 8,
                fontSize: 13
              }}
              required
            />
          )}
          <input
            placeholder="Send to (e.g., investor2)"
            value={transferForm.toId}
            onChange={e => setTransferForm({ ...transferForm, toId: e.target.value })}
            style={{
              padding: '10px 12px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 13
            }}
            required
          />
          <input
            type="number"
            placeholder="Amount of tokens"
            value={transferForm.amount}
            onChange={e => setTransferForm({ ...transferForm, amount: e.target.value })}
            style={{
              padding: '10px 12px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 13
            }}
            required
            min="1"
          />
          <button type="submit" style={{
            padding: '12px',
            background: '#1E3A5F',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer'
          }}>
            Transfer Tokens →
          </button>
          {transferMsg && (
            <div style={{
              background: transferMsg.startsWith('✓') ? '#F0FDF4' : '#FEF2F2',
              border: `1px solid ${transferMsg.startsWith('✓') ? '#BBF7D0' : '#FECACA'}`,
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              color: transferMsg.startsWith('✓') ? '#065F46' : '#991B1B',
              lineHeight: 1.5
            }}>
              {transferMsg}
            </div>
          )}
        </form>
      </div>
    </main>
  )
}
