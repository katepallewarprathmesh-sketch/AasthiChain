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
    const [wRes, insRes, incRes] = await Promise.allSettled([
      api.umiWallets(), api.umiInstructions(), api.umiIncome(identityId)
    ])

    const ok = (r) => r.status === 'fulfilled' && r.value && !r.value.error

    if (ok(wRes)) setWallet((wRes.value.wallets || []).find(x => x.participant === identityId) || null)
    else setWallet(null)

    if (ok(insRes)) setSettlements((insRes.value.instructions || [])
      .filter(i => i.buyer === identityId || i.seller === identityId).reverse())
    else setSettlements([])

    setIncome(ok(incRes) ? incRes.value : null)

    // Only a total loss of the rail counts as "not reachable". If any call
    // succeeded the rail is up and the specific gap is reported in place.
    setRailDown(!ok(wRes) && !ok(insRes) && !ok(incRes))
    setIncomeUnavailable(ok(wRes) && !ok(incRes))
    setLoading(false)
  }, [identityId])

  useEffect(() => { load() }, [load])

  const tokenCount = holdings.reduce((s, h) => s + Number(h.balance?.balance || 0), 0)
  const assetsValue = nav?.assetsValueINR ?? holdings.reduce((s, h) => s + Number(h.valueINR || 0), 0)
  const settled = settlements.filter(s => s.status === 'SETTLED')
  const cash = wallet?.balanceINR ?? 0
  const totalIncome = income?.totalIncomeINR ?? 0
  const portfolio = assetsValue + cash

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '24px 16px 60px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em', color: '#9CA3AF', textTransform: 'uppercase' }}>
            Investor dashboard
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: '#111827', margin: '6px 0 4px' }}>
            {user?.name || identityId}
          </h1>
          <p style={{ fontSize: 13, color: '#6B7280', maxWidth: '62ch', lineHeight: 1.6 }}>
            Everything you own, what it has paid you, and the ledger blocks that prove it.
          </p>
        </div>
        <button onClick={load} disabled={loading} style={{
          padding: '9px 14px', background: '#1E3A5F', color: 'white', border: 'none',
          borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1
        }}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>

      {/* Headline numbers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginTop: 18 }}>
        <Metric label="Portfolio value" value={money(portfolio)} sub="property + e₹-W cash" color="#1E3A5F" />
        <Metric label="Property value" value={money(assetsValue)} sub={`${tokenCount.toLocaleString('en-IN')} tokens · ${holdings.length} ${holdings.length === 1 ? 'property' : 'properties'}`} />
        <Metric label="e₹-W cash" value={railDown ? '—' : money(cash)} sub={wallet?.walletId || 'wholesale CBDC wallet'} color="#6D28D9" />
        <Metric
          label="Income received"
          value={railDown || incomeUnavailable ? '—' : money(totalIncome)}
          sub={incomeUnavailable
            ? 'Income history needs a newer gateway build'
            : `${income?.count || 0} rent / coupon payouts`}
          color="#065F46" />
      </div>

      {railDown && (
        <div style={{ ...card, marginTop: 14, background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E', fontSize: 12.5, lineHeight: 1.6 }}>
          The UMI settlement rail is not reachable, so cash, income and settlement history are unavailable.
          Your holdings and valuation above are unaffected.
        </div>
      )}

      {/* Holdings */}
      <div style={{ ...card, marginTop: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Holdings</h2>
        {holdings.length === 0 ? (
          <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8, lineHeight: 1.6 }}>
            Nothing yet. <Link to="/marketplace" style={{ color: '#1E3A5F', fontWeight: 600 }}>Browse properties →</Link>
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {holdings.map((h, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
                border: '1px solid #F3F4F6', borderRadius: 9, padding: '10px 12px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', overflowWrap: 'anywhere' }}>
                    {h.propertyTitle || h.balance?.assetId}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 2 }}>
                    {Number(h.balance?.balance || 0).toLocaleString('en-IN')} tokens
                    {h.tokenPrice ? ` · ${money(h.tokenPrice)} each` : ''}
                  </div>
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#1E3A5F' }}>{money(h.valueINR)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Income */}
      {!railDown && (
        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Rent &amp; coupon income</h2>
            <span style={{ fontSize: 11.5, color: '#6B7280' }}>paid straight into your e₹-W wallet by smart contract</span>
          </div>
          {!income || income.count === 0 ? (
            <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8, lineHeight: 1.6 }}>
              No distributions yet. When an issuer runs a servicing payout, your share is credited automatically
              and appears here with the block that recorded it.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
              {income.payouts.map(p => (
                <div key={p.servicingId + p.holder} style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                  flexWrap: 'wrap', alignItems: 'center', border: '1px solid #F3F4F6', borderRadius: 9, padding: '9px 12px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: '#111827', fontWeight: 600, overflowWrap: 'anywhere' }}>
                      {p.assetId}{p.isin ? ` · ISIN ${p.isin}` : ''}
                    </div>
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                      {new Date(p.settledAt).toLocaleString('en-IN')} · on {Number(p.tokens).toLocaleString('en-IN')} tokens
                      {p.blockHeight ? ` · block #${p.blockHeight}` : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: '#065F46' }}>+{money(p.amountINR)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Settlements */}
      {!railDown && (
        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Settlement history</h2>
            <Link to="/ledger" style={{ fontSize: 11.5, color: '#1E3A5F', fontWeight: 600, textDecoration: 'none' }}>
              Open the ledger →
            </Link>
          </div>
          {settlements.length === 0 ? (
            <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8, lineHeight: 1.6 }}>
              No settlements yet. Run one on the <Link to="/umi" style={{ color: '#1E3A5F', fontWeight: 600 }}>UMI page</Link>.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
              {settlements.slice(0, 12).map(s => {
                const st = STATUS[s.status] || STATUS.CREATED
                const side = s.buyer === identityId ? 'Bought' : 'Sold'
                return (
                  <div key={s.instructionId} style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                    flexWrap: 'wrap', alignItems: 'center', border: '1px solid #F3F4F6', borderRadius: 9, padding: '9px 12px' }}>
                    <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
                        color: st.color, background: st.bg, border: `1px solid ${st.border}` }}>{st.label}</span>
                      <span style={{ fontSize: 12.5, color: '#111827' }}>
                        <b>{side}</b> {Number(s.tokens).toLocaleString('en-IN')} tokens for <b>{money(s.cashINR)}</b>
                      </span>
                    </div>
                    <span style={{ fontSize: 11, color: '#9CA3AF', fontFamily: 'monospace' }}>
                      {s.status === 'SETTLED' && s.blockHeight ? `block #${s.blockHeight}` : s.failureReason || ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 10, lineHeight: 1.6 }}>
            {settled.length} settled · every one moved tokens and cash together, or neither.
          </div>
        </div>
      )}
    </div>
  )
}
