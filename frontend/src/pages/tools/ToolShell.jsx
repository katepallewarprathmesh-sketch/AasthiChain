// Shared layout for the public /tools/* pages.
//
// These pages exist to be found in search: no login, no API calls, every
// calculation client-side. That means they render identically for a crawler
// and a person, which is exactly what we want.
//
// Structure follows the SEO basics: one H1, H2 per section, real explanatory
// copy under the calculator (a bare widget with no text ranks for nothing),
// and FAQ schema so the questions can surface directly in results.

import React from 'react'
import { Link } from 'react-router-dom'

export const C = {
  paper: '#F7F5F0',
  navy: '#1E3A5F',
  ink: '#111827',
  body: '#374151',
  muted: '#6B7280',
  line: '#E5E7EB',
  soft: '#F9FAFB',
  accent: '#5E9DD6',
  good: '#0F7B3E',
}

export const card = {
  background: 'white',
  border: `1px solid ${C.line}`,
  borderRadius: 12,
  padding: 20,
}

// Indian-format currency: ₹12,34,567 rather than ₹1,234,567.
export function inr(n, decimals = 0) {
  if (!isFinite(n)) return '—'
  return '₹' + Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export function pct(n, decimals = 2) {
  if (!isFinite(n)) return '—'
  return Number(n).toFixed(decimals) + '%'
}

// Number field that stays usable while being typed into: the raw string is
// kept in state by the parent, so clearing the box does not snap back to 0.
export function Field({ label, value, onChange, suffix, prefix, hint, min = 0, step = 'any' }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 6 }}>
        {label}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', border: `1px solid ${C.line}`, borderRadius: 8, background: 'white', overflow: 'hidden' }}>
        {prefix && (
          <span style={{ padding: '0 10px', color: C.muted, fontSize: 14, background: C.soft, alignSelf: 'stretch', display: 'flex', alignItems: 'center', borderRight: `1px solid ${C.line}` }}>
            {prefix}
          </span>
        )}
        <input
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, border: 'none', outline: 'none', padding: '10px 12px', fontSize: 15, color: C.ink, width: '100%', fontFamily: 'inherit' }}
        />
        {suffix && (
          <span style={{ padding: '0 10px', color: C.muted, fontSize: 14, background: C.soft, alignSelf: 'stretch', display: 'flex', alignItems: 'center', borderLeft: `1px solid ${C.line}` }}>
            {suffix}
          </span>
        )}
      </span>
      {hint && <span style={{ display: 'block', fontSize: 12, color: C.muted, marginTop: 5, lineHeight: 1.5 }}>{hint}</span>}
    </label>
  )
}

export function Stat({ label, value, big, tone }) {
  return (
    <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{
        fontSize: big ? 28 : 18,
        fontWeight: 700,
        color: tone === 'good' ? C.good : C.navy,
        fontFamily: big ? "'Fraunces',Georgia,serif" : 'inherit',
        letterSpacing: big ? '-0.02em' : 0,
      }}>
        {value}
      </div>
    </div>
  )
}

// FAQ block + matching JSON-LD. The schema lets the answers appear directly
// in search results, which is most of the value of having an FAQ at all.
export function Faq({ items }) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  }
  return (
    <section style={{ marginTop: 36 }}>
      <h2 style={{ fontSize: 22, fontFamily: "'Fraunces',Georgia,serif", color: C.ink, marginBottom: 14 }}>
        Frequently asked questions
      </h2>
      {items.map((f) => (
        <div key={f.q} style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 15.5, fontWeight: 700, color: C.ink, marginBottom: 6 }}>{f.q}</h3>
          <p style={{ fontSize: 14.5, color: C.body, lineHeight: 1.7, margin: 0 }}>{f.a}</p>
        </div>
      ))}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />
    </section>
  )
}

export default function ToolShell({ title, tagline, children, faq, related }) {
  return (
    <div style={{ background: C.paper, minHeight: '100vh', padding: '36px 20px 64px' }}>
      <div style={{ maxWidth: 940, margin: '0 auto' }}>
        <nav style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>
          <Link to="/" style={{ color: C.navy, textDecoration: 'none' }}>AasthiChain</Link>
          <span style={{ margin: '0 7px' }}>/</span>
          <Link to="/tools" style={{ color: C.navy, textDecoration: 'none' }}>Free tools</Link>
          <span style={{ margin: '0 7px' }}>/</span>
          <span>{title}</span>
        </nav>

        <h1 style={{ fontSize: 'clamp(28px,4.5vw,40px)', fontFamily: "'Fraunces',Georgia,serif", color: C.ink, lineHeight: 1.12, letterSpacing: '-0.025em', marginBottom: 12 }}>
          {title}
        </h1>
        <p style={{ fontSize: 17, color: C.body, lineHeight: 1.65, maxWidth: '62ch', marginBottom: 28 }}>
          {tagline}
        </p>

        {children}

        {faq && <Faq items={faq} />}

        {related && (
          <section style={{ marginTop: 36, padding: 20, background: 'white', border: `1px solid ${C.line}`, borderRadius: 12 }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 10 }}>Keep exploring</h2>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14.5, color: C.body, lineHeight: 1.9 }}>
              {related.map((r) => (
                <li key={r.to}>
                  <Link to={r.to} style={{ color: C.navy, fontWeight: 600 }}>{r.label}</Link>
                  {r.note && <span style={{ color: C.muted }}> — {r.note}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <p style={{ marginTop: 28, fontSize: 12.5, color: C.muted, lineHeight: 1.65, maxWidth: '70ch' }}>
          This calculator is for education and estimation only. It is not investment advice.
          AasthiChain is a demonstration of settlement technology and does not offer real
          investments.
        </p>
      </div>
    </div>
  )
}
