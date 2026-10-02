import React from 'react'
import { useNavigate } from 'react-router-dom'
import { describeError } from '../lib/apiError'

/**
 * The only way a failure should reach the screen.
 *
 * Renders plain language plus the action that actually resolves the problem —
 * never a raw code like ERR_UNAUTHORIZED, which tells a user nothing and
 * leaves them stuck.
 *
 * Usage:  <ErrorState error={err} what="the marketplace" onRetry={refresh} />
 */
export default function ErrorState({ error, what, onRetry, compact = false }) {
  const navigate = useNavigate()
  const { title, detail, action, severity } = describeError(error, { what })

  const tone = {
    info:    { bg: '#EFF6FF', border: '#BFDBFE', fg: '#1E3A5F', icon: 'ℹ' },
    warning: { bg: '#FFFBEB', border: '#FDE68A', fg: '#92400E', icon: '!' },
    error:   { bg: '#FEF2F2', border: '#FECACA', fg: '#991B1B', icon: '!' },
  }[severity] || { bg: '#F9FAFB', border: '#E5E7EB', fg: '#374151', icon: 'ℹ' }

  const run = () => {
    if (action.kind === 'login') navigate('/login')
    else if (action.kind === 'back') navigate(-1)
    else if (action.kind === 'retry' && onRetry) onRetry()
  }

  const showButton = action.kind === 'login' || action.kind === 'back' ||
                     (action.kind === 'retry' && !!onRetry)

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 12,
        padding: compact ? '12px 14px' : '22px 20px',
        textAlign: 'center',
      }}
    >
      <div style={{
        fontSize: compact ? 14 : 15, fontWeight: 650, color: tone.fg,
        marginBottom: 6,
      }}>
        {tone.icon}&nbsp; {title}
      </div>
      <p style={{
        fontSize: 13, lineHeight: 1.55, color: tone.fg, opacity: 0.85,
        margin: '0 auto', maxWidth: 440,
      }}>
        {detail}
      </p>
      {showButton && (
        <button
          onClick={run}
          style={{
            marginTop: 14, padding: '9px 20px', background: '#1E3A5F',
            color: '#fff', border: 'none', borderRadius: 9,
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
