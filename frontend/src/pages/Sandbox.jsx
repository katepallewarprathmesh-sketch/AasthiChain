import React from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { PROPOSAL, FRICTION, SCOPE, FAILURE_MODES, LEARNING } from '../lib/sandboxProposal.js'

/**
 * The sandbox submission, on screen.
 *
 * WHY THIS PAGE EXISTS
 * Everything needed for a cohort application was already true of this system
 * and scattered across a dozen places: the friction in a pitch deck, the
 * scope in nobody's head, the failure modes spread between code comments and
 * internal notes, and the honest gaps mentioned only when someone asked the
 * right question. A reader deciding whether to take us seriously had no
 * single thing to read.
 *
 * The page renders frontend/src/lib/sandboxProposal.js, which is also what
 * generates docs/SANDBOX_PROPOSAL.md. One source, so the screen and the
 * document cannot drift apart, and tests/sandbox.test.mjs fails if they do.
 *
 * The deliberate editorial choice here is the failure-mode section. Two of
 * the entries say NOT IMPLEMENTED, in the same type as the rest, above the
 * fold of their own card. Hiding them would make the page more impressive
 * and the submission worse: the first thing a regulator looks for is the
 * thing the applicant did not mention.
 */

export default function Sandbox() {
  const open = FAILURE_MODES.filter(f => !f.implemented)

  return (
    <PageShell
      eyebrow="Regulatory sandbox"
      title={PROPOSAL.title}
      lede={PROPOSAL.summary}
      badge={<Tag tone="sim">{PROPOSAL.status}</Tag>}
      actions={
        <a className="pg-btn" href="https://github.com/katepallewarprathmesh-sketch/AasthiChain/blob/main/docs/SANDBOX_PROPOSAL.md" target="_blank" rel="noreferrer">
          Read it as a document
        </a>
      }
    >
      <Card>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: '#374151' }}>
          A sandbox exists to create regulatory clarity, not to demonstrate that software runs. Four
          things carry the weight, and they are the four sections below: the specific friction, a
          scope small enough that reversing it is uninteresting, the failure modes stated before
          anyone asks, and what will have been learned either way.
        </p>
      </Card>

      {/* 1 */}
      <Card title="1 · The friction" sub={FRICTION.statement}>
        <div style={{ display: 'grid', gap: 10 }}>
          {FRICTION.evidence.map((e, i) => (
            <div key={i} style={{ borderLeft: '2px solid #E5E7EB', paddingLeft: 12 }}>
              <div style={{ fontSize: 13, lineHeight: 1.65, color: '#374151' }}>{e.claim}</div>
              <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 3 }}>{e.source}</div>
            </div>
          ))}
        </div>
        <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.7, color: '#374151' }}>
          <strong>Why this cohort, now.</strong> {FRICTION.whyNow}
        </p>
      </Card>

      {/* 2 */}
      <Card title="2 · Scope, and how it is contained" sub={SCOPE.statement}>
        <div style={{ display: 'grid', gap: 6 }}>
          {SCOPE.bounds.map(b => (
            <div
              key={b.bound}
              style={{
                display: 'grid', gridTemplateColumns: 'minmax(min(100%, 120px), 150px) 1fr', gap: 12,
                alignItems: 'start', border: '1px solid #E5E7EB', borderRadius: 10, padding: '9px 12px',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: '#111827', minWidth: 0 }}>{b.bound}</div>
              <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.55, minWidth: 0 }}>{b.value}</div>
            </div>
          ))}
        </div>
        <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.7, color: '#374151' }}>
          <strong>Reversibility.</strong> {SCOPE.reversibility}
        </p>
      </Card>

      {/* 3. The section that decides whether the rest is believed. */}
      <Card
        title="3 · Failure modes, stated before being asked"
        sub="What goes wrong, what it looks like from outside, and what is built today. The open ones are listed in the same type as the rest."
        right={<Tag tone={open.length ? 'bad' : 'live'}>{open.length} open</Tag>}
      >
        <div style={{ display: 'grid', gap: 10 }}>
          {FAILURE_MODES.map(f => (
            <div
              key={f.mode}
              style={{
                border: '1px solid #E5E7EB', borderRadius: 10, padding: '11px 13px',
                background: f.implemented ? 'white' : '#FEFCE8',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: '#111827', minWidth: 0 }}>{f.mode}</div>
                <Tag tone={f.implemented ? 'live' : 'bad'}>{f.implemented ? 'contained' : 'open'}</Tag>
              </div>
              <p style={{ margin: '7px 0 0', fontSize: 12.5, color: '#6B7280', lineHeight: 1.6 }}>
                <strong style={{ color: '#4B5563' }}>Symptom.</strong> {f.symptom}
              </p>
              <p style={{ margin: '6px 0 0', fontSize: 12.5, color: '#374151', lineHeight: 1.65 }}>
                <strong>Today.</strong> {f.containment}
              </p>
              <div className="pg-mono" style={{ fontSize: 11, color: '#6B7280', marginTop: 7, overflowWrap: 'anywhere' }}>
                {f.file} · {f.test}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* 4 */}
      <Card title="4 · What the cohort would establish" sub={LEARNING.question}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#111827', marginBottom: 8 }}>Measured by</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.75, color: '#374151' }}>
          {LEARNING.measures.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
        <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.7, color: '#374151' }}>
          <strong>A negative result is still a result.</strong> {LEARNING.negativeResult}
        </p>
      </Card>

      <Card title="What is not being claimed" sub="Stated here rather than discovered later.">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.75, color: '#374151' }}>
          {LEARNING.notAsking.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </Card>
    </PageShell>
  )
}
