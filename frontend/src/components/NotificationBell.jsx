import { useState, useEffect, useCallback, useRef } from 'react'
import api from '../lib/api.js'
import useLedgerStream from '../lib/useLedgerStream.js'

// The bell. Two things make this honest rather than decorative:
//
// 1. It refreshes when the ledger says a block landed, so a notification
//    appears because something was committed — not on a timer that happens
//    to be close. Where the stream cannot open, the hook polls instead and
//    this still works, just less promptly.
// 2. The unread count comes from the server, not from local state, so it
//    survives a reload and cannot drift from what actually happened.

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN')

const TONE = {
  BOUGHT: { dot: '#1E3A5F', label: 'Bought' },
  SOLD: { dot: '#047857', label: 'Sold' },
  INCOME: { dot: '#047857', label: 'Income' },
  SETTLEMENT_FAILED: { dot: '#B91C1C', label: 'Failed' },
  OFFER_FILLED: { dot: '#1E3A5F', label: 'Offer' },
}

function ago(iso) {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ago`
  return `${Math.floor(m / 1440)}d ago`
}

export default function NotificationBell({ user, mut = '#6B7280', border = '#E5E7EB' }) {
  const me = (user && user.identityId) || ''
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [unread, setUnread] = useState(0)
  const boxRef = useRef(null)

  const load = useCallback(async () => {
    if (!me) return
    try {
      const d = await api.umiNotifications(me, 20)
      setItems(d.notifications || [])
      setUnread(d.unread || 0)
    } catch {
      // A rail that is down must not break the header.
    }
  }, [me])

  useEffect(() => { load() }, [load])

  // Refresh on commit rather than on a timer.
  useLedgerStream({ onBlock: load, pollFn: async () => { await load(); return null } })

  // Clicking away closes the panel.
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!me) return null

  const clearAll = async () => {
    try {
      await api.umiReadAllNotifications(me)
      await load()
    } catch { /* leave the badge as it was */ }
  }

  const readOne = async (n) => {
    if (n.read) return
    try {
      await api.umiReadNotification(me, n.id)
      await load()
    } catch { /* non-fatal */ }
  }

  return (
    <div ref={boxRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
        title={unread ? `${unread} unread` : 'Notifications'}
        style={{
          position: 'relative', background: 'transparent', border: 'none',
          cursor: 'pointer', color: mut, padding: 6, lineHeight: 0, borderRadius: 8,
        }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 1, right: 1, minWidth: 15, height: 15,
            padding: '0 3px', borderRadius: 999, background: '#B91C1C', color: '#fff',
            fontSize: 9.5, fontWeight: 700, lineHeight: '15px', textAlign: 'center',
          }}>{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 34, width: 330, maxHeight: 420,
          overflowY: 'auto', background: '#fff', border: `1px solid ${border}`,
          borderRadius: 12, boxShadow: '0 12px 28px rgba(0,0,0,0.12)', zIndex: 60,
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', borderBottom: `1px solid ${border}`,
          }}>
            <strong style={{ fontSize: 13.5, color: '#111827' }}>Notifications</strong>
            {unread > 0 && (
              <button onClick={clearAll} style={{
                background: 'none', border: 'none', color: '#1E3A5F',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0,
              }}>Mark all read</button>
            )}
          </div>

          {items.length === 0 ? (
            <p style={{ fontSize: 13, color: mut, padding: '16px 14px', margin: 0 }}>
              Nothing yet. Buy, sell or receive rent and it will show up here.
            </p>
          ) : items.map(n => {
            const tone = TONE[n.kind] || { dot: '#6B7280', label: n.kind }
            return (
              <button key={n.id} onClick={() => readOne(n)} style={{
                display: 'block', width: '100%', textAlign: 'left', cursor: n.read ? 'default' : 'pointer',
                background: n.read ? '#fff' : '#F8FAFF', border: 'none',
                borderBottom: `1px solid ${border}`, padding: '10px 14px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: tone.dot, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{n.title}</span>
                </div>
                <div style={{ fontSize: 12.5, color: mut, margin: '3px 0 0 14px', lineHeight: 1.45 }}>
                  {n.detail}
                </div>
                <div style={{ fontSize: 11.5, color: '#9CA3AF', margin: '4px 0 0 14px' }}>
                  {ago(n.at)}
                  {n.blockHeight > 0 && ` · block #${n.blockHeight}`}
                  {n.amountINR > 0 && n.kind === 'SETTLEMENT_FAILED' && ` · short ${money(n.amountINR)}`}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
