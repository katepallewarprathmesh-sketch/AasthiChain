// Free public tool: capital gains tax on a property sale.
//
// Ranks for "capital gains tax on property sale calculator", "ltcg on
// property calculator", "indexation calculator property". Client-side only.
//
// This one exists because the Finance (No. 2) Act 2024 rewrote the rules on
// 23 July 2024 and a lot of calculators still quietly apply the old 20%
// with indexation to everything. The current position:
//
//   - property held more than 24 months is long term; 24 months or less is
//     short term and taxed at slab rates
//   - the default LTCG rate is 12.5% with NO indexation
//   - grandfathering: a RESIDENT individual or HUF selling property acquired
//     before 23 July 2024 may pay the LOWER of 12.5% unindexed and 20%
//     indexed. NRIs, companies, LLPs and firms do not get this choice
//   - 4% health and education cess sits on top of whichever tax applies
//
// So the useful thing a calculator can do is compute both routes and show
// which one wins, because for an old property bought in a high-inflation
// decade indexation still often wins by lakhs.

import React, { useState, useMemo } from 'react'
import ToolShell, { card, C, Field, inr, pct } from './ToolShell'

const num = (v) => {
  const n = parseFloat(v)
  return isFinite(n) && n >= 0 ? n : 0
}

// Cost Inflation Index, base 2001-02 = 100, as notified by the CBDT.
const CII = {
  '2001-02': 100, '2002-03': 105, '2003-04': 109, '2004-05': 113, '2005-06': 117,
  '2006-07': 122, '2007-08': 129, '2008-09': 137, '2009-10': 148, '2010-11': 167,
  '2011-12': 184, '2012-13': 200, '2013-14': 220, '2014-15': 240, '2015-16': 254,
  '2016-17': 264, '2017-18': 272, '2018-19': 280, '2019-20': 289, '2020-21': 301,
  '2021-22': 317, '2022-23': 331, '2023-24': 348, '2024-25': 363, '2025-26': 376,
}
const FYS = Object.keys(CII)

const CESS = 0.04
const CUTOFF = new Date('2024-07-23') // Finance (No. 2) Act 2024

// Indian financial years run April to March.
function fyOf(dateStr) {
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

// Long-term needs MORE than 24 months, and that is a day-level test: 24
// months plus one day qualifies. Counting whole months and asking for > 24
// silently misclassifies the day after the second anniversary as short term,
// which is the difference between 12.5% and a 30% slab rate.
function isLongTerm(buy, sell) {
  const b = new Date(buy)
  const s = new Date(sell)
  if (isNaN(b) || isNaN(s)) return false
  // setMonth overflows: 29 Feb + 24 months becomes 1 March, which pushes the
  // anniversary a day late and wrongly denies long-term status to a sale on
  // 1 March. Clamp to the last valid day of the target month instead.
  const y = b.getFullYear()
  const m = b.getMonth() + 24
  const lastDay = new Date(y + Math.floor(m / 12), (m % 12) + 1, 0).getDate()
  const anniversary = new Date(y + Math.floor(m / 12), m % 12, Math.min(b.getDate(), lastDay))
  return s > anniversary
}

function monthsBetween(a, b) {
  const d1 = new Date(a)
  const d2 = new Date(b)
  if (isNaN(d1) || isNaN(d2)) return 0
  let m = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth())
  if (d2.getDate() < d1.getDate()) m -= 1
  return m
}

export default function CapitalGainsCalculator() {
  const [buyDate, setBuyDate] = useState('2015-06-15')
  const [buyPrice, setBuyPrice] = useState('3500000')
  const [improve, setImprove] = useState('800000')
  const [improveFY, setImproveFY] = useState('2018-19')
  const [sellDate, setSellDate] = useState('2025-09-01')
  const [sellPrice, setSellPrice] = useState('14000000')
  const [expenses, setExpenses] = useState('280000')
  const [resident, setResident] = useState(true)
  const [slab, setSlab] = useState('30')
  const [reinvest, setReinvest] = useState('0')

  const r = useMemo(() => {
    const sale = num(sellPrice)
    const cost = num(buyPrice)
    const imp = num(improve)
    const exp = num(expenses)
    const held = monthsBetween(buyDate, sellDate)
    const isLong = isLongTerm(buyDate, sellDate)

    const buyFY = fyOf(buyDate)
    const sellFY = fyOf(sellDate)
    const ciiBuy = CII[buyFY] || null
    const ciiSell = CII[sellFY] || CII['2025-26']
    const ciiImp = CII[improveFY] || ciiBuy

    const netSale = Math.max(sale - exp, 0)
    const plainGain = Math.max(netSale - cost - imp, 0)

    // Eligibility for the 20%-with-indexation route.
    const boughtBeforeCutoff = new Date(buyDate) < CUTOFF
    const soldAfterCutoff = new Date(sellDate) >= CUTOFF
    const canIndex = isLong && resident && boughtBeforeCutoff && ciiBuy !== null

    // Route A — the current default.
    const taxA = plainGain * 0.125
    const totalA = taxA * (1 + CESS)

    // Route B — grandfathered, residents only, pre-cutoff purchases.
    let indexedCost = cost
    let indexedImp = imp
    let indexedGain = plainGain
    let taxB = 0
    let totalB = 0
    if (canIndex) {
      indexedCost = (cost * ciiSell) / ciiBuy
      indexedImp = imp > 0 ? (imp * ciiSell) / (ciiImp || ciiBuy) : 0
      indexedGain = Math.max(netSale - indexedCost - indexedImp, 0)
      taxB = indexedGain * 0.2
      totalB = taxB * (1 + CESS)
    }

    // Short term: the gain is added to income and taxed at the slab rate.
    const stcgTax = plainGain * (num(slab) / 100)
    const stcgTotal = stcgTax * (1 + CESS)

    const bestIsIndexed = canIndex && totalB < totalA
    const ltcgPayable = canIndex ? Math.min(totalA, totalB) : totalA
    const payable = isLong ? ltcgPayable : stcgTotal

    // Section 54: reinvesting the GAIN in a residential property exempts it
    // proportionately, capped at ₹10 crore of gain.
    const reinvested = Math.min(num(reinvest), plainGain)
    const exemptShare = plainGain > 0 ? Math.min(reinvested / plainGain, 1) : 0
    const afterRelief = payable * (1 - exemptShare)

    return {
      held, isLong, buyFY, sellFY, ciiBuy, ciiSell, ciiImp,
      netSale, plainGain, indexedCost, indexedImp, indexedGain,
      canIndex, boughtBeforeCutoff, soldAfterCutoff,
      taxA, totalA, taxB, totalB, bestIsIndexed, stcgTotal,
      payable, afterRelief, saving: canIndex ? Math.abs(totalA - totalB) : 0,
      netInHand: netSale - cost - imp - afterRelief + 0,
      effective: plainGain > 0 ? (afterRelief / plainGain) * 100 : 0,
      reinvested, exemptShare,
    }
  }, [buyDate, buyPrice, improve, improveFY, sellDate, sellPrice, expenses, resident, slab, reinvest])

  return (
    <ToolShell
      title="Capital gains tax calculator for property"
      tagline="What you owe when you sell, under the rules as rewritten on 23 July 2024 — computing both the 12.5% route and the grandfathered 20%-with-indexation route, and showing which one is cheaper."
      faq={FAQ}
      related={RELATED}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(290px,1fr))', gap: 20, alignItems: 'start' }}>
        <div style={card}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 16 }}>Purchase</h2>
          <label style={lbl}>
            <span style={lblText}>Date of purchase</span>
            <input type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} style={inp} />
            <span style={hint}>
              {r.buyFY ? `FY ${r.buyFY}${r.ciiBuy ? ` · CII ${r.ciiBuy}` : ' · before the CII base year'}` : ''}
              {r.boughtBeforeCutoff ? ' · before 23 Jul 2024, so indexation may apply' : ' · on or after 23 Jul 2024, no indexation option'}
            </span>
          </label>
          <Field label="Purchase price" prefix="₹" value={buyPrice} onChange={setBuyPrice} />
          <Field label="Cost of improvement" prefix="₹" value={improve} onChange={setImprove}
            hint="Capital additions only — a new floor or room, not repainting or routine repairs" />
          {num(improve) > 0 && (
            <label style={lbl}>
              <span style={lblText}>Year the improvement was made</span>
              <select value={improveFY} onChange={(e) => setImproveFY(e.target.value)} style={inp}>
                {FYS.map((f) => <option key={f} value={f}>{f} (CII {CII[f]})</option>)}
              </select>
              <span style={hint}>Improvements are indexed from their own year, not the purchase year</span>
            </label>
          )}

          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, margin: '22px 0 16px' }}>Sale</h2>
          <label style={lbl}>
            <span style={lblText}>Date of sale</span>
            <input type="date" value={sellDate} onChange={(e) => setSellDate(e.target.value)} style={inp} />
            <span style={hint}>{r.sellFY ? `FY ${r.sellFY} · CII ${r.ciiSell}` : ''}</span>
          </label>
          <Field label="Sale price" prefix="₹" value={sellPrice} onChange={setSellPrice} />
          <Field label="Transfer expenses" prefix="₹" value={expenses} onChange={setExpenses}
            hint="Brokerage, legal fees, stamp paper on the sale deed — all deductible" />

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={resident} onChange={(e) => setResident(e.target.checked)} style={{ marginTop: 3 }} />
            <span style={{ fontSize: 13.5, color: C.body, lineHeight: 1.5 }}>
              Seller is a <b>resident individual or HUF</b>
              <span style={{ color: C.muted }}> — NRIs, companies, LLPs and firms get no indexation option</span>
            </span>
          </label>
        </div>

        <div>
          <div style={card}>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 14 }}>What you owe</h2>

            <div style={{
              padding: '10px 13px', borderRadius: 8, marginBottom: 14, fontSize: 13, lineHeight: 1.6,
              background: r.isLong ? '#F0FDF4' : '#FFFBEB',
              border: `1px solid ${r.isLong ? '#BBF7D0' : '#FDE68A'}`,
              color: r.isLong ? '#065F46' : '#92400E',
            }}>
              Held <b>{r.held} months</b> — {r.isLong
                ? 'long term (over 24 months), so concessional rates apply.'
                : <>short term (24 months or less). The whole gain is added to your income and taxed at your slab rate. Holding to {24 - r.held} more month{24 - r.held === 1 ? '' : 's'} would change that.</>}
            </div>

            <Row k="Net sale consideration" v={inr(r.netSale)} />
            <Row k="Gain before indexation" v={inr(r.plainGain)} strong />

            {r.isLong ? (
              <>
                <div style={{ marginTop: 18, display: 'grid', gap: 10 }}>
                  <Route
                    name="12.5% without indexation"
                    sub="The default since 23 July 2024"
                    gain={r.plainGain}
                    tax={r.totalA}
                    win={!r.bestIsIndexed}
                    available
                  />
                  <Route
                    name="20% with indexation"
                    sub={r.canIndex
                      ? `Indexed cost ${inr(r.indexedCost + r.indexedImp)} using CII ${r.ciiBuy} → ${r.ciiSell}`
                      : !r.resident ? 'Not available — residents only'
                        : !r.boughtBeforeCutoff ? 'Not available — property bought on or after 23 July 2024'
                          : 'Not available'}
                    gain={r.indexedGain}
                    tax={r.totalB}
                    win={r.bestIsIndexed}
                    available={r.canIndex}
                  />
                </div>

                {r.canIndex && (
                  <div style={{ marginTop: 12, padding: 12, background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, fontSize: 13, color: '#1E40AF', lineHeight: 1.65 }}>
                    <b>{r.bestIsIndexed ? 'Indexation wins' : 'The flat 12.5% wins'}</b> for these numbers, by <b>{inr(r.saving)}</b>.
                    You may choose either, asset by asset, when you file. Most sellers of older
                    property never run the comparison and simply overpay.
                  </div>
                )}
              </>
            ) : (
              <div style={{ marginTop: 16 }}>
                <label style={{ fontSize: 13.5, color: C.body, display: 'flex', alignItems: 'center', gap: 8 }}>
                  Your slab rate
                  <select value={slab} onChange={(e) => setSlab(e.target.value)} style={{ ...inp, width: 'auto', padding: '6px 10px' }}>
                    <option value="5">5%</option><option value="20">20%</option><option value="30">30%</option>
                  </select>
                </label>
                <Row k="Tax at slab + 4% cess" v={inr(r.stcgTotal)} strong />
              </div>
            )}

            <div style={{ marginTop: 18, padding: '14px 16px', background: C.navy, borderRadius: 10 }}>
              <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.75)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Tax payable</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: 'white', lineHeight: 1.2, marginTop: 2 }}>{inr(r.afterRelief)}</div>
              <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.8)', marginTop: 3 }}>
                including 4% cess · {pct(r.effective)} of the gain
                {r.exemptShare > 0 && ` · after ${pct(r.exemptShare * 100, 0)} section 54 relief`}
              </div>
            </div>
          </div>

          <div style={{ ...card, marginTop: 20 }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 6 }}>Reinvest to reduce it</h2>
            <p style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.6, marginBottom: 14 }}>
              Section 54 exempts the gain to the extent you put it into another residential
              property, capped at ₹10 crore of gain. Partial reinvestment gives partial relief.
            </p>
            <Field label="Amount reinvested in a residential property" prefix="₹" value={reinvest} onChange={setReinvest}
              hint={r.plainGain > 0 ? `Gain available to shelter: ${inr(r.plainGain)}` : ''} />
            {r.exemptShare > 0 && (
              <div style={{ padding: 11, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, fontSize: 13, color: '#065F46', lineHeight: 1.6 }}>
                Reinvesting {inr(r.reinvested)} shelters {pct(r.exemptShare * 100, 0)} of the gain and
                cuts the tax from {inr(r.payable)} to <b>{inr(r.afterRelief)}</b>.
              </div>
            )}
          </div>
        </div>
      </div>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: C.ink, marginBottom: 12 }}>What changed on 23 July 2024</h2>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '70ch' }}>
          Before that date, long-term gains on property were taxed at 20% after adjusting the
          purchase price for inflation using the Cost Inflation Index. The Finance (No. 2) Act 2024
          replaced that with a flat <b>12.5% and no indexation at all</b>. A lower headline rate,
          but applied to a much larger gain, because decades of inflation are no longer stripped out.
        </p>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '70ch', marginTop: 12 }}>
          After protest, a grandfathering clause was added: a <b>resident individual or HUF</b>
          selling property <b>acquired before 23 July 2024</b> may compute the tax both ways and pay
          whichever is lower. The choice is made per asset at filing. NRIs, companies, LLPs and
          firms were left out and always pay the flat 12.5%.
        </p>
        <p style={{ fontSize: 15, color: C.body, lineHeight: 1.75, maxWidth: '70ch', marginTop: 12 }}>
          Which route wins depends almost entirely on how long you held and how much inflation ran
          in that time. A flat bought in 2005 and sold today usually does far better under
          indexation; one bought in 2022 almost always does better at 12.5%. There is no rule of
          thumb worth trusting here — run both, which is the one thing this page is for.
        </p>
      </section>
    </ToolShell>
  )
}

const lbl = { display: 'block', marginBottom: 14 }
const lblText = { display: 'block', fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 6 }
const inp = {
  width: '100%', padding: '10px 12px', fontSize: 15, color: C.ink, background: 'white',
  border: `1px solid ${C.line}`, borderRadius: 8, fontFamily: 'inherit', outline: 'none',
}
const hint = { display: 'block', fontSize: 12, color: C.muted, marginTop: 5, lineHeight: 1.5 }

function Row({ k, v, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 13.5, color: C.muted }}>{k}</span>
      <span style={{ fontSize: strong ? 15 : 14, fontWeight: strong ? 700 : 600, color: C.ink }}>{v}</span>
    </div>
  )
}

function Route({ name, sub, gain, tax, win, available }) {
  return (
    <div style={{
      padding: 13, borderRadius: 9,
      background: !available ? '#F9FAFB' : win ? '#F0FDF4' : 'white',
      border: `1px solid ${!available ? C.line : win ? '#BBF7D0' : C.line}`,
      opacity: available ? 1 : 0.65,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: available && win ? '#065F46' : C.ink }}>
          {name}{available && win && ' ✓'}
        </span>
        <span style={{ fontSize: 17, fontWeight: 800, color: available && win ? '#065F46' : C.ink }}>
          {available ? inr(tax) : '—'}
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.5 }}>{sub}</div>
      {available && <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>on a gain of {inr(gain)}, including 4% cess</div>}
    </div>
  )
}

const FAQ = [
  {
    q: 'What is the capital gains tax rate on property in India now?',
    a: 'For property sold on or after 23 July 2024 and held for more than 24 months, long-term capital gains are taxed at 12.5% without indexation, plus 4% health and education cess. Property held for 24 months or less is short term, and the gain is added to your income and taxed at your slab rate.',
  },
  {
    q: 'Is indexation still available on property?',
    a: 'Only as a grandfathered choice. A resident individual or HUF selling property acquired before 23 July 2024 may compute the tax both ways — 12.5% on the unindexed gain, or 20% on the indexed gain — and pay whichever is lower. The election is made asset by asset when filing. NRIs, companies, LLPs and firms do not get this option and always pay 12.5% without indexation.',
  },
  {
    q: 'Which is better, 12.5% without indexation or 20% with it?',
    a: 'It depends on how long you held the property and how much inflation occurred. For property bought a decade or more ago, indexation typically inflates the cost enough that 20% on the smaller gain beats 12.5% on the larger one. For recent purchases the flat 12.5% almost always wins. There is no reliable shortcut, which is why both are computed side by side above.',
  },
  {
    q: 'How long must I hold property to get long-term treatment?',
    a: 'More than 24 months from the date of acquisition. At 24 months or less the gain is short term and taxed at your slab rate, which can be 30% plus cess — materially worse than any long-term route. If you are close to the line, the holding period is usually worth waiting out.',
  },
  {
    q: 'How can I avoid capital gains tax on a property sale?',
    a: 'Three legitimate routes. Section 54 exempts the gain to the extent it is reinvested in another residential property, capped at ₹10 crore of gain. Section 54EC allows up to ₹50 lakh into specified bonds within six months, with a five-year lock-in. Section 54F covers reinvesting the net consideration from a non-residential asset into a house. Each has conditions and timelines, so check them before committing.',
  },
  {
    q: 'What expenses can I deduct from the sale price?',
    a: 'Brokerage paid on the sale, legal and documentation charges, and stamp paper costs on the sale deed are all deductible as transfer expenses. Capital improvements — a new room, a new floor, structural work — are deductible as cost of improvement and are indexed from the year they were incurred. Routine repairs, repainting and maintenance are not.',
  },
]

const RELATED = [
  { to: '/tools/stamp-duty-calculator', label: 'Stamp duty calculator', note: 'the cost at the other end of the transaction' },
  { to: '/tools/rental-yield-calculator', label: 'Rental yield calculator', note: 'what the property earned while you held it' },
  { to: '/tools/rent-vs-buy-calculator', label: 'Rent vs buy calculator', note: 'was owning worth it after tax?' },
]
