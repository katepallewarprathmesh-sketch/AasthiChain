// Drunix Ledger Explorer the blockchain, visible.
// Every settlement (mint / token transfer / escrow release) is a block:
// SHA-512 chained (prevHash) + merkle-committed (txnsRoot). This page replays
// and verifies the chain live, and demonstrates tamper-evidence the core of
// decentralized trust with a clearly-labeled SIMULATION.
// The read endpoints are an open layer: no auth, no PII usable by agents & DPI.

import React, { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import api from '../lib/api.js'
import useLedgerStream from '../lib/useLedgerStream.js'

const TYPE_STYLES = {
  GENESIS: { label: 'Genesis', color: '#64748B', bg: '#F1F5F9', border: '#E2E8F0' },
  TOKEN_MINTED: { label: 'Token Minted', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  TOKEN_TRANSFERRED: { label: 'Token Transferred', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  ESCROW_RELEASED: { label: 'Escrow Released', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  // UMI rail (RBI Unified Market Interface / SEBI Demat 2.0 pattern) — additive
  UMI_WALLET_FUNDED: { label: 'UMI · e₹-W Funded', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_ISIN_ASSIGNED: { label: 'UMI · Pilot ISIN', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_DVP_SETTLED: { label: 'UMI · Atomic DvP Settled', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_DVP_FAILED: { label: 'UMI · DvP Failed (no partial)', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_SERVICING_PAID: { label: 'UMI · Servicing Paid', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' }
}

function shortHash(h) { return h ? `${h.slice(0, 10)}…${h.slice(-8)}` : '' }

function txnSummary(t) {
  if (!t) return ''
  if (t.kind === 'mint') return `${Number(t.totalTokens || 0).toLocaleString('en-IN')} tokens minted → ${t.to} (${t.msp || ''})`
  if (t.kind === 'transfer') return `${Number(t.tokens || 0).toLocaleString('en-IN')} tokens · ${t.from} → ${t.to}${t.atomic ? ` · ${t.atomic}` : ''}`
  if (t.kind === 'escrow-release') return `₹${Number(t.amountINR || 0).toLocaleString('en-IN')} released to seller · ${Number(t.tokens || 0).toLocaleString('en-IN')} tokens · ${t.seller} ⇄ ${t.buyer}`
  if (t.kind === 'umi-dvp') return `${Number(t.tokens || (t.securitiesLeg && t.securitiesLeg.tokens) || 0).toLocaleString('en-IN')} tokens ⇄ ₹${Number(t.cashINR || (t.cashLeg && t.cashLeg.amountINR) || 0).toLocaleString('en-IN')} in e₹-W · ${t.status}${t.failureReason ? ' · ' + t.failureReason : ''}`
  if (t.kind === 'umi-funding') return `₹${Number(t.amountINR || 0).toLocaleString('en-IN')} funded into ${t.walletId} (wholesale CBDC)`
  if (t.kind === 'umi-isin') return `pilot ISIN ${t.isin} assigned to ${t.assetId}`
  if (t.kind === 'umi-servicing') return `₹${Number(t.distributedINR || 0).toLocaleString('en-IN')} servicing paid into ${t.holders} CBDC wallet(s)`
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
  // One chain. The old Node demo chain was in-memory and reset on every
  // restart, so showing it next to the durable rail only invited the question
  // of which one was real. This view is the Go settlement chain: append-only,
  // Postgres-backed, replayed and re-verified from genesis at every start.
  const [umi, setUmi] = useState(null)
  // How far back the rendered list reaches. The page used to fetch a single
  // 60-block window and stop, so a 165-block chain showed only its newest 60
  // and there was no way to tell that from the screen.
  const [oldest, setOldest] = useState(0)
  const [more, setMore] = useState(false)

  const load = useCallback(async () => {
    try {
      const WINDOW = 60
      let d = await api.getUmiChain(WINDOW)
      if (d && d.error) throw new Error(d.message || d.error)
      // Older rail builds answer a cursor-less request with the OLDEST blocks,
      // so once the chain outgrew this window the page showed genesis-era
      // history forever and a just-settled purchase never appeared. Ask again
      // with an explicit cursor at the tip, which both the old and the fixed
      // rail honour. Harmless on the fixed rail: it already returns the tail.
      const total = Number(d.totalBlocks || 0)
      const got = Number(d.returned || (d.blocks || []).length)
      if (total > got) {
        const tail = await api.getUmiChain(WINDOW, Math.max(0, total - WINDOW))
        if (tail && !tail.error && (tail.blocks || []).length) d = tail
      }
      setUmi(d)
      // the Go rail returns its blocks oldest-first; this view is latest-first
      setChain({
        chainId: d.chainId, height: d.height, blocks: d.totalBlocks,
        blocksList: [...(d.blocks || [])].reverse(), contract: 'aasthi.umi-v1'
      })
      setOldest(Number(d.from || 0))
      setVerify({ ...d.verification, blocks: d.totalBlocks })
      setLabMsg(null)
    } catch (e) {
      setUmi(null); setChain(null); setVerify(null)
      setLabMsg({ kind: 'err', text: 'UMI settlement rail (Go) not reachable: ' + e.message })
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Reload when the rail says a block landed, rather than on a timer. The
  // hook falls back to polling by itself where the stream cannot open, so
  // this page stays current either way — and says which of the two it is.
  const { mode: liveMode, lastBlock } = useLedgerStream({
    onBlock: () => { load() },
    pollFn: async () => {
      await load()
      return null
    },
  })
  useEffect(() => {
    const tx = new URLSearchParams(location.search).get('tx')
    if (tx) setHighlightTx(tx)
  }, [location.search])


  // Walk further back through the chain, appending older blocks to the list.
  const loadOlder = useCallback(async (span = 60) => {
    if (oldest <= 0) return
    setMore(true)
    try {
      const from = Math.max(0, oldest - span)
      const d = await api.getUmiChain(oldest - from, from)
      if (d && !d.error && (d.blocks || []).length) {
        setChain(c => ({ ...c, blocksList: [...(c?.blocksList || []), ...[...d.blocks].reverse()] }))
        setOldest(from)
      }
    } finally { setMore(false) }
  }, [oldest])

  // A "view this transfer on the ledger" link is useless if the block it
  // points at is older than the window we happened to load. When we arrive
  // with a highlight and cannot see it yet, pull the rest of the chain in.
  useEffect(() => {
    if (!highlightTx || !chain || oldest <= 0 || more) return
    const found = (chain.blocksList || []).some(b =>
      (b.txns || []).some(t => Object.values(t).includes(highlightTx)))
    if (!found) loadOlder(oldest)
  }, [highlightTx, chain, oldest, more, loadOlder])

  const runVerify = async () => {
    setBusy(true)
    try {
      await load()
      setLabMsg({ kind: 'ok', text: 'Chain replayed from genesis — linkage, merkle roots and hashes recomputed by the settlement rail.' })
    } finally { setBusy(false) }
  }

  const stats = [
    ['Chain', chain?.chainId || 'aasthichain'],
    ['Height', chain ? `#${chain.height}` : ''],
    ['Blocks', chain?.blocks ?? ''],
    ['Hash algo', 'SHA-512'],
    ['Storage', umi?.durability?.durable ? 'Postgres · append-only' : 'in-memory'],
    ['Settlement', 'Atomic DvP · e₹-W'],
  ]


  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px 60px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: '#9CA3AF', textTransform: 'uppercase' }}>NPCI Drunix · permissioned network</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: '#111827', margin: '6px 0 4px' }}>Ledger Explorer</h1>
            {/* Say which it is. Claiming "live" on a page that is really
                polling is the kind of small lie that costs trust later. */}
            <span title={liveMode === 'live'
              ? 'Connected to the rail — new blocks arrive as they are committed'
              : liveMode === 'polling'
                ? 'The live stream could not be opened here, so this page refreshes on a timer'
                : 'Checking for a live connection'}
              style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                padding: '3px 9px', borderRadius: 999,
                color: liveMode === 'live' ? '#047857' : '#6B7280',
                background: liveMode === 'live' ? '#ECFDF5' : '#F3F4F6',
                border: `1px solid ${liveMode === 'live' ? '#A7F3D0' : '#E5E7EB'}`,
              }}>
              {liveMode === 'live' ? 'Live' : liveMode === 'polling' ? 'Refreshing' : 'Connecting'}
            </span>
            {lastBlock && liveMode === 'live' && (
              <span style={{ fontSize: 12, color: '#6B7280' }}>
                block #{lastBlock.height} · {lastBlock.type}
              </span>
            )}
          </div>
          <p style={{ fontSize: 13.5, color: '#6B7280', maxWidth: '64ch', lineHeight: 1.6 }}>
            Distributed ledgers and decentralized trust as the open layer for digitization, agents, DPI and programmable finance.
            Every settlement is a block verify it yourself, no account needed.
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


      {/* Banner is shown only when something needs the reader's attention: a
          sealed (tampered) chain, or a non-durable one. The healthy durable
          case says nothing — the Storage stat already states it. */}
      {umi && (umi.durability?.sealed || !umi.durability?.durable || umi.durability?.lastError) && (
        <div style={{
          marginTop: 12, padding: '12px 16px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.6,
          background: umi.durability?.sealed ? '#FEF2F2' : '#FFFBEB',
          border: `1px solid ${umi.durability?.sealed ? '#FECACA' : '#FDE68A'}`,
          color: umi.durability?.sealed ? '#991B1B' : '#92400E'
        }}>
          {umi.durability?.sealed
            ? <><b>Chain sealed.</b> Stored history failed verification at block #{umi.verification?.brokenAt} ({umi.verification?.reason}). The node refuses to append to tampered history and is serving it read-only.</>
            : !umi.durability?.durable
              ? <><b>In-memory ledger.</b> No <code>DATABASE_URL</code> is configured, so these blocks are lost when the service restarts. Set it to make the chain permanent.</>
              : null}
          {umi.durability?.lastError && <div style={{ marginTop: umi.durability?.sealed || !umi.durability?.durable ? 6 : 0 }}><b>Last persistence error:</b> {umi.durability.lastError}</div>}
        </div>
      )}

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
            <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 2 }}>Recompute every block from genesis — linkage, merkle roots and hashes. Tampering with stored blocks is detected here and the rail then refuses to append.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={runVerify} disabled={busy} style={{ padding: '9px 14px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Verify chain</button>
          </div>
        </div>
        {labMsg && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all',
            background: labMsg.kind === 'err' ? '#FEF2F2' : labMsg.kind === 'warn' ? '#FFFBEB' : '#F0FDF4',
            border: `1px solid ${labMsg.kind === 'err' ? '#FECACA' : labMsg.kind === 'warn' ? '#FDE68A' : '#BBF7D0'}`,
            color: labMsg.kind === 'err' ? '#991B1B' : labMsg.kind === 'warn' ? '#92400E' : '#065F46'
          }}>
            {verify && !verify.valid && labMsg.kind === 'warn' ? `✗ Chain INVALID at block #${verify.brokenAt} ${verify.reason} · ${verify.note}` : labMsg.text}
          </div>
        )}
      </div>

      {/* Programmable finance + open layer */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 16 }}>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Programmable finance on-chain</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.6 }}>
            Contract <b>aasthi.umi-dvp-v1</b>: delivery-versus-payment as code — the securities leg and the e₹-W cash leg commit inside a single block, or neither moves. A failed settlement is recorded too, as <b>UMI · DvP Failed</b>, with both legs rolled back.
          </div>
          {chain && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {['UMI_DVP_SETTLED', 'UMI_DVP_FAILED', 'UMI_SERVICING_PAID', 'UMI_ISIN_ASSIGNED'].map(t => (
                <span key={t} style={{ fontSize: 10.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999, color: TYPE_STYLES[t].color, background: TYPE_STYLES[t].bg, border: `1px solid ${TYPE_STYLES[t].border}` }}>
                  {(chain.blocksList || []).filter(b => b.type === t).length} × {TYPE_STYLES[t].label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Open by design</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.6 }}>
            The ledger is a <b>public notice-board, not a private database</b>. Auditors, government stacks, apps or anyone
            can read the same ownership truth at the same moment, with no special access and no personal data on the chain.
            Trust comes from the math, not from taking our word for it.
          </div>
        </div>
      </div>

      {/* Blocks */}
      <div style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Committed blocks <span style={{ color: '#9CA3AF', fontWeight: 500 }}>(latest first)</span></div>
          <div style={{ fontSize: 12, color: '#6B7280' }}>
            showing {(chain?.blocksList || []).length} of {chain?.blocks ?? 0}
            {oldest > 0 ? ` · ${oldest} older block${oldest === 1 ? '' : 's'} not loaded` : ' · whole chain'}
          </div>
        </div>
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
        {oldest > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <button onClick={() => loadOlder(60)} disabled={more}
              style={{ padding: '9px 16px', borderRadius: 9, border: '1px solid #D1D5DB', background: 'white', fontSize: 13, fontWeight: 600, cursor: more ? 'wait' : 'pointer', color: '#111827' }}>
              {more ? 'Loading…' : `Load 60 older blocks`}
            </button>
            <button onClick={() => loadOlder(oldest)} disabled={more}
              style={{ padding: '9px 16px', borderRadius: 9, border: '1px solid #D1D5DB', background: 'white', fontSize: 13, fontWeight: 600, cursor: more ? 'wait' : 'pointer', color: '#374151' }}>
              Load all {oldest} remaining
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
