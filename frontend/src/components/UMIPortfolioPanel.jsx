// Investor-side view of the UMI settlement rail.
//
// The Wallet page already covers holdings, NAV and loans. What it could not
// show was the cash leg: the investor's wholesale CBDC (e₹-W) wallet, the
// settlement instructions they were party to, and the permanent ledger block
// each one produced. That is what this panel adds.
//
// Everything here is read-only and derived from the Go rail — no UMI logic in
// the browser. If the rail is down the panel degrades to a quiet notice and the
// rest of the wallet page is unaffected.

import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'

const money = n => '₹' + Number(n || 0).toLocaleString('en-IN')

const STATUS = {
  SETTLED: { bg: '#ECFDF5', border: '#A7F3D0', color: '#065F46', label: 'Settled' },
  FAILED: { bg: '#FEF2F2', border: '#FECACA', color: '#991B1B', label: 'Failed' },
  CREATED: { bg: '#F1F5F9', border: '#E2E8F0', color: '#475569', label: 'Created' },
  MATCHED: { bg: '#EFF6FF', border: '#BFDBFE', color: '#1D4ED8', label: 'Matched' },
  LOCKED: { bg: '#FFFBEB', border: '#FDE68A', color: '#92400E', label: 'Locked' }
}

const card = { background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 24, minWidth: 0 }

export default function UMIPortfolioPanel({ identityId }) {
  const [wallet, setWallet] = useState(null)
  const [rows, setRows] = useState([])
  const [state, setState] = useState('loading') // loading | ok | offline
  const [open, setOpen] = useState(null)

  const load = useCallback(async () => {
    try {
      // allSettled: one unavailable endpoint should not blank the other panel.
      const [wR, iR] = await Promise.allSettled([api.umiWallets(), api.umiInstructions()])
      if (wR.status === 'rejected' && iR.status === 'rejected') throw (wR.reason || iR.reason)
      const w = wR.status === 'fulfilled' ? wR.value : { wallets: [] }
      const ins = iR.status === 'fulfilled' ? iR.value : { instructions: [] }
      if (w && w.error) throw new Error(w.message || w.error)
      setWallet((w.wallets || []).find(x => x.participant === identityId) || null)
      const mine = (ins.instructions || [])
        .filter(i => i.buyer === identityId || i.seller === identityId)
        .reverse()
      setRows(mine)
      setState('ok')
    } catch {
      setState('offline')
    }
  }, [identityId])

  useEffect(() => { load() }, [load])

  if (state === 'loading') return null

  if (state === 'offline') {
    return (
      <div style={card}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Settlement &amp; e₹-W</h3>
        <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 6, lineHeight: 1.6 }}>
          The UMI settlement rail is not reachable right now, so your cash-leg view is unavailable.
          Your holdings above are unaffected.
        </p>
      </div>
    )
  }

  const settled = rows.filter(r => r.status === 'SETTLED')
  const bought = settled.filter(r => r.buyer === identityId)
  const sold = settled.filter(r => r.seller === identityId)
  const spent = bought.reduce((s, r) => s + (r.cashINR || 0), 0)
  const received = sold.reduce((s, r) => s + (r.cashINR || 0), 0)

  const stat = (k, v, c) => (
    <div key={k} style={{ flex: 1, minWidth: 120, background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 700 }}>{k}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: c || '#111827', marginTop: 3, overflowWrap: 'anywhere' }}>{v}</div>
    </div>
  )

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: '#9CA3AF', textTransform: 'uppercase' }}>
            UMI · wholesale CBDC settlement
          </div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: '4px 0 0' }}>Settlement &amp; e₹-W</h3>
          <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.6, maxWidth: '62ch' }}>
            The cash leg of every purchase, settled in wholesale central bank digital rupee against
            the token leg — both move together or neither does. Each settlement below is a permanent
            block you can verify yourself.
          </p>
        </div>
        {wallet && (
          <div style={{ textAlign: 'right', minWidth: 0 }}>
            <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 700 }}>e₹-W balance</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#6D28D9', overflowWrap: 'anywhere' }}>{money(wallet.balanceINR)}</div>
            <code style={{ fontSize: 10, color: '#9CA3AF' }}>{wallet.walletId}</code>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        {stat('Settlements', String(settled.length))}
        {stat('Bought', money(spent), '#991B1B')}
        {stat('Received', money(received), '#065F46')}
        {wallet ? stat('Earmarked', money(wallet.reservedINR || 0), '#92400E') : null}
      </div>

      {rows.length === 0 ? (
        <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 14, lineHeight: 1.6 }}>
          No settlements yet for <b>{identityId}</b>. Run one on the{' '}
          <Link to="/umi" style={{ color: '#1E3A5F', fontWeight: 600 }}>UMI settlement page</Link> and it will appear here.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
          {rows.map(r => {
            const st = STATUS[r.status] || STATUS.CREATED
            const side = r.buyer === identityId ? 'Bought' : 'Sold'
            const isOpen = open === r.instructionId
            return (
              <div key={r.instructionId} style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: '11px 13px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999, color: st.color, background: st.bg, border: `1px solid ${st.border}` }}>
                      {st.label}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
                      {side} {Number(r.tokens || 0).toLocaleString('en-IN')} tokens
                    </span>
                    <span style={{ fontSize: 12.5, color: '#374151' }}>
                      for <b>{money(r.cashINR)}</b> in e₹-W
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {r.status === 'SETTLED' && (
                      <Link to="/ledger" title="See this settlement on the permanent ledger"
                        style={{ fontSize: 11.5, color: '#1E3A5F', fontWeight: 600, textDecoration: 'none' }}>
                        block #{r.blockHeight} ↗
                      </Link>
                    )}
                    <button onClick={() => setOpen(isOpen ? null : r.instructionId)}
                      style={{ fontSize: 11.5, padding: '4px 10px', borderRadius: 7, border: '1px solid #E5E7EB', background: 'white', color: '#374151', cursor: 'pointer', fontWeight: 600 }}>
                      {isOpen ? 'Hide trace' : 'Message trace'}
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 5, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                  {r.instructionId} · ISIN {r.isin || '—'} · {r.assetId}
                </div>
                {r.status === 'FAILED' && r.failureReason && (
                  <div style={{ fontSize: 11.5, color: '#991B1B', marginTop: 5 }}>
                    {r.failureReason} — neither leg moved, no partial settlement.
                  </div>
                )}
                {isOpen && (
                  <div style={{ marginTop: 10, borderTop: '1px solid #F3F4F6', paddingTop: 9 }}>
                    <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>
                      ISO 20022 message trace
                    </div>
                    {(r.messages || []).map(m => (
                      <div key={m.seq} style={{ display: 'flex', gap: 8, fontSize: 11.5, color: '#374151', padding: '3px 0', lineHeight: 1.5 }}>
                        <code style={{ color: '#6D28D9', fontWeight: 700, flexShrink: 0 }}>{m.family}</code>
                        <span style={{ overflowWrap: 'anywhere' }}>{m.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
