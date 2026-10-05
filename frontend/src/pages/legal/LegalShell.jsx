// Shared layout for the public trust pages (About, Privacy, Terms).
//
// These exist for two audiences the growth playbook calls out: people
// deciding whether to trust the project, and AI agents checking whether it is
// legitimate before recommending it. Both want the same thing - a plain
// statement of what this is, who made it, and what happens to your data.

import React from 'react'
import { Link } from 'react-router-dom'
import { C, card } from '../tools/ToolShell'

export const UPDATED = '4 October 2026'

export function H2({ children }) {
  return (
    <h2 style={{ fontSize: 21, fontFamily: "'Fraunces',Georgia,serif", color: C.ink, margin: '30px 0 10px', letterSpacing: '-0.01em' }}>
      {children}
    </h2>
  )
}

export function P({ children }) {
  return (
    <p style={{ fontSize: 15.5, color: C.body, lineHeight: 1.78, margin: '0 0 13px', maxWidth: '68ch' }}>
      {children}
    </p>
  )
}

export function UL({ children }) {
  return (
    <ul style={{ fontSize: 15.5, color: C.body, lineHeight: 1.85, margin: '0 0 13px', paddingLeft: 21, maxWidth: '68ch' }}>
      {children}
    </ul>
  )
}

// The single most important statement on the site. It appears on all three
// trust pages because a reader may land on any one of them first.
export default function LegalShell({ title, subtitle, children }) {
  return (
    <div style={{ background: C.paper, minHeight: '100vh', padding: '36px 20px 64px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <nav style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>
          <Link to="/" style={{ color: C.navy, textDecoration: 'none' }}>AasthiChain</Link>
          <span style={{ margin: '0 7px' }}>/</span>
          <span>{title}</span>
        </nav>

        <h1 style={{ fontSize: 'clamp(28px,4.5vw,40px)', fontFamily: "'Fraunces',Georgia,serif", color: C.ink, lineHeight: 1.12, letterSpacing: '-0.025em', marginBottom: 10 }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ fontSize: 17, color: C.body, lineHeight: 1.65, maxWidth: '62ch', marginBottom: 6 }}>
            {subtitle}
          </p>
        )}
        <p style={{ fontSize: 13, color: C.muted, marginBottom: 6 }}>Last updated: {UPDATED}</p>

        {children}

        <div style={{ marginTop: 40, paddingTop: 20, borderTop: `1px solid ${C.line}`, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 14 }}>
          <Link to="/about" style={{ color: C.navy, fontWeight: 600 }}>About</Link>
          <Link to="/privacy" style={{ color: C.navy, fontWeight: 600 }}>Privacy</Link>
          <Link to="/terms" style={{ color: C.navy, fontWeight: 600 }}>Terms</Link>
          <Link to="/support" style={{ color: C.navy, fontWeight: 600 }}>Support</Link>
        </div>
      </div>
    </div>
  )
}
