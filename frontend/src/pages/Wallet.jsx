import React, { useState, useEffect } from 'react'
import { money } from '../lib/format.js'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import UMIPortfolioPanel from '../components/UMIPortfolioPanel.jsx'
import TransactionHistory from '../components/TransactionHistory.jsx'
import { useLocalCache } from '../hooks/useLocalCache.js'
import {
  Alert, Button, Card, CardContent, CardHeader, CardDescription, CardTitle,
  Input, Select, Skeleton, Stat,
} from '../components/ui/index.jsx'

// SOLID: Single Responsibility Only wallet display + transfer for layman

function SimpleHoldingCard({ holding }) {
  const balance = holding.balance
  const propertyTitle = holding.propertyTitle || balance.assetId?.slice(0, 16) || 'Property'
  const tokenPrice = holding.tokenPrice || 500
  const value = holding.valueINR || (balance.balance * tokenPrice)

  return (
    <Card className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0 flex-[1_1_180px]">
        <div className="text-[14px] font-bold break-words text-foreground">{propertyTitle}</div>
        <div className="mt-1 text-[12px] text-muted-foreground">
          {(balance.balance || 0).toLocaleString('en-IN')} tokens • ₹{tokenPrice.toLocaleString('en-IN')} each
        </div>
        {holding.fromDevice && (
          <div className="mt-0.5 text-[10px] text-[#92400E]">syncing to cloud…</div>
        )}
      </div>
      <div className="ml-auto min-w-[120px] text-right">
        <div className="text-[18px] font-extrabold break-words text-foreground">{money(value)}</div>
        <div className="text-[11px] text-muted-foreground">Value</div>
        <Link to={`/property/${balance.assetId}`}
          className="mt-1 inline-block text-[11px] font-semibold text-primary no-underline">
          View →
        </Link>
      </div>
    </Card>
  )
}

// Layman-friendly transfer error messages (Open/Closed: add new codes to the map)
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
    <div className="pg pg-narrow ui" style={{ minWidth: 0 }}>
      <h1 className="pg-title">My Wallet</h1>
      <p className="mt-1.5 text-[14px] text-muted-foreground">
        Your property tokens and portfolio value
      </p>

      <Card className="mt-5 flex min-w-0 flex-wrap items-center justify-between gap-2.5 p-5">
        <div className="min-w-0 flex-[1_1_220px]">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Total portfolio value
          </div>
          <div className="mt-1.5 font-display text-[32px] leading-none font-semibold break-words text-foreground">
            {money(totalValue)}
          </div>
          <div className="mt-1.5 text-[12px] text-muted-foreground">{holdings.length} properties owned</div>
        </div>
        <Button variant="outline" onClick={fetchWallet}>Refresh</Button>
      </Card>

      {error && <Alert variant="destructive" className="mt-3">{error}</Alert>}

      <div className="mt-6">
        <h3 className="text-[16px] font-bold text-foreground">My properties</h3>

        {loading ? (
          <div className="mt-3 flex flex-col gap-3">
            <Skeleton className="h-[84px] w-full" />
            <Skeleton className="h-[84px] w-full" />
          </div>
        ) : holdings.length === 0 ? (
          <Card className="mt-3 px-5 py-10 text-center">
            <div className="text-[32px]">🏠</div>
            <p className="mt-3 text-[16px] font-semibold text-foreground">No properties yet</p>
            <p className="mx-auto mt-1.5 max-w-[40ch] text-[13px] text-muted-foreground">
              Start investing from ₹500. Browse properties and buy tokens via UPI.
            </p>
            <Link to="/marketplace" className="mt-4 inline-block no-underline">
              <Button asChild size="lg">Explore Properties →</Button>
            </Link>
          </Card>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {holdings.map((h, i) => <SimpleHoldingCard key={i} holding={h} />)}
          </div>
        )}
      </div>

      <UMIPortfolioPanel identityId={identityId} />

      <TransactionHistory
        identityId={identityId}
        titleFor={(assetId) => (allProps.find(p => p.assetId === assetId) || {}).title}
        priceFor={(assetId) => {
          const p = allProps.find(p => p.assetId === assetId) || {}
          return p.pricePerTokenINR || p.tokenPrice || 0
        }}
      />

      {nav && (
        <Card className="mt-6">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-[1_1_220px]">
              <CardTitle>Portfolio NAV</CardTitle>
              <CardDescription>Continuous net asset value, marked to last trade price</CardDescription>
            </div>
            <div className="font-display text-[26px] font-semibold break-words text-primary">{money(nav.navINR)}</div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))]">
              {[
                ['Assets', money(nav.assetsValueINR), 'default'],
                ['Yield earned', '+' + money(nav.yieldEarnedINR), 'success'],
                ['Loan due', '-' + money(nav.outstandingDebtINR), 'destructive'],
                ['Active loans', String(nav.activeLoans), 'default'],
              ].map(([k, v, tone]) => <Stat key={k} label={k} value={v} tone={tone} className="shadow-none" />)}
            </div>
          </CardContent>
        </Card>
      )}

      {loans.filter(l => l.status === 'ACTIVE').length > 0 && (
        <Card className="mt-4">
          <CardHeader><CardTitle>Credit against your tokens</CardTitle></CardHeader>
          <CardContent>
            {repayMsg && <Alert variant="success" className="mb-2.5">{repayMsg}</Alert>}
            <div className="flex flex-col gap-2.5">
              {loans.filter(l => l.status === 'ACTIVE').map(l => (
                <div key={l.loanId}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2.5 rounded-md border border-border bg-muted/50 p-3">
                  <div className="min-w-0 flex-[1_1_220px]">
                    <div className="text-[13px] font-bold break-words text-foreground">
                      {money(l.principalINR)} borrowed · {l.tokens} tokens pledged
                    </div>
                    <div className="mt-0.5 text-[11px] break-words text-muted-foreground">
                      Repay {money(Math.round(l.principalINR * 1.01 * 100) / 100)} (1% fee) to unlock · {l.loanId}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => handleRepay(l.loanId)}>Repay now</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Multi-property swap</CardTitle>
          <CardDescription>
            Exchange tokens across two properties in one atomic transaction. Either both legs move, or neither.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {swapMsg && <Alert variant="success" className="mb-2.5 break-all">{swapMsg}</Alert>}
          {swapErr && <Alert variant="destructive" className="mb-2.5">{swapErr}</Alert>}
          <form onSubmit={handleSwap} className="flex flex-col gap-2.5">
            <div className="acx-r2x" style={{ gap: 10 }}>
              <Select required value={swapForm.giveAssetId} onChange={e => setSwapForm({ ...swapForm, giveAssetId: e.target.value })}>
                <option value="">You give (your property)</option>
                {holdings.map((h, i) => (
                  <option key={i} value={h.balance.assetId}>
                    {h.propertyTitle} (you own {(h.balance.balance || 0).toLocaleString('en-IN')})
                  </option>
                ))}
              </Select>
              <Input required type="number" min="1" placeholder="Tokens you give"
                value={swapForm.giveTokens} onChange={e => setSwapForm({ ...swapForm, giveTokens: e.target.value })} />
            </div>
            <div className="acx-r2x" style={{ gap: 10 }}>
              <Select required value={swapForm.getAssetId} onChange={e => setSwapForm({ ...swapForm, getAssetId: e.target.value })}>
                <option value="">You get (their property)</option>
                {allProps.filter(p2 => p2.status === 'TOKENIZED' && p2.assetId !== swapForm.giveAssetId)
                  .map(p2 => <option key={p2.assetId} value={p2.assetId}>{p2.title}</option>)}
              </Select>
              <Input required type="number" min="1" placeholder="Tokens you get"
                value={swapForm.getTokens} onChange={e => setSwapForm({ ...swapForm, getTokens: e.target.value })} />
            </div>
            <div className="acx-r2x" style={{ gap: 10 }}>
              <Select value={swapForm.counterparty} onChange={e => setSwapForm({ ...swapForm, counterparty: e.target.value })}>
                {['investor1', 'investor2', 'originator1', 'registrar1'].filter(x => x !== identityId)
                  .map(x => <option key={x} value={x}>{x}</option>)}
              </Select>
              <Button type="submit">Swap atomically →</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Transfer tokens</CardTitle>
          <CardDescription>Send tokens to another person</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleTransfer} className="flex flex-col gap-3">
            {holdings.length > 0 ? (
              <Select required value={transferForm.assetId}
                onChange={e => setTransferForm({ ...transferForm, assetId: e.target.value })}>
                <option value="">Which property?</option>
                {holdings.map((h, i) => (
                  <option key={i} value={h.balance.assetId}>
                    {h.propertyTitle} you own {(h.balance.balance || 0).toLocaleString('en-IN')}
                  </option>
                ))}
              </Select>
            ) : (
              <Input required placeholder="Property ID (e.g., PROP-GREEN-VALLEY-PUNE-001)"
                value={transferForm.assetId}
                onChange={e => setTransferForm({ ...transferForm, assetId: e.target.value })} />
            )}
            <Input required placeholder="Send to (e.g., investor2)" value={transferForm.toId}
              onChange={e => setTransferForm({ ...transferForm, toId: e.target.value })} />
            <Input required type="number" min="1" placeholder="Amount of tokens" value={transferForm.amount}
              onChange={e => setTransferForm({ ...transferForm, amount: e.target.value })} />
            <Button type="submit" size="lg">Transfer tokens →</Button>
            {transferMsg && (
              <Alert variant={transferMsg.startsWith('✓') ? 'success' : 'destructive'}>{transferMsg}</Alert>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
