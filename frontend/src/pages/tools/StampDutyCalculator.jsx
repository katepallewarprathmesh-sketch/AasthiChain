// Free public tool: stamp duty and registration charges calculator.
// Ranks for "stamp duty calculator maharashtra", "registration charges
// calculator india". Client-side only, no login.
//
// Rates are published by each state and change with budgets and cess
// notifications, and sources genuinely disagree on some of them (Maharashtra
// especially, where the figure depends on the municipal area and which cesses
// are included). They are therefore presented as indicative, dated, with a
// manual override and a link to the authoritative state portal. A calculator
// that quietly asserts a wrong rate is worse than one that admits the range.

import React, { useState, useMemo } from 'react'
import ToolShell, { card, C, Field, inr, pct } from './ToolShell'

const num = (v) => {
  const n = parseFloat(v)
  return isFinite(n) && n >= 0 ? n : 0
}

// male / female / joint (male+female) stamp duty %, registration % and any cap.
// Indicative for 2026; verify against the state portal before transacting.
const STATES = {
  'Maharashtra — Mumbai': { m: 6, f: 5, j: 6, reg: 1, regCap: 30000, portal: 'https://igrmaharashtra.gov.in' },
  'Maharashtra — Pune / Thane / Nagpur': { m: 7, f: 6, j: 6.5, reg: 1, regCap: 30000, portal: 'https://igrmaharashtra.gov.in' },
  'Maharashtra — rural': { m: 4, f: 3, j: 3.5, reg: 1, regCap: 30000, portal: 'https://igrmaharashtra.gov.in' },
  'Delhi': { m: 6, f: 4, j: 5, reg: 1, portal: 'https://revenue.delhi.gov.in' },
  'Delhi — NDMC area': { m: 5.5, f: 3.5, j: 4.5, reg: 1, portal: 'https://revenue.delhi.gov.in' },
  'Karnataka — Bengaluru': { m: 5, f: 5, j: 5, reg: 1, regCap: 15000, portal: 'https://kaveri.karnataka.gov.in' },
  'Tamil Nadu': { m: 7, f: 7, j: 7, reg: 4, portal: 'https://tnreginet.gov.in' },
  'Uttar Pradesh': { m: 7, f: 6, j: 6.5, reg: 1, portal: 'https://igrsup.gov.in' },
  'Gujarat': { m: 4.9, f: 4.9, j: 4.9, reg: 1, portal: 'https://garvi.gujarat.gov.in' },
  'Telangana': { m: 5, f: 5, j: 5, reg: 1, portal: 'https://registration.telangana.gov.in' },
  'Rajasthan': { m: 5, f: 4, j: 4.5, reg: 1, portal: 'https://epanjiyan.rajasthan.gov.in' },
  'Haryana': { m: 7, f: 5, j: 6, reg: 1, portal: 'https://jamabandi.nic.in' },
  'West Bengal': { m: 6, f: 6, j: 6, reg: 1, portal: 'https://wbregistration.gov.in' },
  'Madhya Pradesh': { m: 7.5, f: 7.5, j: 7.5, reg: 3, portal: 'https://mpigr.gov.in' },
}

const BUYERS = [['m', 'Male'], ['f', 'Female'], ['j', 'Joint (male + female)']]

export default function StampDutyCalculator() {
  const [state, setState] = useState('Maharashtra — Pune / Thane / Nagpur')
  const [buyer, setBuyer] = useState('m')
  const [price, setPrice] = useState('7500000')
  const [circle, setCircle] = useState('7000000')
  const [override, setOverride] = useState('')

  const r = useMemo(() => {
    const s = STATES[state]
    // Duty is charged on the HIGHER of the agreed price and the state's
    // circle / ready-reckoner / guidance value. Using the sale price alone is
    // the single most common mistake in these calculations.
    const base = Math.max(num(price), num(circle))
    const rate = override !== '' ? num(override) : s[buyer]
    const duty = base * (rate / 100)
    let reg = base * (s.reg / 100)
    const regUncapped = reg
    if (s.regCap) reg = Math.min(reg, s.regCap)
    // Section 194-IA: 1% TDS where consideration is ₹50 lakh or more. Paid to
    // the income tax department, not the state, but it is money due at the
    // same moment so it belongs in the budget.
    const tdsApplies = num(price) >= 5000000
    const tds = tdsApplies ? num(price) * 0.01 : 0
    const govt = duty + reg
    const total = govt + tds
    // 80C allows stamp duty + registration up to ₹1.5 lakh, old regime only.
    const deductible = Math.min(govt, 150000)
    return {
      base, rate, duty, reg, regUncapped, capped: !!s.regCap && regUncapped > s.regCap,
      tds, tdsApplies, govt, total, deductible,
      pctOfPrice: num(price) > 0 ? (govt / num(price)) * 100 : 0,
      usingCircle: num(circle) > num(price),
      femaleSaving: buyer !== 'f' ? base * ((s[buyer] - s.f) / 100) : 0,
      portal: s.portal,
    }
  }, [state, buyer, price, circle, override])

  const sel = { width: '100%', padding: '10px 12px', fontSize: 15, borderRadius: 8, border: `1px solid ${C.line}`, background: 'white', color: C.ink, fontFamily: 'inherit' }

  return (
    <ToolShell
      title="Stamp Duty & Registration Calculator"
      tagline="What a property purchase actually costs beyond the price. Stamp duty and registration add roughly 5–9% in most Indian states, and they are charged on the higher of your price and the government's circle rate."
      faq={FAQ}
      related={RELATED}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 20, alignItems: 'start' }}>
        <div style={card}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 16 }}>Your purchase</h2>

          <label style={{ display: 'block', marginBottom: 14 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 6 }}>State / area</span>
            <select value={state} onChange={(e) => { setState(e.target.value); setOverride('') }} style={sel}>
              {Object.keys(STATES).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>

          <label style={{ display: 'block', marginBottom: 14 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Registered in the name of</span>
            <select value={buyer} onChange={(e) => setBuyer(e.target.value)} style={sel}>
              {BUYERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>

          <Field label="Agreed sale price" prefix="₹" value={price} onChange={setPrice} />
          <Field
            label="Circle / ready-reckoner value"
            prefix="₹"
            value={circle}
            onChange={setCircle}
            hint="The state's minimum valuation for the area. Duty is charged on whichever is higher, this or your price."
          />
          <Field
            label="Override stamp duty rate (optional)"
            suffix="%"
            value={override}
            onChange={setOverride}
            hint="Leave blank to use the indicative rate. Set it if your sub-registrar quotes something different."
          />
        </div>

        <div>
          <div style={{ ...card, background: C.navy, color: 'white', border: 'none' }}>
            <div style={{ fontSize: 12.5, opacity: 0.75, marginBottom: 4 }}>Payable to the government</div>
            <div style={{ fontSize: 42, fontWeight: 700, fontFamily: "'Fraunces',Georgia,serif", letterSpacing: '-0.03em', lineHeight: 1.05 }}>
              {inr(r.govt)}
            </div>
            <div style={{ fontSize: 13.5, opacity: 0.85, marginTop: 6 }}>
              {pct(r.pctOfPrice)} of the sale price · stamp duty at {pct(r.rate, 2)}
            </div>

            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,.18)', display: 'grid', gap: 11, fontSize: 13.5 }}>
              <Row label="Charged on" value={inr(r.base)} />
              <Row label="Stamp duty" value={inr(r.duty)} />
              <Row label={`Registration (${STATES[state].reg}%)`} value={inr(r.reg)} />
              {r.capped && (
                <Row label="— capped, saving" value={'− ' + inr(r.regUncapped - r.reg)} />
              )}
              <Row label="Stamp duty + registration" value={inr(r.govt)} strong />
              {r.tdsApplies && <Row label="TDS u/s 194-IA (1%)" value={inr(r.tds)} />}
              <Row label="Total due at registration" value={inr(r.total)} strong />
            </div>
          </div>

          {r.usingCircle && (
            <div style={{ ...card, marginTop: 14, background: '#FFF8E6', borderColor: '#F0D493' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#7A5B10', marginBottom: 5 }}>Circle rate is higher than your price</div>
              <div style={{ fontSize: 13.5, color: '#6B5213', lineHeight: 1.65 }}>
                Duty is being charged on {inr(r.base)}, not on the {inr(num(price))} you are paying.
                The difference may also be taxable in your hands under section 56(2)(x).
              </div>
            </div>
          )}

          {r.femaleSaving > 0 && (
            <div style={{ ...card, marginTop: 14, background: '#F0F7F2', borderColor: '#BFE0CC' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0F5B30', marginBottom: 5 }}>
                Registering in a woman's name would save {inr(r.femaleSaving)}
              </div>
              <div style={{ fontSize: 13.5, color: '#14492C', lineHeight: 1.65 }}>
                {state.split(' — ')[0]} charges a lower rate for female buyers. The concession usually
                requires the property to be registered solely in her name.
              </div>
            </div>
          )}

          <div style={{ ...card, marginTop: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 5 }}>Section 80C</div>
            <div style={{ fontSize: 13.5, color: C.body, lineHeight: 1.65 }}>
              Up to {inr(r.deductible)} of this is deductible under section 80C in the year of
              payment — old tax regime only, and subject to the overall ₹1.5 lakh 80C ceiling you
              may already be using.
            </div>
          </div>
        </div>
      </div>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 22, fontFamily: "'Fraunces',Georgia,serif", color: C.ink, marginBottom: 12 }}>
          How stamp duty is calculated
        </h2>
        <pre style={{ ...card, background: C.soft, fontSize: 13.5, overflowX: 'auto', margin: '0 0 14px', lineHeight: 1.7 }}>
{`base        = max(agreed sale price, circle rate)
stamp duty  = base × state rate
registration = base × state registration rate   (capped in some states)
TDS         = 1% of sale price, if price ≥ ₹50 lakh`}
        </pre>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '66ch' }}>
          Three things catch buyers out. The duty is charged on the <strong>higher</strong> of your
          price and the circle rate, so a below-circle bargain does not reduce it. Registration is{' '}
          <strong>capped</strong> in some states — ₹30,000 in Maharashtra, ₹15,000 in Karnataka —
          which matters a great deal on an expensive property, while Tamil Nadu charges 4% with no
          cap at all. And stamp duty generally <strong>cannot be added to your home loan</strong>;
          it has to be found in cash on the day.
        </p>

        <div style={{ ...card, background: '#FFF8E6', borderColor: '#F0D493', marginTop: 18 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: '#7A5B10', marginBottom: 6 }}>About these rates</div>
          <div style={{ fontSize: 14, color: '#6B5213', lineHeight: 1.7 }}>
            Rates are indicative for 2026 and are set by each state, changing with budgets and cess
            notifications. Published sources disagree on some of them — Maharashtra in particular,
            where the figure depends on the municipal area and which cesses are counted. Confirm with
            your sub-registrar or the state portal before you transact:{' '}
            <a href={r.portal} target="_blank" rel="noopener noreferrer" style={{ color: C.navy, fontWeight: 600 }}>
              {r.portal.replace('https://', '')}
            </a>. Use the override field if you are quoted a different rate.
          </div>
        </div>
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
    q: 'How is stamp duty calculated in India?',
    a: "Stamp duty is a percentage of the property's assessed value, where the assessed value is the higher of the agreed sale price and the state's circle rate (also called ready-reckoner or guidance value). The percentage is set by each state and typically runs from about 4% to 7.5%. Registration charges, usually around 1%, are added on top and are capped in some states.",
  },
  {
    q: 'What are stamp duty and registration charges in Maharashtra?',
    a: 'Indicatively for 2026, Mumbai is around 6% for male buyers and 5% for female buyers, while Pune, Thane and Nagpur are around 7% and 6%. Rural areas are lower. Registration is 1%, capped at ₹30,000. The precise figure depends on the municipal area and which cesses apply, so confirm with the IGR Maharashtra portal.',
  },
  {
    q: 'Do women pay less stamp duty in India?',
    a: 'In many states, yes. Delhi charges 4% for women against 6% for men, Maharashtra gives a 1% concession, and Haryana, Rajasthan and Uttar Pradesh offer reductions too. Karnataka, Tamil Nadu, Gujarat and West Bengal apply the same rate regardless of gender. The concession normally requires the property to be registered solely in the woman\'s name.',
  },
  {
    q: 'Is stamp duty charged on the sale price or the circle rate?',
    a: 'On whichever is higher. If you buy below the circle rate, duty is still charged on the circle rate, and the difference can additionally be treated as income in your hands under section 56(2)(x) of the Income Tax Act.',
  },
  {
    q: 'Can stamp duty be included in a home loan?',
    a: 'Usually not. Most lenders calculate the loan against the property value and exclude stamp duty and registration, so these must be paid from your own funds at registration. Budget them as cash required on the day, not as part of the financed amount.',
  },
  {
    q: 'Is stamp duty tax deductible?',
    a: 'Stamp duty and registration charges on a residential property can be claimed under section 80C, up to the overall ₹1.5 lakh limit, in the financial year in which they are paid. This is available under the old tax regime only, and shares the ceiling with other 80C items such as EPF, PPF and life insurance premiums.',
  },
]

const RELATED = [
  { to: '/tools/rental-yield-calculator', label: 'Rental yield calculator', note: 'feed these costs in as acquisition cost' },
  { to: '/tools/fractional-investment-calculator', label: 'Fractional investment calculator', note: 'what a part-share returns' },
  { to: '/learn/what-is-demat-2', label: 'What is Demat 2.0?', note: 'how digital settlement changes transfers' },
]
