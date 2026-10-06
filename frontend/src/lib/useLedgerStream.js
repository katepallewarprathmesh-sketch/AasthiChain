import { useEffect, useRef, useState } from 'react'

// Live ledger updates, with an honest fallback.
//
// The stream is server-sent events, not a WebSocket: traffic is one-way (the
// ledger tells us a block landed) and EventSource reconnects by itself.
//
// The fallback matters more than the stream. The app is served from a
// serverless platform that cannot hold a connection open, so on the deployed
// site the stream will simply never open. Rather than leave the page dead,
// this falls back to polling and reports which mode it ended up in, so the UI
// can tell the truth instead of claiming "live" either way.

const FALLBACK_AFTER_MS = 6000
const POLL_EVERY_MS = 15000

export default function useLedgerStream({ onBlock, pollFn } = {}) {
  const [mode, setMode] = useState('connecting') // connecting | live | polling | off
  const [lastBlock, setLastBlock] = useState(null)
  const [height, setHeight] = useState(null)

  // Keep the callbacks in refs so a caller passing inline functions does not
  // tear the stream down and rebuild it on every render.
  const onBlockRef = useRef(onBlock)
  const pollRef = useRef(pollFn)
  useEffect(() => { onBlockRef.current = onBlock }, [onBlock])
  useEffect(() => { pollRef.current = pollFn }, [pollFn])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
      setMode('off')
      return undefined
    }

    let es = null
    let pollTimer = null
    let fallbackTimer = null
    let stopped = false

    const startPolling = () => {
      if (stopped || pollTimer) return
      setMode('polling')
      if (es) { es.close(); es = null }
      const tick = async () => {
        if (stopped || !pollRef.current) return
        try {
          const h = await pollRef.current()
          if (typeof h === 'number') setHeight(h)
        } catch { /* a failed poll is not worth surfacing; the next one retries */ }
      }
      tick()
      pollTimer = setInterval(tick, POLL_EVERY_MS)
    }

    try {
      es = new EventSource('/api/umi/events')
    } catch {
      startPolling()
      return () => { stopped = true }
    }

    // If the stream has not opened shortly, assume it never will.
    fallbackTimer = setTimeout(() => { if (mode !== 'live') startPolling() }, FALLBACK_AFTER_MS)

    es.addEventListener('hello', (e) => {
      if (stopped) return
      clearTimeout(fallbackTimer)
      setMode('live')
      try {
        const d = JSON.parse(e.data)
        if (typeof d.height === 'number') setHeight(d.height)
      } catch { /* a malformed hello is not fatal */ }
    })

    es.addEventListener('block', (e) => {
      if (stopped) return
      try {
        const b = JSON.parse(e.data)
        setLastBlock(b)
        setHeight(b.height + 1)
        if (onBlockRef.current) onBlockRef.current(b)
      } catch { /* ignore a malformed frame rather than kill the stream */ }
    })

    es.onerror = () => {
      // EventSource retries on its own, so only give up once it is properly
      // closed. A transient blip should not demote a working stream.
      if (es && es.readyState === 2) startPolling()
    }

    return () => {
      stopped = true
      clearTimeout(fallbackTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (es) es.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { mode, lastBlock, height }
}
