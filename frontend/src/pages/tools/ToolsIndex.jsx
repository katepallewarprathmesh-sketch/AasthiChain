// /tools - hub page for the free calculators.
// Gives the individual tools an internal link with real anchor text, which is
// how search engines work out what each page is about.

import React from 'react'
import { Link } from 'react-router-dom'
import { C, card } from './ToolShell'

const TOOLS = [
  {
    to: '/tools/rental-yield-calculator',
    name: 'Rental Yield Calculator',
    blurb: 'Gross and net rental yield on any property, after maintenance, property tax, insurance and vacancy.',
  },
  {
    to: '/tools/stamp-duty-calculator',
    name: 'Stamp Duty & Registration Calculator',
    blurb: 'What a purchase costs beyond the price, for any Indian state — circle rate, women concessions, registration caps, TDS and the 80C deduction.',
  },
  {
    to: '/tools/fractional-investment-calculator',
    name: 'Fractional Investment Calculator',
    blurb: 'How many tokens your money buys, the ownership share it represents, and what it could be worth years later.',
  },
]

export default function ToolsIndex() {
  return (
    <div style={{ background: C.paper, minHeight: '100vh', padding: '36px 20px 64px' }}>
      <div style={{ maxWidth: 940, margin: '0 auto' }}>
        <nav style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>
          <Link to="/" style={{ color: C.navy, textDecoration: 'none' }}>AasthiChain</Link>
          <span style={{ margin: '0 7px' }}>/</span>
          <span>Free tools</span>
        </nav>

        <h1 style={{ fontSize: 'clamp(28px,4.5vw,40px)', fontFamily: "'Fraunces',Georgia,serif", color: C.ink, lineHeight: 1.12, letterSpacing: '-0.025em', marginBottom: 12 }}>
          Free property investment calculators
        </h1>
        <p style={{ fontSize: 17, color: C.body, lineHeight: 1.65, maxWidth: '62ch', marginBottom: 28 }}>
          No signup, no email, nothing stored. Every calculation runs in your browser.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 18 }}>
          {TOOLS.map((t) => (
            <Link key={t.to} to={t.to} style={{ ...card, textDecoration: 'none', display: 'block' }}>
              <h2 style={{ fontSize: 17.5, fontWeight: 700, color: C.navy, marginBottom: 8 }}>{t.name}</h2>
              <p style={{ fontSize: 14.5, color: C.body, lineHeight: 1.65, margin: 0 }}>{t.blurb}</p>
              <span style={{ display: 'inline-block', marginTop: 12, fontSize: 13.5, fontWeight: 600, color: C.accent }}>
                Open calculator →
              </span>
            </Link>
          ))}
        </div>

        <section style={{ marginTop: 36, ...card }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 10 }}>
            See the settlement technology
          </h2>
          <p style={{ fontSize: 14.5, color: C.body, lineHeight: 1.7, margin: '0 0 10px' }}>
            AasthiChain is a working demonstration of how tokenised property can settle
            against digital rupee, following the pattern of SEBI's Demat 2.0 pilot and the
            RBI's Unified Market Interface.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14.5, color: C.body, lineHeight: 1.9 }}>
            <li><Link to="/umi" style={{ color: C.navy, fontWeight: 600 }}>Atomic DvP settlement demo</Link> — both legs commit together, or neither moves</li>
            <li><Link to="/ledger" style={{ color: C.navy, fontWeight: 600 }}>Ownership ledger explorer</Link> — verify the hash chain block by block</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
