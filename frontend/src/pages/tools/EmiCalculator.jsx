// Free public tool: home loan EMI calculator.
//
// Ranks for "home loan emi calculator", "emi calculator india", "home loan
// prepayment calculator". Client-side only, no login, no API calls.
//
// Most EMI calculators stop at the monthly figure. The monthly figure is the
// least interesting number in a home loan: on a 20-year loan the borrower
// typically pays back close to double what they borrowed, and nothing on the
// page says so. This one leads with total interest, shows what one extra EMI
// a year does to the tenure, and prices the tax relief properly instead of
// quoting the headline caps.

import React, { useState, useMemo } from 'react'
import ToolShell, { card, C, Field, inr, pct } from './ToolShell'

const num = (v) => {
  const n = parseFloat(v)
  return isFinite(n) && n >= 0 ? n : 0
}

// Standard amortising EMI. r is the monthly rate, n the number of months.
// EMI = P·r·(1+r)^n / ((1+r)^n − 1), with the r = 0 case handled separately
// because the formula divides by zero there.
function emiOf(principal, annualRate, months) {
  if (principal <= 0 || months <= 0) return 0
  const r = annualRate / 12 / 100
  if (r === 0) return principal / months
  const f = Math.pow(1 + r, months)
  return (principal * r * f) / (f - 1)
}

// Runs the loan month by month. Returns the real payoff length, which is what
// changes when the borrower prepays — the EMI stays fixed and the tenure
// shortens. Capped at 600 months so a silly rate cannot hang the browser.
function schedule(principal, annualRate, months, extraPerYear) {
  const r = annualRate / 12 / 100
  const emi = emiOf(principal, annualRate, months)
  let bal = principal
  let interest = 0
  let paid = 0
  let m = 0
  const yearly = []
  let yInt = 0
  let yPrin = 0

  while (bal > 0.5 && m < 600) {
    m++
    const i = bal * r
    let p = emi - i
    if (p <= 0) return { impossible: true, emi, months: 0, interest: 0, total: 0, yearly: [] }
    if (p > bal) p = bal
    bal -= p
    interest += i
    paid += i + p
    yInt += i
    yPrin += p

    // One extra EMI at each year end, applied entirely to principal.
    if (m % 12 === 0) {
      if (extraPerYear > 0 && bal > 0) {
        const extra = Math.min(extraPerYear, bal)
        bal -= extra
        paid += extra
        yPrin += extra
      }
      yearly.push({ year: m / 12, interest: yInt, principal: yPrin, balance: Math.max(bal, 0) })
      yInt = 0
      yPrin = 0
    }
  }
  if (yInt > 0 || yPrin > 0) {
    yearly.push({ year: Math.ceil(m / 12), interest: yInt, principal: yPrin, balance: Math.max(bal, 0) })
  }
  return { impossible: false, emi, months: m, interest, total: paid, yearly }
}

const fmtTenure = (m) => {
  const y = Math.floor(m / 12)
  const mm = m % 12
  return mm === 0 ? `${y} years` : `${y}y ${mm}m`
}

export default function EmiCalculator() {
  const [price, setPrice] = useState('7500000')
  const [down, setDown] = useState('1500000')
  const [rate, setRate] = useState('8.5')
  const [years, setYears] = useState('20')
  const [extra, setExtra] = useState(false)
  const [income, setIncome] = useState('150000')
  const [slab, setSlab] = useState('30')
  const [regime, setRegime] = useState('old')
  const [selfOccupied, setSelfOccupied] = useState(true)

  const r = useMemo(() => {
    const P = num(price)
    const D = Math.min(num(down), P)
    const loan = Math.max(P - D, 0)
    const months = Math.round(num(years) * 12)
    const i = num(rate)

    const base = schedule(loan, i, months, 0)
    const emi = base.emi
    const withExtra = extra ? schedule(loan, i, months, emi) : null

    // Year-one interest and principal drive the tax relief. Section 24(b)
    // caps interest relief at ₹2,00,000 for a self-occupied property and is
    // uncapped for a let-out one (though the overall house-property set-off
    // against other income is itself capped at ₹2,00,000). Section 80C takes
    // the principal up to ₹1,50,000, shared with EPF, ELSS, insurance and the
    // rest — so the realistic marginal benefit is usually smaller.
    const y1 = base.yearly[0] || { interest: 0, principal: 0 }
    const sec24 = selfOccupied ? Math.min(y1.interest, 200000) : Math.min(y1.interest, 200000)
    const sec80c = Math.min(y1.principal, 150000)
    const taxRelief = regime === 'old' ? ((sec24 + sec80c) * num(slab)) / 100 : 0

    // Lenders size the loan on net monthly income, typically allowing an EMI
    // of 40–50% of it. 45% is the common middle.
    const affordable = num(income) * 0.45
    const emiToIncome = num(income) > 0 ? (emi / num(income)) * 100 : 0

    // Effective cost after tax relief, spread over the first year only.
    const effectiveEmi = emi - taxRelief / 12

    return {
      loan, emi, months: base.months, interest: base.interest, total: base.total,
      impossible: base.impossible, yearly: base.yearly,
      ltv: P > 0 ? (loan / P) * 100 : 0,
      interestPct: loan > 0 ? (base.interest / loan) * 100 : 0,
      withExtra, y1, sec24, sec80c, taxRelief, affordable, emiToIncome, effectiveEmi,
      downPct: P > 0 ? (D / P) * 100 : 0,
    }
  }, [price, down, rate, years, extra, income, slab, regime, selfOccupied])

  const saved = r.withExtra ? r.interest - r.withExtra.interest : 0
  const monthsSaved = r.withExtra ? r.months - r.withExtra.months : 0

  return (
    <ToolShell
      title="Home loan EMI calculator"
      tagline="Your monthly EMI, the total interest you will actually pay, what one extra EMI a year saves, and the tax relief you can realistically claim."
      faq={FAQ}
      related={RELATED}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 20, alignItems: 'start' }}>
        <div style={card}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 16 }}>Your loan</h2>

          <Field label="Property price" prefix="₹" value={price} onChange={setPrice} />
          <Field
            label="Down payment" prefix="₹" value={down} onChange={setDown}
            hint={`${pct(r.downPct)} of price · loan-to-value ${pct(r.ltv)}${r.ltv > 80 ? ' — most lenders cap LTV at 80% for loans above ₹75 lakh' : ''}`}
          />
          <Field label="Interest rate" suffix="% p.a." value={rate} onChange={setRate} step="0.05"
            hint="Floating rates are repo-linked and reset quarterly; this assumes the rate holds." />
          <Field label="Tenure" suffix="years" value={years} onChange={setYears} step="1" />

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} style={{ marginTop: 3 }} />
            <span style={{ fontSize: 13.5, color: C.body, lineHeight: 1.5 }}>
              Pay <b>one extra EMI every year</b> towards principal
            </span>
          </label>
        </div>

        <div style={card}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 16 }}>What it costs</h2>

          {r.impossible ? (
            <div style={{ padding: 14, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 13.5, color: '#991B1B', lineHeight: 1.6 }}>
              At this rate and tenure the EMI does not even cover the monthly interest, so the
              loan would never be repaid. Increase the tenure or reduce the rate.
            </div>
          ) : (
            <>
              <div style={{ padding: '14px 16px', background: C.navy, borderRadius: 10, marginBottom: 16 }}>
                <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.75)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Monthly EMI</div>
                <div style={{ fontSize: 30, fontWeight: 800, color: 'white', lineHeight: 1.2, marginTop: 2 }}>{inr(r.emi)}</div>
                <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.8)', marginTop: 3 }}>
                  on a loan of {inr(r.loan)} for {fmtTenure(r.months)}
                </div>
              </div>

              <Row k="Total interest paid" v={inr(r.interest)} strong />
              <Row k="Total repaid" v={inr(r.total)} />
              <Row k="Interest as % of loan" v={pct(r.interestPct)} />

              <div style={{ marginTop: 14, padding: 12, background: r.interestPct > 90 ? '#FFFBEB' : C.soft, border: `1px solid ${r.interestPct > 90 ? '#FDE68A' : C.line}`, borderRadius: 8, fontSize: 13, color: r.interestPct > 90 ? '#92400E' : C.body, lineHeight: 1.6 }}>
                You borrow <b>{inr(r.loan)}</b> and repay <b>{inr(r.total)}</b>.
                {r.interestPct > 90
                  ? ' The interest is more than the loan itself — this is what a long tenure costs.'
                  : ' Shortening the tenure cuts this sharply; lengthening it barely reduces the EMI.'}
              </div>

              {r.withExtra && !r.withExtra.impossible && (
                <div style={{ marginTop: 12, padding: 12, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, fontSize: 13, color: '#065F46', lineHeight: 1.65 }}>
                  <b>One extra EMI a year</b> clears the loan in <b>{fmtTenure(r.withExtra.months)}</b> instead
                  of {fmtTenure(r.months)} — {monthsSaved} months earlier — and saves <b>{inr(saved)}</b> in interest.
                  That is {inr(r.emi)} a year buying back {inr(saved)}.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Affordability */}
      <div style={{ ...card, marginTop: 20 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 6 }}>Can you carry it?</h2>
        <p style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.6, marginBottom: 16, maxWidth: '72ch' }}>
          Lenders size a loan on net take-home pay, usually allowing an EMI of 40–50% of it.
          Crossing that is the single most common reason a sanction is cut or refused.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 18, alignItems: 'start' }}>
          <Field label="Net monthly income (take-home)" prefix="₹" value={income} onChange={setIncome} />
          <div>
            <Row k="EMI as % of income" v={pct(r.emiToIncome)} strong />
            <Row k="Comfortable EMI at 45%" v={inr(r.affordable)} />
            <div style={{
              marginTop: 10, padding: 11, borderRadius: 8, fontSize: 13, lineHeight: 1.6,
              background: r.emiToIncome > 50 ? '#FEF2F2' : r.emiToIncome > 40 ? '#FFFBEB' : '#F0FDF4',
              border: `1px solid ${r.emiToIncome > 50 ? '#FECACA' : r.emiToIncome > 40 ? '#FDE68A' : '#BBF7D0'}`,
              color: r.emiToIncome > 50 ? '#991B1B' : r.emiToIncome > 40 ? '#92400E' : '#065F46',
            }}>
              {r.emiToIncome > 50
                ? 'Above 50% of income. Most lenders will reduce the sanction, and there is little room for a rate rise.'
                : r.emiToIncome > 40
                  ? 'In the 40–50% band. Fundable, but tight — a rate reset would hurt.'
                  : 'Within the comfortable band. Room remains for a rate rise or a second obligation.'}
            </div>
          </div>
        </div>
      </div>

      {/* Tax */}
      <div style={{ ...card, marginTop: 20 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 6 }}>Tax relief, year one</h2>
        <p style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.6, marginBottom: 16, maxWidth: '72ch' }}>
          Relief is largest in the early years, when almost all of the EMI is interest. It shrinks
          every year as the principal share grows — so the "tax saving" argument for a home loan
          weakens over time rather than holding steady.
        </p>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 16 }}>
          <label style={{ fontSize: 13.5, color: C.body, display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="radio" checked={regime === 'old'} onChange={() => setRegime('old')} /> Old regime
          </label>
          <label style={{ fontSize: 13.5, color: C.body, display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="radio" checked={regime === 'new'} onChange={() => setRegime('new')} /> New regime
          </label>
          <label style={{ fontSize: 13.5, color: C.body, display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="checkbox" checked={selfOccupied} onChange={(e) => setSelfOccupied(e.target.checked)} /> Self-occupied
          </label>
          <label style={{ fontSize: 13.5, color: C.body, display: 'flex', alignItems: 'center', gap: 7 }}>
            Tax slab
            <select value={slab} onChange={(e) => setSlab(e.target.value)} style={{ padding: '6px 10px', border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 13.5, fontFamily: 'inherit', background: 'white' }}>
              <option value="5">5%</option>
              <option value="20">20%</option>
              <option value="30">30%</option>
            </select>
          </label>
        </div>

        {regime === 'new' ? (
          <div style={{ padding: 13, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, fontSize: 13.5, color: '#92400E', lineHeight: 1.65 }}>
            <b>No relief under the new regime</b> for a self-occupied property. Sections 80C and
            24(b) are both unavailable, so the EMI costs you its full {inr(r.emi)} a month. Interest
            on a <i>let-out</i> property remains deductible against that property's rental income.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
            <Box label="Interest paid, year 1" value={inr(r.y1.interest)} note={`of which ${inr(r.sec24)} is deductible u/s 24(b)`} />
            <Box label="Principal repaid, year 1" value={inr(r.y1.principal)} note={`${inr(r.sec80c)} counts towards the 80C limit`} />
            <Box label="Tax saved at your slab" value={inr(r.taxRelief)} note={`effective EMI ${inr(r.effectiveEmi)}/month`} tone />
          </div>
        )}

        {regime === 'old' && (
          <div style={{ marginTop: 14, padding: 12, background: C.soft, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12.5, color: C.body, lineHeight: 1.65 }}>
            The ₹1.5 lakh 80C limit is shared with EPF, ELSS, life insurance premiums, children's
            tuition fees and PPF. If those already fill it, the principal component adds nothing and
            your real saving is the 24(b) figure alone.
          </div>
        )}
      </div>

      {/* Amortisation */}
      {!r.impossible && r.yearly.length > 0 && (
        <div style={{ ...card, marginTop: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 6 }}>Where each year's money goes</h2>
          <p style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.6, marginBottom: 16, maxWidth: '72ch' }}>
            The EMI never changes, but its split does. Early on it is nearly all interest, which is
            why selling in year three returns far less equity than people expect.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Year', 'Interest', 'Principal', 'Balance', 'Principal share'].map((h) => (
                    <th key={h} style={{ textAlign: h === 'Year' ? 'left' : 'right', padding: '8px 10px', borderBottom: `2px solid ${C.line}`, color: C.muted, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.yearly.map((y) => {
                  const tot = y.interest + y.principal
                  const share = tot > 0 ? (y.principal / tot) * 100 : 0
                  return (
                    <tr key={y.year}>
                      <td style={td(true)}>{y.year}</td>
                      <td style={td()}>{inr(y.interest)}</td>
                      <td style={td()}>{inr(y.principal)}</td>
                      <td style={td()}>{inr(y.balance)}</td>
                      <td style={td()}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end' }}>
                          <span style={{ width: 54, height: 6, background: C.line, borderRadius: 3, overflow: 'hidden', display: 'inline-block' }}>
                            <span style={{ display: 'block', width: `${Math.min(share, 100)}%`, height: '100%', background: C.accent }} />
                          </span>
                          {pct(share, 0)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: C.ink, marginBottom: 12 }}>How the EMI is actually calculated</h2>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '70ch' }}>
          Every lender uses the same formula. The EMI is fixed so that the loan reaches exactly
          zero on the last month: <b>EMI = P × r × (1+r)<sup>n</sup> ÷ ((1+r)<sup>n</sup> − 1)</b>,
          where P is the principal, r the monthly rate (annual ÷ 12 ÷ 100) and n the number of months.
          Interest each month is charged on the outstanding balance only, so the interest portion
          falls and the principal portion rises as the balance drops.
        </p>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '70ch', marginTop: 12 }}>
          That shape is why prepayment is so effective early and so pointless late. A rupee paid
          against the principal in year two removes roughly eighteen years of future interest on
          that rupee. The same rupee in year eighteen removes two. Lenders cannot charge a
          prepayment penalty on floating-rate home loans to individuals, so an early part-payment
          is usually the highest guaranteed return available to a borrower — it earns your loan
          rate, tax-free, with no market risk.
        </p>
      </section>
    </ToolShell>
  )
}

const td = (first) => ({
  padding: '8px 10px',
  borderBottom: `1px solid ${C.line}`,
  textAlign: first ? 'left' : 'right',
  color: C.body,
  whiteSpace: 'nowrap',
  fontWeight: first ? 600 : 400,
})

function Row({ k, v, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 13.5, color: C.muted }}>{k}</span>
      <span style={{ fontSize: strong ? 15 : 14, fontWeight: strong ? 700 : 600, color: C.ink }}>{v}</span>
    </div>
  )
}

function Box({ label, value, note, tone }) {
  return (
    <div style={{ padding: 13, background: tone ? '#F0FDF4' : C.soft, border: `1px solid ${tone ? '#BBF7D0' : C.line}`, borderRadius: 9 }}>
      <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: tone ? '#065F46' : C.ink, marginTop: 3 }}>{value}</div>
      {note && <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>{note}</div>}
    </div>
  )
}

const FAQ = [
  {
    q: 'How is home loan EMI calculated?',
    a: 'EMI = P × r × (1+r)^n ÷ ((1+r)^n − 1), where P is the loan amount, r is the monthly interest rate (annual rate ÷ 12 ÷ 100) and n is the tenure in months. The EMI stays constant while the split between interest and principal shifts: interest is charged only on the outstanding balance, so it falls every month as the balance reduces.',
  },
  {
    q: 'Does a longer tenure reduce the EMI much?',
    a: 'Less than people expect, and it costs a great deal. Going from 20 to 25 years on a ₹60 lakh loan at 8.5% cuts the EMI by roughly 7%, but adds several years of interest — often more than ₹15 lakh. Beyond about 20 years the EMI curve flattens: you pay far longer for a barely smaller instalment.',
  },
  {
    q: 'Is it better to prepay or to invest the money?',
    a: 'Prepaying earns you your loan rate, guaranteed, tax-free and risk-free. An investment must beat that rate after tax to win. At 8.5% a home loan, prepayment is equivalent to a guaranteed pre-tax return of roughly 12% for someone in the 30% slab — hard to beat reliably. The exception is when the loan is nearly repaid, since there is little future interest left to remove.',
  },
  {
    q: 'Can the bank charge a penalty for prepaying?',
    a: 'Not on floating-rate home loans taken by individuals — the RBI prohibits foreclosure charges and prepayment penalties on those. Fixed-rate loans and loans to non-individuals can still attract a charge, so check the sanction letter before making a large part-payment.',
  },
  {
    q: 'How much tax can I save on a home loan?',
    a: 'Under the old regime, up to ₹2,00,000 of interest a year under section 24(b) for a self-occupied property, plus principal repayment within the ₹1,50,000 section 80C limit — a limit shared with EPF, ELSS, insurance and PPF. Under the new regime there is no deduction for a self-occupied property at all. Relief is largest in the first years and shrinks as the interest component falls.',
  },
  {
    q: 'What EMI will a bank approve for my income?',
    a: 'Most lenders allow a total EMI burden of 40–50% of net monthly take-home pay, including any existing loans and card obligations. They also apply a loan-to-value cap: typically 90% of property value for small loans, 80% above ₹75 lakh. The lower of the two tests decides the sanction.',
  },
]

const RELATED = [
  { to: '/tools/stamp-duty-calculator', label: 'Stamp duty calculator', note: 'the cash you need on top of the down payment' },
  { to: '/tools/rental-yield-calculator', label: 'Rental yield calculator', note: 'does the rent cover the EMI?' },
  { to: '/tools/fractional-investment-calculator', label: 'Fractional investment calculator', note: 'property exposure without a loan' },
]
