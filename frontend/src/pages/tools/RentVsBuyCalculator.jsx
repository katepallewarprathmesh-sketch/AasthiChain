// Free public tool: rent vs buy calculator.
//
// Ranks for "rent vs buy calculator india", "should i buy a house or rent",
// "rent or buy home calculator". Client-side only, no login.
//
// Almost every rent-vs-buy page in India compares the EMI to the rent. That
// comparison is close to meaningless: it ignores that the renter still has
// the down payment, the stamp duty and the registration money, and that this
// capital earns a return. Done honestly, the renter is not "throwing money
// away" — they are running a leveraged-free portfolio against a leveraged
// property, and which wins depends almost entirely on two numbers nobody
// knows in advance: appreciation and investment return.
//
// So this tool does a year-by-year net-worth comparison of both paths and
// reports the break-even year, rather than declaring a winner.

import React, { useState, useMemo } from 'react'
import ToolShell, { card, C, Field, inr, pct } from './ToolShell'

const num = (v) => {
  const n = parseFloat(v)
  return isFinite(n) && n >= 0 ? n : 0
}

const emiOf = (P, annual, months) => {
  if (P <= 0 || months <= 0) return 0
  const r = annual / 1200
  if (r === 0) return P / months
  const f = Math.pow(1 + r, months)
  return (P * r * f) / (f - 1)
}

// Runs both paths month by month for `years`, returning a yearly series of
// net worth under each. The renter's portfolio is seeded with the buyer's
// upfront cash and then receives the monthly cash-flow difference whenever
// owning costs more than renting (and is drawn down when renting costs more).
function project(inp) {
  const {
    price, downPct, rate, loanYears, stampPct, otherUpfront,
    rent, rentGrowth, appreciation, maintPct, taxPct, invReturn, years, sellCostPct,
  } = inp

  const down = price * (downPct / 100)
  const stamp = price * (stampPct / 100)
  const upfront = down + stamp + otherUpfront
  const loan = Math.max(price - down, 0)
  const months = Math.round(loanYears * 12)
  const emi = emiOf(loan, rate, months)
  const mr = rate / 1200
  const ir = Math.pow(1 + invReturn / 100, 1 / 12) - 1

  let bal = loan
  let value = price
  let curRent = rent
  let portfolio = upfront // renter invests the buyer's upfront cash on day one
  let rentPaid = 0
  let interestPaid = 0
  let ownCostPaid = 0 // non-equity owner spend: interest + maintenance + tax
  const series = []

  const totalMonths = Math.round(years * 12)
  for (let m = 1; m <= totalMonths; m++) {
    // --- owner ---
    let thisEmi = 0
    if (bal > 0.5 && m <= months) {
      const i = bal * mr
      let p = emi - i
      if (p > bal) p = bal
      bal -= p
      interestPaid += i
      thisEmi = i + p
      ownCostPaid += i
    }
    const monthlyMaint = (value * (maintPct / 100)) / 12
    const monthlyTax = (value * (taxPct / 100)) / 12
    ownCostPaid += monthlyMaint + monthlyTax
    const ownerOutflow = thisEmi + monthlyMaint + monthlyTax

    // --- renter ---
    const renterOutflow = curRent
    rentPaid += curRent

    // The renter banks the difference (or sells units to cover a shortfall).
    portfolio = portfolio * (1 + ir) + (ownerOutflow - renterOutflow)
    if (portfolio < 0) portfolio = 0 // cannot invest less than nothing

    value *= Math.pow(1 + appreciation / 100, 1 / 12)

    if (m % 12 === 0) {
      curRent *= 1 + rentGrowth / 100
      const sellCost = value * (sellCostPct / 100)
      const ownerNet = value - sellCost - bal
      series.push({
        year: m / 12,
        ownerNet,
        renterNet: portfolio,
        value,
        balance: bal,
        rentPaid,
        interestPaid,
        ownCostPaid,
        equity: value - bal,
      })
    }
  }

  const last = series[series.length - 1] || { ownerNet: 0, renterNet: 0 }
  // Break-even: first year the owner's net position overtakes the renter's
  // and stays ahead for the rest of the horizon.
  let breakEven = null
  for (let i = 0; i < series.length; i++) {
    if (series[i].ownerNet >= series[i].renterNet && series.slice(i).every((s) => s.ownerNet >= s.renterNet)) {
      breakEven = series[i].year
      break
    }
  }

  return { series, last, breakEven, emi, upfront, loan, down, stamp, monthlyRent0: rent }
}

export default function RentVsBuyCalculator() {
  const [price, setPrice] = useState('7500000')
  const [downPct, setDownPct] = useState('20')
  const [rate, setRate] = useState('8.5')
  const [loanYears, setLoanYears] = useState('20')
  const [stampPct, setStampPct] = useState('7')
  const [otherUpfront, setOtherUpfront] = useState('300000')
  const [rent, setRent] = useState('28000')
  const [rentGrowth, setRentGrowth] = useState('7')
  const [appreciation, setAppreciation] = useState('6')
  const [maintPct, setMaintPct] = useState('1')
  const [taxPct, setTaxPct] = useState('0.2')
  const [invReturn, setInvReturn] = useState('11')
  const [years, setYears] = useState('15')
  const [sellCostPct, setSellCostPct] = useState('2')

  const r = useMemo(() => project({
    price: num(price), downPct: num(downPct), rate: num(rate), loanYears: num(loanYears),
    stampPct: num(stampPct), otherUpfront: num(otherUpfront), rent: num(rent),
    rentGrowth: num(rentGrowth), appreciation: num(appreciation), maintPct: num(maintPct),
    taxPct: num(taxPct), invReturn: num(invReturn), years: Math.min(num(years), 40),
    sellCostPct: num(sellCostPct),
  }), [price, downPct, rate, loanYears, stampPct, otherUpfront, rent, rentGrowth,
    appreciation, maintPct, taxPct, invReturn, years, sellCostPct])

  const gap = r.last.ownerNet - r.last.renterNet
  const buyWins = gap > 0
  const maxNet = Math.max(...r.series.map((s) => Math.max(s.ownerNet, s.renterNet)), 1)

  return (
    <ToolShell
      title="Rent vs buy calculator"
      tagline="A year-by-year net worth comparison of buying against renting and investing the difference — including the down payment the renter still has, which is the part most calculators quietly ignore."
      faq={FAQ}
      related={RELATED}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(290px,1fr))', gap: 20, alignItems: 'start' }}>
        <div style={card}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 16 }}>If you buy</h2>
          <Field label="Property price" prefix="₹" value={price} onChange={setPrice} />
          <Field label="Down payment" suffix="%" value={downPct} onChange={setDownPct}
            hint={`${inr(r.down)} upfront`} />
          <Field label="Interest rate" suffix="% p.a." value={rate} onChange={setRate} step="0.05" />
          <Field label="Loan tenure" suffix="years" value={loanYears} onChange={setLoanYears} step="1"
            hint={`EMI ${inr(r.emi)} per month`} />
          <Field label="Stamp duty + registration" suffix="%" value={stampPct} onChange={setStampPct} step="0.1"
            hint={`${inr(r.stamp)} — unrecoverable, you never get this back`} />
          <Field label="Other upfront costs" prefix="₹" value={otherUpfront} onChange={setOtherUpfront}
            hint="Brokerage, legal, interiors, parking, society deposit" />
          <Field label="Maintenance + repairs" suffix="% of value p.a." value={maintPct} onChange={setMaintPct} step="0.1" />
          <Field label="Property tax" suffix="% of value p.a." value={taxPct} onChange={setTaxPct} step="0.05" />
          <Field label="Appreciation" suffix="% p.a." value={appreciation} onChange={setAppreciation} step="0.5" />
          <Field label="Cost to sell" suffix="%" value={sellCostPct} onChange={setSellCostPct} step="0.5"
            hint="Brokerage and transfer charges when you eventually exit" />
        </div>

        <div style={card}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 16 }}>If you rent</h2>
          <Field label="Monthly rent" prefix="₹" value={rent} onChange={setRent}
            hint={`${pct((num(rent) * 12 / Math.max(num(price), 1)) * 100)} of the property price per year`} />
          <Field label="Rent increase" suffix="% p.a." value={rentGrowth} onChange={setRentGrowth} step="0.5" />
          <Field label="Return on invested money" suffix="% p.a." value={invReturn} onChange={setInvReturn} step="0.5"
            hint="The renter invests the down payment, stamp duty and any monthly saving. Index funds have historically returned 10–12% before tax." />
          <Field label="Compare over" suffix="years" value={years} onChange={setYears} step="1" />

          <div style={{ marginTop: 16, padding: 13, background: C.soft, border: `1px solid ${C.line}`, borderRadius: 9, fontSize: 13, color: C.body, lineHeight: 1.65 }}>
            The renter starts with <b>{inr(r.upfront)}</b> invested — the money the buyer put into the
            down payment, stamp duty and upfront costs. Each month they also invest whatever the
            owner spends above their rent, and draw down when rent exceeds it.
          </div>
        </div>
      </div>

      {/* Verdict */}
      <div style={{
        marginTop: 20, padding: '18px 20px', borderRadius: 12,
        background: buyWins ? '#F0FDF4' : '#FFFBEB',
        border: `1px solid ${buyWins ? '#BBF7D0' : '#FDE68A'}`,
      }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: buyWins ? '#065F46' : '#92400E' }}>
          After {Math.min(num(years), 40)} years
        </div>
        <div style={{ fontSize: 'clamp(19px,3vw,25px)', fontWeight: 800, color: buyWins ? '#065F46' : '#92400E', marginTop: 5, lineHeight: 1.3 }}>
          {buyWins ? 'Buying' : 'Renting and investing'} leaves you {inr(Math.abs(gap))} better off
        </div>
        <div style={{ fontSize: 14, color: buyWins ? '#065F46' : '#92400E', marginTop: 7, lineHeight: 1.6 }}>
          Owner net worth {inr(r.last.ownerNet)} (property value less selling cost and outstanding loan) versus
          renter portfolio {inr(r.last.renterNet)}.
          {r.breakEven
            ? <> Buying moves ahead permanently in <b>year {r.breakEven}</b>.</>
            : <> Buying never overtakes renting within this horizon.</>}
        </div>
      </div>

      {/* Chart */}
      <div style={{ ...card, marginTop: 20 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 4 }}>Net worth, year by year</h2>
        <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: C.muted, marginBottom: 16 }}>
          <span><Sw c={C.navy} /> Buying</span>
          <span><Sw c={C.accent} /> Renting + investing</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 190, borderBottom: `1px solid ${C.line}`, paddingBottom: 2, overflowX: 'auto' }}>
          {r.series.map((s) => (
            <div key={s.year} style={{ flex: '1 0 14px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 2, minWidth: 14 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 170, width: '100%', justifyContent: 'center' }}>
                <div title={`Year ${s.year} · buying ${inr(s.ownerNet)}`}
                  style={{ width: '45%', height: `${Math.max((s.ownerNet / maxNet) * 100, 0.5)}%`, background: C.navy, borderRadius: '2px 2px 0 0' }} />
                <div title={`Year ${s.year} · renting ${inr(s.renterNet)}`}
                  style={{ width: '45%', height: `${Math.max((s.renterNet / maxNet) * 100, 0.5)}%`, background: C.accent, borderRadius: '2px 2px 0 0' }} />
              </div>
              <div style={{ fontSize: 9.5, color: C.muted }}>{s.year % 5 === 0 || s.year === 1 ? s.year : ''}</div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12.5, color: C.muted, marginTop: 10, lineHeight: 1.6 }}>
          The owner's bar starts deeply negative in substance — stamp duty is gone the day you pay
          it — and climbs as the loan amortises and the property compounds. The renter's bar starts
          at the full upfront amount and compounds from day one. That head start is the whole game.
        </p>
      </div>

      {/* Table */}
      <div style={{ ...card, marginTop: 20 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 14 }}>The detail</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Year', 'Property value', 'Loan left', 'Owner net', 'Renter net', 'Ahead by'].map((h) => (
                  <th key={h} style={{ textAlign: h === 'Year' ? 'left' : 'right', padding: '8px 10px', borderBottom: `2px solid ${C.line}`, color: C.muted, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.series.map((s) => {
                const d = s.ownerNet - s.renterNet
                return (
                  <tr key={s.year}>
                    <td style={td(true)}>{s.year}</td>
                    <td style={td()}>{inr(s.value)}</td>
                    <td style={td()}>{inr(s.balance)}</td>
                    <td style={td()}>{inr(s.ownerNet)}</td>
                    <td style={td()}>{inr(s.renterNet)}</td>
                    <td style={{ ...td(), color: d >= 0 ? '#0F7B3E' : '#B45309', fontWeight: 600 }}>
                      {d >= 0 ? 'buy ' : 'rent '}{inr(Math.abs(d))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: C.ink, marginBottom: 12 }}>Why "rent is throwing money away" is wrong</h2>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '70ch' }}>
          Rent buys you somewhere to live for a month. So does the interest portion of an EMI, the
          maintenance, the property tax and the stamp duty — none of that becomes equity either. In
          the first years of a 20-year loan roughly 80% of each EMI is interest. The honest
          comparison is not EMI against rent; it is <b>rent against the non-equity cost of owning</b>,
          with the down payment counted as capital the renter still holds and can invest.
        </p>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '70ch', marginTop: 12 }}>
          Two numbers decide the outcome and neither is knowable in advance: property appreciation
          and investment return. Indian residential prices in most cities have grown in the mid
          single digits over the last decade, while equity indices have done roughly 11–12%. Put
          those in and renting usually wins on arithmetic alone. Put appreciation at 9% and buying
          wins comfortably. <b>Move the appreciation slider before trusting any verdict, including
          this one.</b>
        </p>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '70ch', marginTop: 12 }}>
          What the arithmetic cannot price: security of tenure, not being asked to vacate, freedom
          to renovate, and the fact that an EMI is forced saving while "invest the difference"
          requires a discipline most people do not sustain. A renter who spends the difference
          ends with nothing, and that is the common case rather than the exception. Buying also
          concentrates your wealth in one illiquid asset in one city — the same city your job is
          in. Those are real considerations; they are just not financial ones this tool can model.
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

const Sw = ({ c }) => (
  <span style={{ display: 'inline-block', width: 10, height: 10, background: c, borderRadius: 2, marginRight: 5 }} />
)

const FAQ = [
  {
    q: 'Is it better to rent or buy a house in India?',
    a: 'It depends almost entirely on two unknowns: how fast the property appreciates and what return you earn on money not spent on it. At mid-single-digit appreciation and 11–12% equity returns, renting and investing the difference usually comes out ahead on pure arithmetic. At 9% or higher appreciation, buying wins. Rental yields in Indian cities are unusually low — typically 2–4% of property value per year — which mathematically favours renting, because you are renting an expensive asset cheaply.',
  },
  {
    q: 'How long do I need to stay for buying to make sense?',
    a: 'Long enough to recover the unrecoverable costs — stamp duty, registration, brokerage and interiors, often 8–10% of the price, plus the cost of selling. Below roughly five to seven years those costs rarely get recovered through appreciation, so a short stay almost always favours renting. This calculator shows the exact break-even year for your inputs.',
  },
  {
    q: 'Why does this calculator include the down payment for the renter?',
    a: 'Because the renter actually has it. If you do not buy, the down payment, stamp duty and upfront costs stay in your hands and earn a return. Comparing an EMI to rent while pretending that capital vanished is the single most common error in rent-vs-buy comparisons, and it always makes buying look better than it is.',
  },
  {
    q: 'What rental yield is normal in India?',
    a: 'Roughly 2–4% of property value per year in most major cities — gross, before maintenance, property tax and vacancy. A ₹75 lakh flat renting at ₹28,000 a month is a 4.5% gross yield, which is on the higher side. Low yields mean renting is cheap relative to owning, and are a large part of why the arithmetic often favours renting in India.',
  },
  {
    q: 'Does this account for tax benefits on a home loan?',
    a: 'Not directly, to keep the comparison honest and simple. Under the old regime, section 24(b) relief on interest up to ₹2,00,000 and 80C on principal would improve the buying case somewhat — use the EMI calculator to size that, then mentally reduce the owner cost by the yearly tax saved. Under the new regime there is no relief on a self-occupied property, so the comparison here applies as-is.',
  },
  {
    q: 'What about the security of owning a home?',
    a: 'Real and not financial. Owning means no landlord can ask you to leave, no annual renegotiation, and freedom to modify the property. Against that, owning concentrates most of your net worth in one illiquid asset in one city, usually the city your income also depends on. This tool models money; the decision is not only about money.',
  },
]

const RELATED = [
  { to: '/tools/home-loan-emi-calculator', label: 'Home loan EMI calculator', note: 'the EMI and total interest behind the buying case' },
  { to: '/tools/stamp-duty-calculator', label: 'Stamp duty calculator', note: 'size the unrecoverable upfront cost accurately' },
  { to: '/tools/rental-yield-calculator', label: 'Rental yield calculator', note: 'what the same property returns as an investment' },
]
