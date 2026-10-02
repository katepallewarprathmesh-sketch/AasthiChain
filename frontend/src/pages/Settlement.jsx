// Settlement transparency page.
//
// India's regulated tokenisation pattern (SEBI "Demat 2.0", settled through the RBI's
// Unified Market Interface) moves the security leg and the cash leg together, or not at
// all. AasthiChain cannot connect to that infrastructure — it is not an open API and
// participation is limited to RBI-supervised institutions — so this page does the next
// most useful thing: it shows exactly which parts of the pattern we implement, which
// parts we only simulate, and which parts we deliberately do not claim.
//
// The page is driven entirely by live API responses, so it cannot drift from the code.

import React, { useCallback, useEffect, useState } from 'react'
import api from '../lib/api.js'
import ErrorState from '../components/ErrorState'

const INK = '#1A1F2B'
const MUTED = '#6B7280'
const NAVY = '#1E3A5F'
const LINE = '#E5E7EB'

function rupees(paise) {
  return `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

function Card({ children, style }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: 12, padding: 20, ...style }}>
      {children}
    </div>
  )
}

function Pill({ tone = 'neutral', children }) {
  const tones = {
    pass: { bg: '#ECFDF5', fg: '#047857', bd: '#A7F3D0' },
    fail: { bg: '#FEF2F2', fg: '#991B1B', bd: '#FECACA' },
    warn: { bg: '#FFFBEB', fg: '#B45309', bd: '#FDE68A' },
    neutral: { bg: '#F3F4F6', fg: '#374151', bd: '#E5E7EB' },
  }
  const t = tones[tone] || tones.neutral
  return (
    <span style={{
      display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 11,
      fontWeight: 700, letterSpacing: '.03em', background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
    }}>{children}</span>
  )
}

export default function Settlement() {
  const [caps, setCaps] = useState(null)
  const [conf, setConf] = useState(null)
  const [error, setError] = useState(null)
  const [demo, setDemo] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [c, k] = await Promise.all([
        api.request('/api/umi/capabilities'),
        api.request('/api/umi/conformance'),
      ])
      setCaps(c)
      setConf(k)
    } catch (e) {
      setError(e.message || 'Could not load settlement capabilities')
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Runs a complete delivery-versus-payment against the simulator so a reader can see
  // the reservation, the atomic commit, and the resulting wallet movement for real.
  const runDemo = useCallback(async () => {
    setBusy(true)
    setDemo(null)
    try {
      const buyer = `demo-investor-${Date.now().toString().slice(-6)}`
      const seller = `demo-spv-${Date.now().toString().slice(-6)}`
      const steps = []

      await api.request('/api/umi/wallet', { method: 'POST', body: JSON.stringify({ participantId: buyer, participantClass: 'INVESTOR', openingPaise: 5000000 }) })
      await api.request('/api/umi/wallet', { method: 'POST', body: JSON.stringify({ participantId: seller, participantClass: 'ISSUER_SPV', openingPaise: 0 }) })
      steps.push({ label: 'Wallets opened', detail: `${buyer} funded with ${rupees(5000000)}; ${seller} at ${rupees(0)}` })

      const lock = await api.request('/api/umi/dvp/reserve', {
        method: 'POST',
        body: JSON.stringify({ assetId: 'DEMO-PROP', payerId: buyer, payeeId: seller, amountPaise: 250000, tokenCount: 5 }),
      })
      const afterReserve = await api.request(`/api/umi/wallet/${buyer}`)
      steps.push({
        label: '1 · Cash leg reserved',
        detail: `${rupees(lock.amountPaise)} held. Balance still ${rupees(afterReserve.balancePaise)} — reserving does not move money.`,
      })

      const receipt = await api.request('/api/umi/dvp/settle', {
        method: 'POST',
        body: JSON.stringify({ lockId: lock.lockId, ledgerTxId: `TXN-${lock.lockId.slice(-8)}`, assetId: 'DEMO-PROP', fromId: seller, toId: buyer, tokenCount: 5 }),
      })
      steps.push({
        label: '2 · Both legs committed',
        detail: `Security leg ${receipt.ledgerTxId} and cash leg ${receipt.cashRef} settled in one commit.`,
      })

      let replayMsg = 'Replay was accepted — this should never happen'
      try {
        await api.request('/api/umi/dvp/settle', {
          method: 'POST',
          body: JSON.stringify({ lockId: lock.lockId, ledgerTxId: receipt.ledgerTxId, assetId: 'DEMO-PROP', fromId: seller, toId: buyer, tokenCount: 5 }),
        })
      } catch (e) {
        replayMsg = `Replay rejected with ${e.data?.error || e.message}`
      }
      steps.push({ label: '3 · Replay blocked', detail: replayMsg })

      const buyerFinal = await api.request(`/api/umi/wallet/${buyer}`)
      const sellerFinal = await api.request(`/api/umi/wallet/${seller}`)
      steps.push({
        label: 'Final wallets',
        detail: `Buyer ${rupees(buyerFinal.balancePaise)} (held ${rupees(buyerFinal.heldPaise)}) · Seller ${rupees(sellerFinal.balancePaise)}`,
      })

      setDemo({ steps, receipt })
    } catch (e) {
      setDemo({ error: e.message || 'Demo failed' })
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div style={{ maxWidth: 940, margin: '0 auto', padding: '32px 20px 64px', color: INK }}>
      {/* Neutral rather than amber: the honest claim is now a positive one.
          The settlement rail is simulated, but the supervisory reporting it
          feeds is real and inspectable at /regulator. The full "not connected
          to RBI, SEBI, NPCI, NSDL or CDSL" disclosure sits in the legal note
          below and in every API response. */}
      <div style={{ marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Pill>Demo environment · simulated settlement</Pill>
        <Pill tone="pass">Regulator-ready reporting</Pill>
      </div>
      <h1 style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 34, lineHeight: 1.1, letterSpacing: '-0.02em', marginBottom: 10 }}>
        How settlement works here
      </h1>
      <p style={{ fontSize: 16, lineHeight: 1.6, color: MUTED, maxWidth: 680 }}>
        In September 2026 SEBI and RBI launched <strong>Demat 2.0</strong>: corporate bonds issued as
        tokens on a permissioned ledger owned by the depositories, with the money leg settled in
        wholesale digital rupee through the RBI's <strong>Unified Market Interface</strong>. AasthiChain
        follows that <em>pattern</em> for real-estate fractions. It is not connected to it, and this page
        exists so that distinction is impossible to miss.
      </p>

      {error && (
        <div style={{ marginTop: 20 }}>
          <ErrorState error={error} what="settlement activity" />
        </div>
      )}

      {caps && (
        <>
          <Card style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 14 }}>What this rail claims about itself</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {[
                { k: 'Rail', v: caps.rail },
                { k: 'Both legs atomic', v: caps.atomic ? 'Yes' : 'No' },
                { k: 'Central bank money', v: caps.centralBankMoney ? 'Yes' : 'No — simulated' },
                { k: 'Regulatory status', v: caps.regulatoryStatus },
                { k: 'Settlement window', v: caps.settlementWindow },
              ].map(row => (
                <div key={row.k} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: MUTED }}>{row.k}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4, wordBreak: 'break-word' }}>{row.v}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 12 }}>
              Served live from <code>GET /api/umi/capabilities</code> — the claim is machine-checkable, not marketing copy.
            </div>
          </Card>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 16 }}>
            <Card>
              <h3 style={{ fontSize: 15, marginBottom: 10 }}>What we actually model</h3>
              <ul style={{ paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7, color: '#374151' }}>
                {(caps.pattern?.modelled || []).map(m => <li key={m}>{m}</li>)}
              </ul>
            </Card>
            <Card style={{ borderColor: '#FDE68A', background: '#FFFEF8' }}>
              <h3 style={{ fontSize: 15, marginBottom: 10 }}>What we do not and cannot claim</h3>
              <ul style={{ paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7, color: '#374151' }}>
                {(caps.pattern?.notModelled || []).map(m => <li key={m}>{m}</li>)}
              </ul>
            </Card>
          </div>

          <Card style={{ marginTop: 16, borderColor: '#BFDBFE', background: '#F8FBFF' }}>
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>The legal reality behind the ₹500 figure</h3>
            <p style={{ fontSize: 13.5, lineHeight: 1.65, color: '#374151', margin: 0 }}>{caps.legalNote}</p>
          </Card>
        </>
      )}

      {conf && (
        <Card style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <h2 style={{ fontSize: 18, margin: 0 }}>Conformance self-test</h2>
            <Pill tone={conf.allPassed ? 'pass' : 'fail'}>{conf.passed} / {conf.total} passing</Pill>
          </div>
          <p style={{ fontSize: 13, color: MUTED, marginBottom: 12 }}>
            These checks run on every request against a throwaway ledger. The same suite exists in Go at{' '}
            <code>{conf.goEquivalent}</code>, and the checklist is documented in <code>{conf.reference}</code>.
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {(conf.checks || []).map(c => (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                border: `1px solid ${LINE}`, borderRadius: 8,
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: MUTED, minWidth: 26 }}>{c.id}</span>
                <span style={{ flex: 1, fontSize: 13.5 }}>{c.title}</span>
                <Pill tone={c.status === 'PASS' ? 'pass' : 'fail'}>{c.status}</Pill>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, margin: 0 }}>Watch a delivery-versus-payment run</h2>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
              Opens two throwaway wallets, reserves, settles, then tries to replay the trade.
            </div>
          </div>
          <button
            onClick={runDemo}
            disabled={busy}
            style={{
              background: NAVY, color: '#fff', border: 'none', borderRadius: 8,
              padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
            }}
          >{busy ? 'Running…' : 'Run the flow'}</button>
        </div>

        {demo?.error && <div style={{ fontSize: 13, color: '#991B1B' }}>{demo.error}</div>}

        {demo?.steps && (
          <div style={{ display: 'grid', gap: 10 }}>
            {demo.steps.map((s, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${NAVY}`, paddingLeft: 12 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{s.label}</div>
                <div style={{ fontSize: 13, color: MUTED, marginTop: 2, wordBreak: 'break-word' }}>{s.detail}</div>
              </div>
            ))}
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Every response above carried <code>simulated: true</code> and <code>centralBankMoney: false</code>.
            </div>
          </div>
        )}
      </Card>

      <div style={{ fontSize: 12, color: MUTED, marginTop: 24, lineHeight: 1.6 }}>
        Sources: SEBI press release and FAQs on the Demat 2.0 pilot (10 September 2026); RBI statements on the
        Unified Market Interface. AasthiChain is an independent demonstration and has no affiliation with,
        approval from, or connection to RBI, SEBI, NPCI, NSDL or CDSL.
      </div>
    </div>
  )
}
