import { useEffect, useRef } from 'react'
import { isRailThrottled, railRetryInMs, onRailThrottleChange } from './railThrottle'

// Polling that stops when nobody is looking, and backs off when refused.
//
// The panels on the settlement page used a bare setInterval. That has three
// faults that only show up in production. It keeps firing in a background
// tab, so a forgotten tab bills the rail forever. It keeps firing at the same
// rate while every call fails, so an overloaded rail is kept overloaded. And
// it fires on a timer rather than on being seen, so returning to a tab shows
// stale figures until the next tick.
//
// This hook fixes all three in one place so the next panel cannot reinvent
// the first version. It runs fn immediately, then every everyMs while the
// document is visible; it suspends on hide and refreshes at once on show; and
// it skips ticks while the shared rail brake is open, resuming when it lifts.

export default function usePoll(fn, everyMs, deps = []) {
  const fnRef = useRef(fn)
  useEffect(() => { fnRef.current = fn })

  useEffect(() => {
    if (typeof document === 'undefined') return undefined

    let timer = null
    let stopped = false

    const visible = () => !document.hidden

    const tick = async () => {
      if (stopped || !visible()) return
      // The brake is shared, so a 429 provoked by any other call on the page
      // quietens this one too. Without that, each panel would have to learn
      // the rail was refusing by being refused itself.
      if (isRailThrottled()) return
      try { await fnRef.current() } catch { /* the next tick retries; a failed poll is not worth throwing */ }
    }

    const start = () => {
      if (timer || stopped) return
      timer = setInterval(tick, everyMs)
    }
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null }
    }

    const onVisibility = () => {
      if (visible()) { tick(); start() } else { stop() }
    }

    // Re-poll as soon as the brake lifts rather than waiting out a full
    // interval on top of the backoff the visitor has already waited.
    const offThrottle = onRailThrottleChange(() => {
      if (!stopped && visible() && !isRailThrottled() && railRetryInMs() === 0) tick()
    })

    if (visible()) { tick(); start() }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stopped = true
      stop()
      offThrottle()
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyMs, ...deps])
}
