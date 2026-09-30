// PayU hosted-checkout bridge auto-submits the server-signed form to PayU.
// The form params + SHA-512 hash come from the API (server-side salt never
// exposed to the client). On the test server this is a full PSP round-trip:
// PayU page → test VPA (test@payu succeeds, fail@payu declines) → browser is
// redirected back to /api/npci/payu/callback which verifies the reverse hash.
import React, { useEffect, useRef } from 'react'

export default function PayUCheckout({ checkout, testMode = true, onCancel }) {
  const formRef = useRef(null)
  const autoSubmitted = useRef(false)

  const submit = () => {
    if (formRef.current) formRef.current.submit()
  }

  useEffect(() => {
    if (!autoSubmitted.current && formRef.current) {
      autoSubmitted.current = true
      submit()
    }
  }, [])

  if (!checkout || !checkout.action) return null

  return (
    <div>
      {/* Hidden form server-computed hash travels with it */}
      <form ref={formRef} method="POST" action={checkout.action} style={{ display: 'none' }}>
        {Object.entries(checkout.params || {}).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={String(v ?? '')} readOnly />
        ))}
      </form>

      <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, padding: 16, textAlign: 'center' }}>
        <span style={{ display: 'inline-block', background: '#FEF3C7', border: '1px solid #FDE68A', color: '#92400E', fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 4, letterSpacing: 0.5 }}>
          {testMode ? 'PAYU · TEST MODE NO REAL MONEY' : 'PAYU · SECURE UPI'}
        </span>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 10 }}>
          Opening PayU secure UPI checkout…
        </div>
        <p style={{ fontSize: 12, color: '#6B7280', marginTop: 6, lineHeight: 1.5 }}>
          {testMode ? (
            <>
              On PayU&apos;s page: choose <strong>UPI ID / VPA</strong> and enter{' '}
              <code style={{ background: 'white', padding: '2px 6px', borderRadius: 4, border: '1px solid #E5E7EB' }}>test@payu</code>
              {' '}→ succeeds ·{' '}
              <code style={{ background: 'white', padding: '2px 6px', borderRadius: 4, border: '1px solid #E5E7EB' }}>fail@payu</code>
              {' '}→ declines
              <div style={{ fontSize: 10.5, color: '#B45309', marginTop: 6 }}>
                Other app icons on this test page are simulated only the UPI ID option completes on the test rail.
              </div>
            </>
          ) : (
            'Approve the collect request in your UPI app.'
          )}
        </p>
        <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
          Didn&apos;t open? Click below. You&apos;ll return here automatically after paying.
        </p>
        <button
          onClick={submit}
          style={{ width: '100%', marginTop: 10, padding: 12, background: '#059669', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
        >
          Open PayU UPI Checkout
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            style={{ width: '100%', marginTop: 8, padding: 10, background: 'white', color: '#6B7280', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            Cancel and use demo UPI instead
          </button>
        )}
      </div>
    </div>
  )
}
