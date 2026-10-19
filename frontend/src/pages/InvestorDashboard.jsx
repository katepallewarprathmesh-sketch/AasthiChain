// Investor Dashboard — one place that answers the four questions an investor
// actually has: what do I own, what is it worth, what has it paid me, and can
// I prove any of it.
//
// It composes endpoints that already exist (holdings, NAV, UMI wallet,
// settlements) plus the new per-investor income endpoint. No business logic
// lives here: every number is computed server-side, and anything the rail
// cannot answer degrades to a quiet notice rather than a broken page.

import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import BasketPanel from '../components/BasketPanel.jsx'
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Separator, Stat,
} from '../components/ui/index.jsx'

const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })

// Status to badge tone. The wording is unchanged; only the chrome is.
const STATUS = {
  SETTLED: { variant: 'success', label: 'Settled' },
  FAILED: { variant: 'destructive', label: 'Failed' },
  CREATED: { variant: 'outline', label: 'Created' },
  MATCHED: { variant: 'secondary', label: 'Matched' },
  LOCKED: { variant: 'warning', label: 'Locked' },
}

export default function InvestorDashboard({ user }) {
  const identityId = user?.identityId || 'investor1'

  const [holdings, setHoldings] = useState([])
  const [nav, setNav] = useState(null)
  const [wallet, setWallet] = useState(null)
  const [settlements, setSettlements] = useState([])
  const [income, setIncome] = useState(null)
  const [railDown, setRailDown] = useState(false)
  const [incomeUnavailable, setIncomeUnavailable] = useState(false)
  const [railIssues, setRailIssues] = useState([])
  const [basketHoldings, setBasketHoldings] = useState([])
  const [basketCatalogue, setBasketCatalogue] = useState([])
  const [basketsUnavailable, setBasketsUnavailable] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    // core portfolio — these are the app's own endpoints
    try {
      const d = await api.getWallet(identityId)
      setHoldings(d.balances || [])
    } catch { /* leave empty; the panels below say so */ }
    try { setNav(await api.portfolioNav(identityId)) } catch { /* optional */ }

    // settlement rail — may be unconfigured or asleep; never fatal
    // allSettled, deliberately: these three are independent. A gateway running
    // an older build can 404 one endpoint (income, say) while wallets and
    // instructions answer perfectly well. Promise.all used to reject the whole
    // batch and declare the rail unreachable, blanking two working panels
    // because of one missing route.
    const [wRes, insRes, incRes, bhRes, bcRes] = await Promise.allSettled([
      api.umiWallets(), api.umiInstructions(), api.umiIncome(identityId),
      api.umiBasketHoldings(identityId), api.umiBaskets()
    ])

    const ok = (r) => r.status === 'fulfilled' && r.value && !r.value.error

    if (ok(wRes)) setWallet((wRes.value.wallets || []).find(x => x.participant === identityId) || null)
    else setWallet(null)

    if (ok(insRes)) setSettlements((insRes.value.instructions || [])
      .filter(i => i.buyer === identityId || i.seller === identityId).reverse())
    else setSettlements([])

    setIncome(ok(incRes) ? incRes.value : null)

    // Baskets are their own panel: a gateway too old to serve them must not
    // disturb anything else on the page.
    setBasketHoldings(ok(bhRes) ? (bhRes.value.baskets || []) : [])
    setBasketCatalogue(ok(bcRes) ? (bcRes.value.baskets || []) : [])
    setBasketsUnavailable(!ok(bhRes) && !ok(bcRes))

    // Only a total loss of the rail counts as "not reachable". If any call
    // succeeded the rail is up and the specific gap is reported in place.
    setRailDown(!ok(wRes) && !ok(insRes) && !ok(incRes))
    setIncomeUnavailable(ok(wRes) && !ok(incRes))

    // Name exactly what failed so the page never makes a blanket claim.
    const reasonOf = (r) => {
      if (r.status === 'fulfilled') return (r.value && r.value.error) ? (r.value.message || r.value.error) : null
      const m = (r.reason && r.reason.message) || String(r.reason || 'request failed')
      return /does not serve|ROUTE_UNKNOWN|404/i.test(m)
        ? 'this gateway build does not have that endpoint yet'
        : m
    }
    setRailIssues([
      ['Cash balance', reasonOf(wRes)],
      ['Settlement history', reasonOf(insRes)],
      ['Income history', reasonOf(incRes)],
    ].filter(([, why]) => why))
    setLoading(false)
  }, [identityId])

  useEffect(() => { load() }, [load])

  const tokenCount = holdings.reduce((s, h) => s + Number(h.balance?.balance || 0), 0)
  const assetsValue = nav?.assetsValueINR ?? holdings.reduce((s, h) => s + Number(h.valueINR || 0), 0)
  const settled = settlements.filter(s => s.status === 'SETTLED')
  const cash = wallet?.balanceINR ?? 0
  const totalIncome = income?.totalIncomeINR ?? 0
  // Backing tokens left the holder's own balances for custody, so basket
  // value is missing from assetsValue rather than duplicated in it.
  const basketValue = basketHoldings.reduce((s2, b) => s2 + Number(b.valueINR || 0), 0)
  const portfolio = assetsValue + cash + basketValue

  return (
    <div className="pg ui">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Investor dashboard
          </div>
          <h1 className="pg-title">{user?.name || identityId}</h1>
          <p className="max-w-[62ch] text-[13px] leading-relaxed text-muted-foreground">
            Everything you own, what it has paid you, and the ledger blocks that prove it.
          </p>
        </div>
        <Button onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
      </div>

      {/* Headline numbers */}
      <div className="mt-[18px] grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <Stat label="Portfolio value" value={money(portfolio)}
          hint={basketValue > 0 ? 'property + baskets + e₹-W cash' : 'property + e₹-W cash'} />
        <Stat label="Property value" value={money(assetsValue)}
          hint={`${tokenCount.toLocaleString('en-IN')} tokens · ${holdings.length} ${holdings.length === 1 ? 'property' : 'properties'}`} />
        <Stat label="e₹-W cash" value={railDown ? '—' : money(cash)} hint={wallet?.walletId || 'wholesale CBDC wallet'} />
        <Stat
          label="Income received"
          tone="success"
          value={railDown || incomeUnavailable ? '—' : money(totalIncome)}
          hint={incomeUnavailable
            ? 'Income history needs a newer gateway build'
            : `${income?.count || 0} rent / coupon payouts`} />
      </div>

      {/* Only claim a total outage when everything really failed. Otherwise
          list precisely what is missing, so the page never tells the user that
          cash is unavailable while the cash figure is sitting right above. */}
      {railDown ? (
        <Alert variant="warning" className="mt-3.5">
          The UMI settlement rail is not reachable, so cash, income and settlement history are unavailable.
          Your holdings and valuation above are unaffected.
        </Alert>
      ) : railIssues.length > 0 ? (
        <Alert variant="warning" className="mt-3.5">
          <strong>The settlement rail is online.</strong> Everything below is live except:
          <ul className="mt-1.5 list-disc pl-[18px]">
            {railIssues.map(([what, why]) => <li key={what}>{what}: {why}</li>)}
          </ul>
        </Alert>
      ) : null}

      <BasketPanel
        holdings={basketHoldings}
        catalogue={basketCatalogue}
        unavailable={basketsUnavailable}
        identityId={identityId}
        onChanged={load}
      />

      {/* Holdings */}
      <Card className="mt-4">
        <CardHeader><CardTitle>Holdings</CardTitle></CardHeader>
        <CardContent>
          {holdings.length === 0 ? (
            <p className="text-muted-foreground">
              Nothing yet. <Link to="/marketplace" className="font-semibold text-primary">Browse properties →</Link>
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {holdings.map((h, i) => (
                <div key={i}
                  className="flex flex-wrap items-center justify-between gap-2.5 rounded-md border border-border px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold break-words text-foreground">
                      {h.propertyTitle || h.balance?.assetId}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                      {Number(h.balance?.balance || 0).toLocaleString('en-IN')} tokens
                      {h.tokenPrice ? ` · ${money(h.tokenPrice)} each` : ''}
                    </div>
                  </div>
                  <div className="text-[15px] font-extrabold text-primary">{money(h.valueINR)}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Income */}
      {!railDown && (
        <Card className="mt-4">
          <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-2.5">
            <CardTitle>Rent &amp; coupon income</CardTitle>
            <span className="text-[11.5px] text-muted-foreground">
              paid straight into your e₹-W wallet by smart contract
            </span>
          </CardHeader>
          <CardContent>
            {!income || income.count === 0 ? (
              <p className="text-muted-foreground">
                No distributions yet. When an issuer runs a servicing payout, your share is credited automatically
                and appears here with the block that recorded it.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {income.payouts.map(p => (
                  <div key={p.servicingId + p.holder}
                    className="flex flex-wrap items-center justify-between gap-2.5 rounded-md border border-border px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-semibold break-words text-foreground">
                        {p.assetId}{p.isin ? ` · ISIN ${p.isin}` : ''}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {new Date(p.settledAt).toLocaleString('en-IN')} · on {Number(p.tokens).toLocaleString('en-IN')} tokens
                        {p.blockHeight ? ` · block #${p.blockHeight}` : ''}
                      </div>
                    </div>
                    <div className="text-[14px] font-extrabold text-[#065F46]">+{money(p.amountINR)}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Settlements */}
      {!railDown && (
        <Card className="mt-4">
          <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-2.5">
            <CardTitle>Settlement history</CardTitle>
            <Link to="/ledger" className="text-[11.5px] font-semibold text-primary no-underline">
              Open the ledger →
            </Link>
          </CardHeader>
          <CardContent>
            {settlements.length === 0 ? (
              <p className="text-muted-foreground">
                No settlements yet. Run one on the <Link to="/umi" className="font-semibold text-primary">UMI page</Link>.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {settlements.slice(0, 12).map(s => {
                  const st = STATUS[s.status] || STATUS.CREATED
                  const side = s.buyer === identityId ? 'Bought' : 'Sold'
                  return (
                    <div key={s.instructionId}
                      className="flex flex-wrap items-center justify-between gap-2.5 rounded-md border border-border px-3 py-2.5">
                      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                        <Badge variant={st.variant}>{st.label}</Badge>
                        <span className="text-[12.5px] text-foreground">
                          <b>{side}</b> {Number(s.tokens).toLocaleString('en-IN')} tokens for <b>{money(s.cashINR)}</b>
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {s.status === 'SETTLED' && s.blockHeight ? `block #${s.blockHeight}` : s.failureReason || ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
            <Separator className="my-3" />
            <div className="text-[11px] leading-relaxed text-muted-foreground">
              {settled.length} settled · every one moved tokens and cash together, or neither.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
