// Shared layout for the /learn explainer articles.
//
// These are the pages meant to be cited: clear explanations of Demat 2.0,
// UMI and atomic DvP, each next to a live demo of the thing it describes.
// Nobody else explaining these concepts has a working demonstration beside
// the text, which is the only durable advantage this project has in search.

import React from 'react'
import { Link } from 'react-router-dom'
import { C, card } from '../tools/ToolShell'

export function H2({ id, children }) {
  return (
    <h2 id={id} style={{ fontSize: 25, fontFamily: "'Fraunces',Georgia,serif", color: C.ink, margin: '34px 0 12px', letterSpacing: '-0.015em', lineHeight: 1.2 }}>
      {children}
    </h2>
  )
}

export function H3({ children }) {
  return (
    <h3 style={{ fontSize: 17.5, fontWeight: 700, color: C.ink, margin: '24px 0 8px' }}>{children}</h3>
  )
}

export function P({ children }) {
  return (
    <p style={{ fontSize: 16.5, color: C.body, lineHeight: 1.8, margin: '0 0 15px', maxWidth: '68ch' }}>{children}</p>
  )
}

export function UL({ children }) {
  return (
    <ul style={{ fontSize: 16.5, color: C.body, lineHeight: 1.9, margin: '0 0 15px', paddingLeft: 22, maxWidth: '68ch' }}>{children}</ul>
  )
}

export function Callout({ title, children, tone = 'navy' }) {
  const tones = {
    navy: { bg: '#F2F6FB', border: '#C9DCF0', head: '#1E3A5F', body: '#2A4A6B' },
    warn: { bg: '#FFF8E6', border: '#F0D493', head: '#7A5B10', body: '#6B5213' },
  }
  const t = tones[tone] || tones.navy
  return (
    <div style={{ ...card, background: t.bg, borderColor: t.border, margin: '22px 0' }}>
      {title && <div style={{ fontSize: 15.5, fontWeight: 700, color: t.head, marginBottom: 7 }}>{title}</div>}
      <div style={{ fontSize: 15, color: t.body, lineHeight: 1.72 }}>{children}</div>
    </div>
  )
}

// A link to the running demonstration of whatever was just explained. This is
// the pattern the whole content strategy rests on: explain it, then let the
// reader run it.
export function TryIt({ to, label, children }) {
  return (
    <div style={{ ...card, borderColor: C.accent, borderWidth: 2, margin: '24px 0' }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.accent, marginBottom: 7 }}>
        See it running
      </div>
      <p style={{ fontSize: 15, color: C.body, lineHeight: 1.7, margin: '0 0 12px' }}>{children}</p>
      <Link to={to} style={{ display: 'inline-block', padding: '10px 18px', background: C.navy, color: 'white', borderRadius: 8, fontSize: 14.5, fontWeight: 600, textDecoration: 'none' }}>
        {label} →
      </Link>
    </div>
  )
}

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
    <section style={{ marginTop: 38 }}>
      <h2 style={{ fontSize: 25, fontFamily: "'Fraunces',Georgia,serif", color: C.ink, marginBottom: 16 }}>
        Common questions
      </h2>
      {items.map((f) => (
        <div key={f.q} style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 16.5, fontWeight: 700, color: C.ink, marginBottom: 7 }}>{f.q}</h3>
          <p style={{ fontSize: 15.5, color: C.body, lineHeight: 1.75, margin: 0, maxWidth: '68ch' }}>{f.a}</p>
        </div>
      ))}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />
    </section>
  )
}

export default function ArticleShell({ title, standfirst, updated = '4 October 2026', readingTime, slug, children, faq, related }) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: standfirst,
    datePublished: '2026-10-04',
    dateModified: '2026-10-04',
    author: { '@type': 'Person', name: 'Prathmesh Katepallewar' },
    publisher: { '@type': 'Organization', name: 'AasthiChain' },
    mainEntityOfPage: `https://aasthi-chain.vercel.app/learn/${slug}`,
  }
  return (
    <div style={{ background: C.paper, minHeight: '100vh', padding: '36px 20px 64px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <nav style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>
          <Link to="/" style={{ color: C.navy, textDecoration: 'none' }}>AasthiChain</Link>
          <span style={{ margin: '0 7px' }}>/</span>
          <Link to="/learn" style={{ color: C.navy, textDecoration: 'none' }}>Learn</Link>
        </nav>

        <h1 style={{ fontSize: 'clamp(30px,5vw,44px)', fontFamily: "'Fraunces',Georgia,serif", color: C.ink, lineHeight: 1.1, letterSpacing: '-0.028em', marginBottom: 14 }}>
          {title}
        </h1>
        <p style={{ fontSize: 19, color: C.body, lineHeight: 1.6, maxWidth: '64ch', marginBottom: 12 }}>
          {standfirst}
        </p>
        <p style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
          Updated {updated}{readingTime ? ` · ${readingTime} min read` : ''}
        </p>

        <article>{children}</article>

        {faq && <Faq items={faq} />}

        {related && (
          <section style={{ marginTop: 36, ...card }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 10 }}>Read next</h2>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 15, color: C.body, lineHeight: 1.95 }}>
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
          AasthiChain is an independent open-source demonstration. It is not affiliated with the
          Reserve Bank of India, SEBI, any depository or any exchange, and the settlement features
          described here are simulations built for learning.
        </p>

        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />
      </div>
    </div>
  )
}
