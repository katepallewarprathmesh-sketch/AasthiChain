// Drunix Ledger Explorer — the blockchain, visible.
// Every settlement (mint / token transfer / escrow release) is a block:
// SHA-512 chained (prevHash) + merkle-committed (txnsRoot). This page replays
// and verifies the chain live, and demonstrates tamper-evidence — the core of
// decentralized trust — with a clearly-labeled SIMULATION.
// The read endpoints are an open layer: no auth, no PII — usable by agents & DPI.

import React, { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import api from '../lib/api.js'

const TYPE_STYLES = {
  GENESIS: { label: 'Genesis', color: '#64748B', bg: '#F1F5F9', border: '#E2E8F0' },
  TOKEN_MINTED: { label: 'Token Minted', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  TOKEN_TRANSFERRED: { label: 'Token Transferred', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  ESCROW_RELEASED: { label: 'Escrow Released', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' }
}

function shortHash(h) { return h ? `${h.slice(0, 10)}…${h.slice(-8)}` : '—' }

function txnSummary(t) {
  if (!t) return ''
  if (t.kind === 'mint') return `${Number(t.totalTokens || 0).toLocaleString('en-IN')} tokens minted → ${t.to} (${t.msp || ''})`
  if (t.kind === 'transfer') return `${Number(t.tokens || 0).toLocaleString('en-IN')} tokens · ${t.from} → ${t.to}${t.atomic ? ` · ${t.atomic}` : ''}`
  if (t.kind === 'escrow-release') return `₹${Number(t.amountINR || 0).toLocaleString('en-IN')} released to seller · ${Number(t.tokens || 0).toLocaleString('en-IN')} tokens · ${t.seller} ⇄ ${t.buyer}`
  if (t.config) return `channel ${t.channel} · ${(t.orgs || []).length} orgs · ${(t.consensus || '').toLowerCase()}`
  return Object.entries(t).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' · ')
}

export default function LedgerExplorer() {
  const location = useLocation()
  const [chain, setChain] = useState(null)
  const [verify, setVerify] = useState(null)
  const [busy, setBusy] = useState(false)
  const [labMsg, setLabMsg] = useState(null)
  const [highlightTx, setHighlightTx] = useState(null)

  const load = useCallback(async () => {
    try {
      const c = await api.getChain(60)
      setChain(c)
      setVerify(await api.verifyChain())
    } catch (e) {
      setLabMsg({ kind: 'err', text: 'Could not reach the ledger API: ' + e.message })
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const tx = new URLSearchParams(location.search).get('tx')
    if (tx) setHighlightTx(tx)
  }, [location.search])

  const runVerify = async () => {
    setBusy(true)
    try { setVerify(await api.verifyChain()); setLabMsg({ kind: 'ok', text: 'Chain replayed from genesis — linkage, merkle roots and hashes recomputed.' }) }
    finally { setBusy(false) }
  }
  const simulateTamper = async () => {
    setBusy(true)
    try {
      const r = await api.tamperChain()
      setLabMsg({ kind: 'warn', text: `SIMULATION: altered block #${r.height} behind the chain's back (txn: ${JSON.stringify(r.altered)}). Now hit "Verify chain" — watch anyone detect it.` })
      setVerify(await api.verifyChain())
      const c = await api.getChain(60); setChain(c)
    } finally { setBusy(false) }
  }
  const restore = async () => {
    setBusy(true)
    try {
      await api.restoreChain(-1)
      setLabMsg({ kind: 'ok', text: 'Restored the original committed contents — the recorded hash matches again.' })
      setVerify(await api.verifyChain())
      const c = await api.getChain(60); setChain(c)
    } finally { setBusy(false) }
  }

  const stats = [
    ['Chain', chain?.chainId || 'aasthi-drunix'],
    ['Height', chain ? `#${chain.height}` : '—'],
    ['Blocks', chain?.blocks ?? '—'],
    ['Hash algo', 'SHA-512'],
    ['Contract', chain?.contract || 'aasthi.dvp-v1'],
    ['Orgs (MSP)', chain?.orgs ? chain.orgs.map(o => o.msp.replace('MSP', '')).join(' · ') : '—'],
  ]

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px 60px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: '#9CA3AF', textTransform: 'uppercase' }}>NPCI Drunix · permissioned network</div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: '#111827', margin: '6px 0 4px' }}>Ledger Explorer</h1>
          <p style={{ fontSize: 13.5, color: '#6B7280', maxWidth: '64ch', lineHeight: 1.6 }}>
            Distributed ledgers and decentralized trust as the open layer for digitization, agents, DPI and programmable finance.
            Every settlement is a block — verify it yourself, no account needed.
          </p>
        </div>
        {verify && (
          <div style={{
            padding: '10px 16px', borderRadius: 10, fontWeight: 700, fontSize: 13,
            background: verify.valid ? '#ECFDF5' : '#FEF2F2',
            border: `1px solid ${verify.valid ? '#A7F3D0' : '#FECACA'}`,
            color: verify.valid ? '#065F46' : '#991B1B'
          }}>
            {verify.valid ? '✓ Chain valid' : `✗ INVALID at #${verify.brokenAt}`} · {verify.blocks} blocks
          </div>
        )}
      </div>

      {/* Stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 18 }}>
        {stats.map(([k, v]) => (
          <div key={k} style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 700 }}>{k}</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827', marginTop: 3, wordBreak: 'break-all' }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Integrity lab */}
      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 18, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#111827' }}>Integrity Lab</div>
            <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 2 }}>Recompute the whole chain from genesis — or prove tamper-evidence live.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={runVerify} disabled={busy} style={{ padding: '9px 14px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Verify chain</button>
            <button onClick={simulateTamper} disabled={busy} title="Demo-only simulation" style={{ padding: '9px 14px', background: 'white', color: '#92400E', border: '1px solid #FDE68A', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>⚠ Simulate tampering (SIMULATION)</button>
            <button onClick={restore} disabled={busy} style={{ padding: '9px 14px', background: 'white', color: '#374151', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Restore &amp; re-verify</button>
          </div>
        </div>
        {labMsg && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all',
            background: labMsg.kind === 'err' ? '#FEF2F2' : labMsg.kind === 'warn' ? '#FFFBEB' : '#F0FDF4',
            border: `1px solid ${labMsg.kind === 'err' ? '#FECACA' : labMsg.kind === 'warn' ? '#FDE68A' : '#BBF7D0'}`,
            color: labMsg.kind === 'err' ? '#991B1B' : labMsg.kind === 'warn' ? '#92400E' : '#065F46'
          }}>
            {verify && !verify.valid && labMsg.kind === 'warn' ? `✗ Chain INVALID at block #${verify.brokenAt} — ${verify.reason} · ${verify.note}` : labMsg.text}
          </div>
        )}
      </div>

      {/* Programmable finance + open layer */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 16 }}>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Programmable finance on-chain</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.6 }}>
            Contract <b>aasthi.dvp-v1</b>: delivery-versus-payment as code — money CONFIRMED ⇄ tokens moved atomically, escrow then RELEASED. Watch any purchase appear as a linked <b>Token Transferred</b> + <b>Escrow Released</b> pair below.
          </div>
          {chain && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {['TOKEN_MINTED', 'TOKEN_TRANSFERRED', 'ESCROW_RELEASED'].map(t => (
                <span key={t} style={{ fontSize: 10.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999, color: TYPE_STYLES[t].color, background: TYPE_STYLES[t].bg, border: `1px solid ${TYPE_STYLES[t].border}` }}>
                  {(chain.blocksList || []).filter(b => b.type === t).length} × {TYPE_STYLES[t].label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>For agents &amp; DPI — open JSON API</div>
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4, marginBottom: 8 }}>No auth, no PII. Machine-readable truth for agents, UPI-stack tooling and public dashboards.</div>
          {[
            ['Verify the chain', 'curl /api/chain/verify'],
            ['Chain head (latest block hash)', 'curl /api/chain/head'],
            ['Full ledger', 'curl "/api/chain?limit=20"'],
            ['Lookup by TXN id', 'curl /api/chain/block/TXN-…-S1'],
          ].map(([label, cmd]) => (
            <div key={cmd} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderBottom: '1px solid #F3F4F6', alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, color: '#374151' }}>{label}</span>
              <code style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#1E3A5F', background: '#F8FAFC', padding: '3px 8px', borderRadius: 6, border: '1px solid #E2E8F0', whiteSpace: 'nowrap' }}>{cmd}</code>
            </div>
          ))}
        </div>
      </div>

      {/* Blocks */}
      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 10 }}>Committed blocks <span style={{ color: '#9CA3AF', fontWeight: 500 }}>(latest first)</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(chain?.blocksList || []).map(b => {
            const st = TYPE_STYLES[b.type] || TYPE_STYLES.GENESIS
            const txHit = highlightTx && (b.txns || []).some(t => Object.values(t).includes(highlightTx))
            return (
              <div key={b.height} style={{
                background: txHit ? '#EFF6FF' : 'white', border: `1px solid ${txHit ? '#93C5FD' : '#E5E7EB'}`, borderRadius: 10, padding: '12px 14px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 13, color: '#111827' }}>#{b.height}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999, color: st.color, background: st.bg, border: `1px solid ${st.border}` }}>{st.label}</span>
                    <span style={{ fontSize: 11.5, color: '#6B7280' }}>{new Date(b.timestamp).toLocaleString('en-IN')}</span>
                  </div>
                  <code style={{ fontSize: 10, fontFamily: 'monospace', color: '#9CA3AF' }}>{shortHash(b.hash)}</code>
                </div>
                <div style={{ fontSize: 12.5, color: '#374151', marginTop: 6 }}>
                  {(b.txns || []).map((t, i) => <div key={i}>{txnSummary(t)}</div>)}
                </div>
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 5, fontFamily: 'monospace' }}>
                  prev: {shortHash(b.prevHash)} · root: {shortHash(b.txnsRoot)}{b.contract ? ` · ${b.contract}` : ''}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
