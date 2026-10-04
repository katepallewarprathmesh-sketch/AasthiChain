// Free public tool: fractional property investment calculator.
// Ranks for "fractional ownership returns calculator", "fractional real
// estate investment india". Client-side only, no login.

import React, { useState, useMemo } from 'react'
import ToolShell, { card, C, Field, inr, pct } from './ToolShell'

const num = (v) => {
  const n = parseFloat(v)
  return isFinite(n) && n >= 0 ? n : 0
}

export default function FractionalCalculator() {
  const [amount, setAmount] = useState('50000')
  const [tokenPrice, setTokenPrice] = useState('500')
  const [propertyValue, setPropertyValue] = useState('7500000')
  const [yieldPct, setYieldPct] = useState('3.5')
  const [growthPct, setGrowthPct] = useState('6')
  const [years, setYears] = useState('5')
  const [feePct, setFeePct] = useState('1')
  const [reinvest, setReinvest] = useState(false)

  const r = useMemo(() => {
    const invest = num(amount)
    const tp = num(tokenPrice)
    const pv = num(propertyValue)
    const y = num(yieldPct) / 100
    const g = num(growthPct) / 100
    const n = Math.max(0, Math.min(num(years), 50))
    const fee = num(feePct) / 100

    const tokens = tp > 0 ? Math.floor(invest / tp) : 0
    const deployed = tokens * tp // whole tokens only; the remainder stays uninvested
    const uninvested = invest - deployed
    const share = pv > 0 ? deployed / pv : 0

    // Year-one income, net of the platform fee.
    const grossIncomeY1 = deployed * y
    const netIncomeY1 = grossIncomeY1 * (1 - fee)

    // Walk year by year. Rental income scales with the property's value, so it
    // grows as the property appreciates. Reinvesting compounds the holding;
    // otherwise income is taken as cash and simply accumulates.
    let value = deployed
    let cashOut = 0
    const rows = []
    for (let i = 1; i <= Math.floor(n); i++) {
      value *= 1 + g
      const income = value * y * (1 - fee)
      if (reinvest) value += income
      else cashOut += income
      rows.push({ year: i, value, income, cashOut })
    }

    const finalValue = value
    const totalReturn = finalValue + cashOut + uninvested - invest
    const totalPct = invest > 0 ? (totalReturn / invest) * 100 : 0
    // CAGR on the full ending position versus the full amount committed.
    const ending = finalValue + cashOut + uninvested
    const cagr = invest > 0 && n > 0 ? (Math.pow(ending / invest, 1 / n) - 1) * 100 : 0

    return { tokens, deployed, uninvested, share, netIncomeY1, monthlyY1: netIncomeY1 / 12, rows, finalValue, cashOut, totalReturn, totalPct, cagr, ending }
  }, [amount, tokenPrice, propertyValue, yieldPct, growthPct, years, feePct, reinvest])

  return (
    <ToolShell
      title="Fractional Investment Calculator"
      tagline="Estimate what a part-share of a property returns: how many tokens your money buys, the ownership percentage it represents, the rental income it earns, and what it could be worth after several years."
      faq={FAQ}
      related={RELATED}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 20, alignItems: 'start' }}>
        <div style={card}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 16 }}>Your investment</h2>
          <Field label="Amount to invest" prefix="₹" value={amount} onChange={setAmount} />
          <Field label="Price per token" prefix="₹" value={tokenPrice} onChange={setTokenPrice} hint="The smallest unit of ownership you can buy." />
          <Field label="Total property value" prefix="₹" value={propertyValue} onChange={setPropertyValue} />

          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, margin: '22px 0 16px' }}>Assumptions</h2>
          <Field label="Net rental yield" suffix="%" value={yieldPct} onChange={setYieldPct} hint="Annual rental income after costs, as a share of value. Use the rental yield calculator to work this out." />
          <Field label="Annual price appreciation" suffix="%" value={growthPct} onChange={setGrowthPct} />
          <Field label="Platform fee on income" suffix="%" value={feePct} onChange={setFeePct} />
          <Field label="Holding period" suffix="years" value={years} onChange={setYears} min={0} step={1} />

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={reinvest} onChange={(e) => setReinvest(e.target.checked)} style={{ marginTop: 3 }} />
            <span style={{ fontSize: 13.5, color: C.body, lineHeight: 1.55 }}>
              Reinvest rental income instead of taking it as cash
            </span>
          </label>
        </div>

        <div>
          <div style={{ ...card, background: C.navy, color: 'white', border: 'none' }}>
            <div style={{ fontSize: 12.5, opacity: 0.75, marginBottom: 4 }}>
              Value after {Math.floor(num(years))} {Math.floor(num(years)) === 1 ? 'year' : 'years'}
            </div>
            <div style={{ fontSize: 42, fontWeight: 700, fontFamily: "'Fraunces',Georgia,serif", letterSpacing: '-0.03em', lineHeight: 1.05 }}>
              {inr(r.ending)}
            </div>
            <div style={{ fontSize: 13.5, opacity: 0.85, marginTop: 6 }}>
              {r.totalReturn >= 0 ? 'Gain' : 'Loss'} of {inr(Math.abs(r.totalReturn))} · {pct(r.totalPct)} total · {pct(r.cagr)} a year
            </div>

            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,.18)', display: 'grid', gap: 11, fontSize: 13.5 }}>
              <Row label="Tokens purchased" value={r.tokens.toLocaleString('en-IN')} />
              <Row label="Ownership share" value={pct(r.share * 100, 4)} />
              <Row label="Capital deployed" value={inr(r.deployed)} />
              {r.uninvested > 0 && <Row label="Left over (part token)" value={inr(r.uninvested)} />}
              <Row label="Year-1 rental income" value={inr(r.netIncomeY1)} />
              <Row label="Year-1 monthly income" value={inr(r.monthlyY1)} />
              <Row label={reinvest ? 'Income reinvested' : 'Rental income taken as cash'} value={reinvest ? '—' : inr(r.cashOut)} />
              <Row label="Holding value at exit" value={inr(r.finalValue)} strong />
            </div>
          </div>

          {r.rows.length > 0 && (
            <div style={{ ...card, marginTop: 20, padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <caption style={{ textAlign: 'left', padding: '14px 16px 10px', fontWeight: 700, color: C.ink, fontSize: 15 }}>
                  Year by year
                </caption>
                <thead>
                  <tr style={{ background: C.soft, textAlign: 'right' }}>
                    <th style={{ padding: '8px 16px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>Year</th>
                    <th style={{ padding: '8px 16px', color: C.muted, fontWeight: 600 }}>Holding value</th>
                    <th style={{ padding: '8px 16px', color: C.muted, fontWeight: 600 }}>Income</th>
                  </tr>
                </thead>
                <tbody>
                  {r.rows.slice(0, 15).map((row) => (
                    <tr key={row.year} style={{ borderTop: `1px solid ${C.line}`, textAlign: 'right' }}>
                      <td style={{ padding: '8px 16px', textAlign: 'left', color: C.body }}>{row.year}</td>
                      <td style={{ padding: '8px 16px', color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{inr(row.value)}</td>
                      <td style={{ padding: '8px 16px', color: C.good, fontVariantNumeric: 'tabular-nums' }}>{inr(row.income)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 22, fontFamily: "'Fraunces',Georgia,serif", color: C.ink, marginBottom: 12 }}>
          How fractional property returns work
        </h2>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '66ch' }}>
          Fractional ownership splits a property into units, so instead of needing the
          whole ₹75 lakh you can hold a slice of it. Your return comes from two separate
          places, and it helps to keep them separate:
        </p>
        <ul style={{ fontSize: 15, color: C.body, lineHeight: 1.85, maxWidth: '66ch', paddingLeft: 20, marginTop: 10 }}>
          <li><strong>Rental income</strong> — paid out in proportion to your share, usually monthly or quarterly, minus a platform fee.</li>
          <li><strong>Capital appreciation</strong> — unrealised until the property is sold or you sell your units to someone else.</li>
        </ul>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '66ch', marginTop: 12 }}>
          The calculator assumes rental income grows with the property's value, applies the
          platform fee to income, and only buys whole tokens — any remainder is shown as
          left over rather than quietly rolled into the result. Appreciation is the
          assumption to be most careful with: a figure you choose, not a figure anyone can
          promise.
        </p>
      </section>
    </ToolShell>
  )
}

function Row({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontWeight: strong ? 700 : 400 }}>
      <span style={{ opacity: strong ? 0.95 : 0.78 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

const FAQ = [
  {
    q: 'What is fractional ownership of real estate?',
    a: 'Fractional ownership divides a single property into many units so several investors can each hold a share. Each investor receives rental income in proportion to their holding and participates in any change in the property value. It lowers the entry ticket from the full price of a property to a small fraction of it.',
  },
  {
    q: 'How is fractional ownership different from a REIT?',
    a: 'A REIT is a listed, regulated fund holding a large portfolio, bought and sold like a share with high liquidity and no choice of individual property. Fractional ownership gives you a share in one specific, identifiable property, usually with a higher yield but much lower liquidity because you need a buyer for your units. SEBI has also created Small and Medium REITs, which sit between the two.',
  },
  {
    q: 'What returns can I expect from fractional real estate in India?',
    a: 'Platforms commonly advertise 8–12% total return: roughly 6–9% rental yield on commercial property plus appreciation. Residential yields are considerably lower, typically 2–3% net. Treat advertised figures as targets rather than promises, since appreciation is not guaranteed and exit depends on finding a buyer.',
  },
  {
    q: 'What are the risks of fractional property investment?',
    a: 'The main ones are illiquidity (selling your units needs a willing buyer), vacancy and tenant default, property-specific risk from holding one asset rather than a portfolio, platform risk if the operator fails, and the prospect that appreciation falls short. Being a minority holder also means limited say in decisions about the property.',
  },
  {
    q: 'How are fractional property returns taxed in India?',
    a: 'Rental income is generally taxed as income from house property or other sources depending on the holding structure, and gains on sale attract capital gains tax with the rate depending on the holding period. Structures vary between platforms, so confirm the treatment of your specific arrangement with a tax adviser.',
  },
]

const RELATED = [
  { to: '/tools/rental-yield-calculator', label: 'Rental yield calculator', note: 'work out the net yield to use above' },
  { to: '/umi', label: 'Atomic DvP settlement demo', note: 'how a fractional trade settles against digital rupee' },
  { to: '/ledger', label: 'Ownership ledger explorer', note: 'how each share is recorded' },
]
