// Free public tool: rental yield calculator.
// Ranks for "rental yield calculator india", "gross vs net rental yield".
// No login, no network calls - everything below is arithmetic in the browser.

import React, { useState, useMemo } from 'react'
import ToolShell, { card, C, Field, Stat, inr, pct } from './ToolShell'

const num = (v) => {
  const n = parseFloat(v)
  return isFinite(n) && n >= 0 ? n : 0
}

export default function RentalYieldCalculator() {
  const [price, setPrice] = useState('7500000')
  const [rent, setRent] = useState('28000')
  const [maintenance, setMaintenance] = useState('3000')
  const [tax, setTax] = useState('12000')
  const [insurance, setInsurance] = useState('6000')
  const [vacancy, setVacancy] = useState('5')
  const [costs, setCosts] = useState('400000')

  const r = useMemo(() => {
    const p = num(price)
    const monthlyRent = num(rent)
    const annualRent = monthlyRent * 12

    // Gross yield ignores every cost - it is the number listings advertise,
    // which is why it always looks better than what you actually earn.
    const grossYield = p > 0 ? (annualRent / p) * 100 : 0

    // Net yield subtracts running costs and expected empty months, and counts
    // acquisition costs (stamp duty, registration, brokerage, furnishing) as
    // part of what the investment really cost you.
    const vacancyLoss = annualRent * (Math.min(num(vacancy), 100) / 100)
    const annualCosts = num(maintenance) * 12 + num(tax) + num(insurance)
    const netIncome = annualRent - vacancyLoss - annualCosts
    const totalInvested = p + num(costs)
    const netYield = totalInvested > 0 ? (netIncome / totalInvested) * 100 : 0

    return {
      annualRent,
      grossYield,
      vacancyLoss,
      annualCosts,
      netIncome,
      totalInvested,
      netYield,
      monthlyNet: netIncome / 12,
      gap: grossYield - netYield,
      payback: netIncome > 0 ? totalInvested / netIncome : Infinity,
    }
  }, [price, rent, maintenance, tax, insurance, vacancy, costs])

  return (
    <ToolShell
      title="Rental Yield Calculator"
      tagline="Work out the gross and net rental yield on a property in seconds. Net yield is the one that matters — it is what you actually keep after costs and empty months."
      faq={FAQ}
      related={RELATED}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 20, alignItems: 'start' }}>
        <div style={card}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 16 }}>Property &amp; rent</h2>
          <Field label="Property price" prefix="₹" value={price} onChange={setPrice} />
          <Field label="Monthly rent" prefix="₹" value={rent} onChange={setRent} />
          <Field
            label="Acquisition costs"
            prefix="₹"
            value={costs}
            onChange={setCosts}
            hint="Stamp duty, registration, brokerage, furnishing. Roughly 6–8% of price in most Indian states."
          />

          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, margin: '22px 0 16px' }}>Running costs</h2>
          <Field label="Monthly maintenance / society fees" prefix="₹" value={maintenance} onChange={setMaintenance} />
          <Field label="Annual property tax" prefix="₹" value={tax} onChange={setTax} />
          <Field label="Annual insurance &amp; repairs" prefix="₹" value={insurance} onChange={setInsurance} />
          <Field
            label="Vacancy allowance"
            suffix="%"
            value={vacancy}
            onChange={setVacancy}
            hint="Share of the year the property sits empty. 5% is about two and a half weeks."
          />
        </div>

        <div style={{ ...card, background: C.navy, color: 'white', border: 'none' }}>
          <div style={{ fontSize: 12.5, opacity: 0.75, marginBottom: 4 }}>Net rental yield</div>
          <div style={{ fontSize: 46, fontWeight: 700, fontFamily: "'Fraunces',Georgia,serif", letterSpacing: '-0.03em', lineHeight: 1.05 }}>
            {pct(r.netYield)}
          </div>
          <div style={{ fontSize: 13.5, opacity: 0.8, marginTop: 6 }}>
            Gross yield {pct(r.grossYield)} · the gap is {pct(r.gap)}
          </div>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,.18)', display: 'grid', gap: 12 }}>
            <Row label="Annual rent collected" value={inr(r.annualRent)} />
            <Row label="Less vacancy" value={'− ' + inr(r.vacancyLoss)} />
            <Row label="Less running costs" value={'− ' + inr(r.annualCosts)} />
            <Row label="Net annual income" value={inr(r.netIncome)} strong />
            <Row label="Net monthly income" value={inr(r.monthlyNet)} />
            <Row label="Total invested" value={inr(r.totalInvested)} />
            <Row
              label="Payback from rent alone"
              value={isFinite(r.payback) ? `${r.payback.toFixed(1)} years` : '—'}
            />
          </div>

          {r.netIncome < 0 && (
            <div style={{ marginTop: 16, padding: 12, background: 'rgba(255,255,255,.12)', borderRadius: 8, fontSize: 13, lineHeight: 1.6 }}>
              Costs exceed the rent. This property loses money each year before any price
              appreciation.
            </div>
          )}
        </div>
      </div>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 22, fontFamily: "'Fraunces',Georgia,serif", color: C.ink, marginBottom: 12 }}>
          How rental yield is calculated
        </h2>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '66ch' }}>
          <strong>Gross rental yield</strong> is annual rent divided by the property price.
          It is quick, and it is the figure most listings quote, but it ignores every cost
          of actually owning the place.
        </p>
        <pre style={{ ...card, background: C.soft, fontSize: 13.5, overflowX: 'auto', margin: '14px 0', lineHeight: 1.7 }}>
{`gross yield = (monthly rent × 12) ÷ property price × 100

net yield   = (annual rent − vacancy − running costs)
              ÷ (property price + acquisition costs) × 100`}
        </pre>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '66ch' }}>
          <strong>Net rental yield</strong> subtracts maintenance, property tax, insurance
          and expected vacancy, and divides by what the property truly cost including stamp
          duty and registration. The difference is routinely 1.5 to 2.5 percentage points —
          on the default figures above, roughly a third of the headline number disappears.
          Residential property in Indian metros typically nets 2–3%; commercial can reach
          6–8% with longer leases and tenants who pay the maintenance.
        </p>
      </section>
    </ToolShell>
  )
}

function Row({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: strong ? 15 : 13.5, fontWeight: strong ? 700 : 400 }}>
      <span style={{ opacity: strong ? 0.95 : 0.78 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

const FAQ = [
  {
    q: 'What is a good rental yield in India?',
    a: 'Residential property in major Indian cities typically produces a gross yield of 2.5–4% and a net yield of 2–3%. Commercial property generally yields more, around 6–9% gross, because leases run longer and tenants often cover maintenance. A net yield above 4% on residential is unusually strong.',
  },
  {
    q: 'What is the difference between gross and net rental yield?',
    a: 'Gross yield is annual rent divided by property price, ignoring all costs. Net yield subtracts running costs such as maintenance, property tax, insurance and expected vacancy, and divides by the full acquisition cost including stamp duty and registration. Net yield is what you actually earn, and it is usually 1.5 to 2.5 percentage points lower than gross.',
  },
  {
    q: 'Should rental yield include property price appreciation?',
    a: 'No. Rental yield measures income only. Total return is rental yield plus capital appreciation. Keeping them separate matters because rent is cash you receive each month while appreciation is unrealised until you sell.',
  },
  {
    q: 'How much should I budget for vacancy?',
    a: 'Five per cent of annual rent is a common planning assumption, equivalent to roughly two and a half weeks empty per year. In slower rental markets, or for properties that turn over frequently, eight to ten per cent is more realistic.',
  },
  {
    q: 'Does rental yield work the same way for fractional ownership?',
    a: 'The arithmetic is identical, just scaled to your share. If you own two per cent of a property, you receive two per cent of the net rental income, and your yield is calculated against the amount you invested rather than the full property price.',
  },
]

const RELATED = [
  { to: '/tools/fractional-investment-calculator', label: 'Fractional investment calculator', note: 'project returns on a part-share of a property' },
  { to: '/umi', label: 'Atomic DvP settlement demo', note: 'see how a property trade settles against digital rupee' },
  { to: '/ledger', label: 'Ownership ledger explorer', note: 'every transfer, block by block' },
]
