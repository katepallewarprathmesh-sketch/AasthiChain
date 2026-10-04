import React from 'react'
import { Link } from 'react-router-dom'
import { C, card } from '../tools/ToolShell'

const ARTICLES = [
  {
    to: '/learn/what-is-demat-2',
    name: 'What is Demat 2.0?',
    blurb: "SEBI's sandbox pilot issues corporate bonds as native digital tokens settled against central bank digital currency. What changes, what stays exactly the same, and why bonds went first.",
    time: '8 min',
  },
  {
    to: '/learn/what-is-atomic-dvp',
    name: 'What is atomic DvP settlement?',
    blurb: 'Delivery versus payment, the settlement risk it removes, why "atomic" is a stronger guarantee than DvP alone, and the trade-off nobody mentions.',
    time: '7 min',
  },
  {
    to: '/learn/what-is-umi',
    name: "What is the RBI's Unified Market Interface?",
    blurb: 'The interface connecting tokenised assets to settlement in wholesale CBDC — what it enables, where it has been used, and what is still unsettled.',
    time: '7 min',
  },
]

export default function LearnIndex() {
  return (
    <div style={{ background: C.paper, minHeight: '100vh', padding: '36px 20px 64px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <nav style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>
          <Link to="/" style={{ color: C.navy, textDecoration: 'none' }}>AasthiChain</Link>
          <span style={{ margin: '0 7px' }}>/</span>
          <span>Learn</span>
        </nav>

        <h1 style={{ fontSize: 'clamp(28px,4.5vw,42px)', fontFamily: "'Fraunces',Georgia,serif", color: C.ink, lineHeight: 1.12, letterSpacing: '-0.025em', marginBottom: 12 }}>
          Settlement, explained
        </h1>
        <p style={{ fontSize: 17.5, color: C.body, lineHeight: 1.65, maxWidth: '64ch', marginBottom: 30 }}>
          Plain explanations of how tokenised assets settle against central bank money in
          India — each one next to a working demonstration you can run yourself.
        </p>

        <div style={{ display: 'grid', gap: 16 }}>
          {ARTICLES.map((a) => (
            <Link key={a.to} to={a.to} style={{ ...card, textDecoration: 'none', display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <h2 style={{ fontSize: 20, fontFamily: "'Fraunces',Georgia,serif", color: C.navy, margin: 0 }}>{a.name}</h2>
                <span style={{ fontSize: 12.5, color: C.muted }}>{a.time}</span>
              </div>
              <p style={{ fontSize: 15, color: C.body, lineHeight: 1.7, margin: '9px 0 0' }}>{a.blurb}</p>
            </Link>
          ))}
        </div>

        <section style={{ marginTop: 34, ...card }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 10 }}>Try it instead of reading about it</h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 15, color: C.body, lineHeight: 1.95 }}>
            <li><Link to="/umi" style={{ color: C.navy, fontWeight: 600 }}>Run an atomic DvP settlement</Link> — including a deliberate failure</li>
            <li><Link to="/ledger" style={{ color: C.navy, fontWeight: 600 }}>Verify the ledger</Link> — replayed from genesis</li>
            <li><Link to="/tools" style={{ color: C.navy, fontWeight: 600 }}>Free property calculators</Link> — rental yield and fractional returns</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
