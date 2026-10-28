import { useState, useRef, useEffect, useCallback } from 'react'

// Aasthi AI — a floating assistant that can explain the platform and the
// properties actually listed on it.
//
// Three deliberate choices:
//
// 1. It hides itself where it does not exist. A deployment with no
//    GROQ_API_KEY reports that through /api/ai/status, and the launcher never
//    renders, rather than offering a button that always fails.
// 2. It never claims to have done anything. The assistant cannot buy, sell or
//    approve; the panel says so up front so nobody types an instruction and
//    assumes it was carried out.
// 3. Errors are shown as sentences in the thread, in place, rather than a
//    toast that disappears before it is read.

const C = {
  navy: '#1E3A5F', paper: '#F7F5F0', line: '#E5E7EB',
  mut: '#6B7280', bad: '#B91C1C', ink: '#111827',
}

const SUGGESTIONS = [
  'What properties can I invest in right now?',
  'What is the cheapest token on the platform?',
  'How does fractional ownership work here?',
  'What does registrar validation mean?',
]

const MAX_CHARS = 1200

// The model writes markdown whether you ask it to or not — bold runs, bullet
// lists, the occasional heading. Printed raw, a person reads asterisks and
// hyphens instead of an answer. This turns the handful of marks that actually
// show up into typography. It builds React nodes rather than HTML, so there is
// nothing here that could inject markup into the page.
const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*)/g

function inline(text, keyBase) {
  return String(text).split(INLINE).filter(Boolean).map((piece, i) => {
    const key = `${keyBase}-${i}`
    if (/^(\*\*|__).+(\*\*|__)$/.test(piece)) {
      return <strong key={key} style={{ fontWeight: 650 }}>{piece.slice(2, -2)}</strong>
    }
    if (/^`.+`$/.test(piece)) {
      return <code key={key} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.92em', background: 'rgba(30,58,95,0.07)', borderRadius: 4, padding: '1px 4px' }}>{piece.slice(1, -1)}</code>
    }
    if (/^\*[^*]+\*$/.test(piece)) {
      return <em key={key}>{piece.slice(1, -1)}</em>
    }
    return <span key={key}>{piece}</span>
  })
}

function RichText({ text }) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const blocks = []
  let list = null                       // { ordered, items: [] }

  const closeList = () => { if (list) { blocks.push(list); list = null } }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { closeList(); continue }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/)
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/)

    if (bullet) {
      if (!list || list.ordered) { closeList(); list = { ordered: false, items: [] } }
      list.items.push(bullet[1])
    } else if (numbered) {
      if (!list || !list.ordered) { closeList(); list = { ordered: true, items: [] } }
      list.items.push(numbered[2])
    } else if (heading) {
      closeList()
      blocks.push({ heading: heading[1] })
    } else {
      closeList()
      blocks.push({ paragraph: line.trim() })
    }
  }
  closeList()

  return (
    <>
      {blocks.map((b, i) => {
        if (b.heading !== undefined) {
          return <div key={i} style={{ fontWeight: 650, margin: i ? '10px 0 4px' : '0 0 4px' }}>{inline(b.heading, i)}</div>
        }
        if (b.items) {
          const Tag = b.ordered ? 'ol' : 'ul'
          return (
            <Tag key={i} style={{ margin: i ? '6px 0' : '0 0 6px', paddingLeft: 18, display: 'grid', gap: 3 }}>
              {b.items.map((it, j) => <li key={j} style={{ paddingLeft: 2 }}>{inline(it, `${i}-${j}`)}</li>)}
            </Tag>
          )
        }
        return <p key={i} style={{ margin: i ? '6px 0 0' : 0 }}>{inline(b.paragraph, i)}</p>
      })}
    </>
  )
}

function Bubble({ role, children, tone }) {
  const mine = role === 'user'
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
      <div style={{
        maxWidth: '86%',
        background: mine ? C.navy : tone === 'error' ? '#FEF2F2' : '#fff',
        color: mine ? '#fff' : tone === 'error' ? C.bad : C.ink,
        border: mine ? 'none' : `1px solid ${tone === 'error' ? '#FECACA' : C.line}`,
        borderRadius: 12,
        padding: '9px 12px',
        fontSize: 13.5,
        lineHeight: 1.6,
        whiteSpace: mine || tone ? 'pre-wrap' : 'normal',
        overflowWrap: 'anywhere',
      }}>{children}</div>
    </div>
  )
}

// A media query rather than a width prop: this component is mounted once by
// App and has no parent that knows the viewport.
function usePhone(max = 640) {
  const [p, setP] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(max-width: ${max}px)`).matches : false))
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mq = window.matchMedia(`(max-width: ${max}px)`)
    const on = () => setP(mq.matches)
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on)
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on) }
  }, [max])
  return p
}

export default function AasthiAI() {
  const phone = usePhone()
  const [available, setAvailable] = useState(false)
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [thread, setThread] = useState([])
  const endRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/ai/status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setAvailable(!!d.enabled) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [thread, busy, open])

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  const send = useCallback(async (text) => {
    const question = String(text || '').trim()
    if (!question || busy) return
    if (question.length > MAX_CHARS) return

    // Only user and assistant turns go back to the server; errors are local
    // commentary and must not be replayed as if the assistant had said them.
    const history = thread.filter(m => !m.tone).map(m => ({ role: m.role, content: m.content }))
    const next = [...thread, { role: 'user', content: question }]
    setThread(next)
    setInput('')
    setBusy(true)

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...history, { role: 'user', content: question }] }),
      })
      let data = null
      try { data = await res.json() } catch { /* not json */ }
      if (!res.ok || !data || !data.reply) {
        setThread(t => [...t, {
          role: 'assistant',
          tone: 'error',
          content: (data && data.message) || `The assistant could not answer (HTTP ${res.status}).`,
        }])
      } else {
        setThread(t => [...t, { role: 'assistant', content: data.reply }])
      }
    } catch {
      setThread(t => [...t, { role: 'assistant', tone: 'error', content: 'Could not reach the assistant. Check your connection and try again.' }])
    } finally {
      setBusy(false)
    }
  }, [busy, thread])

  if (!available) return null

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open Aasthi AI"
        style={{
          position: 'fixed', zIndex: 900,
          right: 'max(14px, env(safe-area-inset-right))',
          bottom: 'calc(max(14px, env(safe-area-inset-bottom)))',
          display: 'flex', alignItems: 'center', gap: 8,
          background: C.navy, color: '#fff', border: 'none',
          borderRadius: 999, padding: '11px 17px', fontSize: 13.5, fontWeight: 600,
          cursor: 'pointer', boxShadow: '0 6px 20px rgba(30,58,95,0.28)',
        }}>
        <span aria-hidden="true" style={{ fontSize: 15 }}>✦</span> Ask Aasthi AI
      </button>
    )
  }

  return (
    <div
      role="dialog"
      aria-label="Aasthi AI assistant"
      style={{
        position: 'fixed', zIndex: 900,
        // Phone: a bottom sheet across the full width, 85% of the dynamic
        // viewport so the browser toolbar cannot swallow the composer.
        // Tablet and up: the corner panel it has always been.
        right: phone ? 0 : 'max(12px, env(safe-area-inset-right))',
        left: phone ? 0 : undefined,
        bottom: phone ? 0 : 'max(12px, env(safe-area-inset-bottom))',
        width: phone ? '100%' : 'min(380px, calc(100vw - 24px))',
        height: phone ? 'min(85dvh, calc(var(--vh-full) - 44px))' : 'min(560px, calc(var(--vh-full) - 24px))',
        paddingBottom: phone ? 'env(safe-area-inset-bottom)' : undefined,
        display: 'flex', flexDirection: 'column',
        background: C.paper, border: `1px solid ${C.line}`,
        borderRadius: phone ? '16px 16px 0 0' : 14,
        boxShadow: '0 18px 50px rgba(17,24,39,0.22)', overflow: 'hidden',
      }}>

      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, padding: '11px 14px', background: C.navy, color: '#fff', flexShrink: 0,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Aasthi AI</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>Answers from live listings. It cannot buy or sell.</div>
        </div>
        <button
          onClick={() => setOpen(false)} aria-label="Close"
          style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 20, lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}>
          ×
        </button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 12px', minHeight: 0 }}>
        {thread.length === 0 && (
          <>
            <p style={{ fontSize: 12.5, color: C.mut, lineHeight: 1.6, margin: '0 0 12px' }}>
              Ask about the properties listed here, token prices, what is still available, or how
              any of it works. Figures come from the live ledger. It has no access to anyone's
              holdings, payments or KYC.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {SUGGESTIONS.map(q => (
                <button
                  key={q} onClick={() => send(q)}
                  style={{
                    textAlign: 'left', background: '#fff', border: `1px solid ${C.line}`,
                    borderRadius: 9, padding: '8px 11px', fontSize: 12.5, color: C.navy, cursor: 'pointer',
                  }}>{q}</button>
              ))}
            </div>
          </>
        )}

        {thread.map((m, i) => (
          <Bubble key={i} role={m.role} tone={m.tone}>
            {m.role === 'user' || m.tone ? m.content : <RichText text={m.content} />}
          </Bubble>
        ))}

        {busy && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: C.mut, fontSize: 12.5, padding: '2px 4px' }}>
            <span className="acx-chip" style={{ fontSize: 11 }}>thinking…</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(input) }}
        style={{ borderTop: `1px solid ${C.line}`, background: '#fff', padding: 10, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value.slice(0, MAX_CHARS))}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
            }}
            rows={2}
            placeholder="Ask about a property, a price, or how this works…"
            style={{
              flex: 1, resize: 'none', border: `1px solid ${C.line}`, borderRadius: 9,
              padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', minWidth: 0,
            }} />
          <button
            type="submit" disabled={busy || !input.trim()}
            style={{
              border: 'none', borderRadius: 9, padding: '10px 14px', fontSize: 13, fontWeight: 600,
              background: busy || !input.trim() ? '#9CA3AF' : C.navy, color: '#fff',
              cursor: busy || !input.trim() ? 'not-allowed' : 'pointer', flexShrink: 0,
            }}>
            {busy ? '…' : 'Send'}
          </button>
        </div>
        <div style={{ fontSize: 10.5, color: C.mut, marginTop: 6 }}>
          AI answers can be wrong. The ledger and the property pages are the record.
        </div>
      </form>
    </div>
  )
}
