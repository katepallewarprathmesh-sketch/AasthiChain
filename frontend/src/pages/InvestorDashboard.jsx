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
import {
  Button, Badge, Card as AxCard, Metric as AxMetric, Progress, Num, Mono,
  EmptyState, Skeleton, inr, inrShort, InfoTip,
} from '../components/ui.jsx'
import BasketPanel from '../components/BasketPanel.jsx'

const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const card = { background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 18, minWidth: 0 }

const STATUS = {
  SETTLED: { bg: '#ECFDF5', border: '#A7F3D0', color: '#065F46', label: 'Settled' },
  FAILED: { bg: '#FEF2F2', border: '#FECACA', color: '#991B1B', label: 'Failed' },
  CREATED: { bg: '#F1F5F9', border: '#E2E8F0', color: '#475569', label: 'Created' },
  MATCHED: { bg: '#EFF6FF', border: '#BFDBFE', color: '#1D4ED8', label: 'Matched' },
  LOCKED: { bg: '#FFFBEB', border: '#FDE68A', color: '#92400E', label: 'Locked' }
}

function Metric({ label, value, sub, color }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: color || '#111827', marginTop: 5, overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 3 }}>{sub}</div>}
    </div>
  )
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

  // Allocation by property, derived from the holdings already fetched. No
  // new call and no new figure: it is the same valuation, shown as shares.
  const allocation = holdings
    .map((h) => ({
      label: h.propertyTitle || h.balance?.assetId,
      assetId: h.balance?.assetId,
      value: Number(h.valueINR || 0),
      tokens: Number(h.balance?.balance || 0),
    }))
    .filter((a) => a.value > 0)
    .sort((a, b) => b.value - a.value)
  const allocTotal = allocation.reduce((s2, a) => s2 + a.value, 0)
  const pending = settlements.filter((s2) => s2.status !== 'SETTLED' && s2.status !== 'FAILED')

  return (
    <main className="ax ax-wrap" style={{ paddingTop: 26, paddingBottom: 64 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18, flexWrap: 'wrap' }}>
        <div>
          <p className="ax-eyebrow">Investor dashboard</p>
          <h1 className="ax-display ax-h2">{user?.name || identityId}</h1>
          <p className="ax-lede" style={{ fontSize: 15.5 }}>
            Everything you own, what it has paid you, and the ledger blocks behind each figure.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button to="/marketplace" variant="secondary" size="sm">Browse properties</Button>
          <Button size="sm" onClick={load} disabled={loading}>{loading ? 'Refreshing' : 'Refresh'}</Button>
        </div>
      </header>

      {/* Headline numbers. Each says what it is made of: a portfolio total
          with an unstated basis is the easiest number on a page like this to
          read as something it is not. */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14, marginTop: 24 }}>
        <AxMetric
          label="Portfolio value"
          value={loading ? <Skeleton h={26} w="70%" /> : <Num>{inr(portfolio)}</Num>}
          foot={basketValue > 0 ? 'Property and baskets at last valuation, plus simulated cash' : 'Property at last valuation, plus simulated cash'}
          tip="Holdings valued at the token price recorded on each property, plus your wholesale digital rupee balance. It is a valuation, not a price anybody has offered you, and the cash leg is simulated."
        />
        <AxMetric
          label="Property value"
          value={loading ? <Skeleton h={26} w="60%" /> : <Num>{inr(assetsValue)}</Num>}
          foot={<><Num>{tokenCount.toLocaleString('en-IN')}</Num> tokens across <Num>{holdings.length}</Num> {holdings.length === 1 ? 'property' : 'properties'}</>}
        />
        <AxMetric
          label="Digital rupee cash"
          value={railDown ? 'Unavailable' : <Num>{inr(cash)}</Num>}
          foot={railDown ? 'The settlement rail did not answer' : <>{wallet?.walletId || 'wholesale wallet'} · simulated money</>}
        />
        <AxMetric
          label="Income received"
          value={railDown || incomeUnavailable ? 'Unavailable' : <Num>{inr(totalIncome)}</Num>}
          foot={incomeUnavailable
            ? 'Income history needs a newer gateway build'
            : <><Num>{income?.count || 0}</Num> rent or coupon payouts, already credited</>}
          tip="Money actually distributed to you and credited to your wallet. This is realised income, not a projection."
        />
      </section>

      {/* Only claim a total outage when everything really failed. Otherwise
          list precisely what is missing, so the page never says cash is
          unavailable while the cash figure sits right above it. */}
      {railDown ? (
        <AxCard style={{ marginTop: 16, background: 'var(--ax-warning-wash)', borderColor: 'rgba(154,107,22,.3)' }}>
          <Badge tone="warning">Settlement rail unreachable</Badge>
          <p className="ax-body" style={{ marginTop: 10, color: 'var(--ax-ink)' }}>
            Cash, income and settlement history cannot be read right now. Your holdings and their
            valuation above are unaffected, because those come from a different service.
          </p>
        </AxCard>
      ) : railIssues.length > 0 ? (
        <AxCard style={{ marginTop: 16, background: 'var(--ax-warning-wash)', borderColor: 'rgba(154,107,22,.3)' }}>
          <Badge tone="warning">Partly unavailable</Badge>
          <p className="ax-body" style={{ marginTop: 10, color: 'var(--ax-ink)' }}>
            The settlement rail is online. Everything below is live except:
          </p>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {railIssues.map(([what, why]) => (
              <li key={what} className="ax-body" style={{ fontSize: 13.5 }}><strong style={{ color: 'var(--ax-ink)' }}>{what}</strong>: {why}</li>
            ))}
          </ul>
        </AxCard>
      ) : null}

      <div style={{ marginTop: 18 }}>
        <BasketPanel
          holdings={basketHoldings}
          catalogue={basketCatalogue}
          unavailable={basketsUnavailable}
          identityId={identityId}
          onChanged={load}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 18, marginTop: 18, alignItems: 'start' }}>
        {/* ------------------------------------------------------ holdings */}
        <AxCard title="Holdings" sub="Valued at the token price recorded on each property.">
          {loading ? (
            <div style={{ display: 'grid', gap: 10 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={52} />)}</div>
          ) : holdings.length === 0 ? (
            <EmptyState
              title="Nothing held yet"
              body="When you buy tokens in a property, they appear here with their valuation and the blocks that recorded them."
              action={<Button to="/marketplace" size="sm" variant="secondary">Browse properties</Button>}
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="ax-table">
                <caption className="ax-sr">Your property holdings</caption>
                <thead>
                  <tr>
                    <th scope="col">Property</th>
                    <th scope="col" className="ax-num">Tokens</th>
                    <th scope="col" className="ax-num">Price each</th>
                    <th scope="col" className="ax-num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h, i) => (
                    <tr key={i}>
                      <td>
                        {h.balance?.assetId
                          ? <Link to={`/property/${encodeURIComponent(h.balance.assetId)}`} style={{ color: 'var(--ax-ink)', fontWeight: 600 }}>
                              {h.propertyTitle || h.balance.assetId}
                            </Link>
                          : <strong>{h.propertyTitle}</strong>}
                      </td>
                      <td className="ax-num">{Number(h.balance?.balance || 0).toLocaleString('en-IN')}</td>
                      <td className="ax-num">{h.tokenPrice ? inr(h.tokenPrice) : 'Not published'}</td>
                      <td className="ax-num" style={{ fontWeight: 650 }}>{inr(h.valueINR)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AxCard>

        {/* ---------------------------------------------------- allocation */}
        <AxCard title="Allocation by property" sub="Share of your property value, at the same valuation.">
          {allocation.length === 0 ? (
            <p className="ax-body">Nothing to allocate yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              {allocation.map((a) => {
                const pct = allocTotal ? (a.value / allocTotal) * 100 : 0
                return (
                  <div key={a.assetId || a.label}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13.5 }}>
                      <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{a.label}</span>
                      <span className="ax-num" style={{ color: 'var(--ax-muted)' }}>{pct.toFixed(1)}%</span>
                    </div>
                    <div style={{ marginTop: 6 }}><Progress value={pct} label={`${a.label}: ${pct.toFixed(1)} percent`} /></div>
                    <p className="ax-hint" style={{ marginTop: 5 }}>
                      <Num>{inr(a.value)}</Num> · <Num>{a.tokens.toLocaleString('en-IN')}</Num> tokens
                    </p>
                  </div>
                )
              })}
              {allocation.length === 1 && (
                <p className="ax-hint">
                  Everything you hold is in one property. Concentration is a risk the number above cannot show.
                </p>
              )}
            </div>
          )}
        </AxCard>
      </div>

      {/* --------------------------------------------------------- pending */}
      {!railDown && pending.length > 0 && (
        <AxCard
          title="In flight"
          sub="Instructions that have not reached a final state. Nothing here has settled."
          style={{ marginTop: 18 }}
          right={<Badge tone="pending">{pending.length} pending</Badge>}
        >
          <div style={{ display: 'grid', gap: 8 }}>
            {pending.map((s2) => {
              const st = STATUS[s2.status] || STATUS.CREATED
              return (
                <div key={s2.instructionId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', border: '1px solid var(--ax-line)', borderRadius: 10, padding: '10px 13px' }}>
                  <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge tone="pending">{st.label}</Badge>
                    <span style={{ fontSize: 13.5 }}>
                      <Num>{Number(s2.tokens).toLocaleString('en-IN')}</Num> tokens for <Num>{inr(s2.cashINR)}</Num>
                    </span>
                  </span>
                  <Mono>{s2.instructionId}</Mono>
                </div>
              )
            })}
          </div>
        </AxCard>
      )}

      {/* ---------------------------------------------------------- income */}
      {!railDown && (
        <AxCard
          title="Rent and coupon income"
          sub="Paid into your wallet when an issuer runs a servicing payout. Realised, not projected."
          style={{ marginTop: 18 }}
        >
          {!income || income.count === 0 ? (
            <EmptyState
              title="No distributions yet"
              body="When an issuer runs a payout, your share is credited automatically and appears here with the block that recorded it."
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="ax-table">
                <caption className="ax-sr">Income distributions</caption>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Settled</th>
                    <th scope="col" className="ax-num">On tokens</th>
                    <th scope="col">Block</th>
                    <th scope="col" className="ax-num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {income.payouts.map((p2) => (
                    <tr key={p2.servicingId + p2.holder}>
                      <td style={{ overflowWrap: 'anywhere' }}>{p2.assetId}{p2.isin ? <><br /><span className="ax-hint">ISIN {p2.isin}</span></> : null}</td>
                      <td className="ax-hint" style={{ whiteSpace: 'nowrap' }}>{new Date(p2.settledAt).toLocaleString('en-IN')}</td>
                      <td className="ax-num">{Number(p2.tokens).toLocaleString('en-IN')}</td>
                      <td>{p2.blockHeight ? <Mono>#{p2.blockHeight}</Mono> : <span className="ax-hint">not recorded</span>}</td>
                      <td className="ax-num" style={{ fontWeight: 650, color: 'var(--ax-success)' }}>+{inr(p2.amountINR)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AxCard>
      )}

      {/* ----------------------------------------------------- settlements */}
      {!railDown && (
        <AxCard
          title="Settlement history"
          sub="Every one moved tokens and cash together, or neither."
          style={{ marginTop: 18 }}
          right={<Button to="/ledger" variant="secondary" size="sm">Open the ledger</Button>}
        >
          {settlements.length === 0 ? (
            <EmptyState
              title="No settlements yet"
              body="A purchase settles tokens against cash in one operation. When that happens, it is listed here with its block."
              action={<Button to="/umi" size="sm" variant="secondary">Open the settlement rail</Button>}
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="ax-table">
                <caption className="ax-sr">Recent settlement instructions</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Side</th>
                    <th scope="col" className="ax-num">Tokens</th>
                    <th scope="col" className="ax-num">Cash</th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {settlements.slice(0, 12).map((s2) => {
                    const st = STATUS[s2.status] || STATUS.CREATED
                    const tone = s2.status === 'SETTLED' ? 'success' : s2.status === 'FAILED' ? 'error' : 'pending'
                    return (
                      <tr key={s2.instructionId}>
                        <td><Badge tone={tone}>{st.label}</Badge></td>
                        <td>{s2.buyer === identityId ? 'Bought' : 'Sold'}</td>
                        <td className="ax-num">{Number(s2.tokens).toLocaleString('en-IN')}</td>
                        <td className="ax-num">{inr(s2.cashINR)}</td>
                        <td>
                          {s2.status === 'SETTLED' && s2.blockHeight
                            ? <Mono>block #{s2.blockHeight}</Mono>
                            : <span className="ax-hint">{s2.failureReason || 'not settled'}</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="ax-hint" style={{ marginTop: 12 }}>
            <Num>{settled.length}</Num> settled. The cash leg of each one is simulated wholesale digital
            rupee, not a bank transfer.
          </p>
        </AxCard>
      )}
    </main>
  )
}
