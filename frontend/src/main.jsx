import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { ClerkProvider, ClerkFailed } from '@clerk/react'
const Analytics = lazy(() => import('@vercel/analytics/react').then(m => ({ default: m.Analytics })))

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const isClerkConfigured = clerkPubKey && 
  clerkPubKey.startsWith('pk_') && 
  !clerkPubKey.includes('placeholder') &&
  !clerkPubKey.includes('your-key-here') &&
  clerkPubKey.length > 20

// Only log in dev mode reduces production bundle noise and avoids exposing key prefix in prod console per security best practice
const isDev = import.meta.env.DEV
if (isDev) {
  if (isClerkConfigured) {
    console.log('[Clerk] Enabled key:', clerkPubKey.slice(0, 20) + '... domain:', window.location.hostname)
    if (window.location.hostname.includes('vercel.app')) {
      console.log('[Clerk] Production Vercel domain detected:', window.location.hostname, 'ensure this domain is in Clerk Dashboard → Domains → Allowed Origins')
    }
  } else {
    console.log('[Clerk] Not configured using mock auth fallback. Set VITE_CLERK_PUBLISHABLE_KEY to enable Clerk.')
  }
}

// Global fetch interceptor to add X-Fabric-Identity header for Clerk + mock compatibility
const originalFetch = window.fetch
window.fetch = async (input, init = {}) => {
  try {
    const url = typeof input === 'string' ? input : input.url
    if (url && (url.startsWith('/api/') || url.includes('/api/'))) {
      const userStr = localStorage.getItem('aasthi_user')
      let identityId = null
      try {
        if (userStr) {
          const u = JSON.parse(userStr)
          identityId = u.identityId
        }
      } catch {}
      if (identityId) {
        init.headers = {
          ...(init.headers || {}),
          'X-Fabric-Identity': identityId
        }
        if (typeof input !== 'string' && input instanceof Request) {
          const newHeaders = new Headers(input.headers)
          newHeaders.set('X-Fabric-Identity', identityId)
          const modifiedRequest = new Request(input, { headers: newHeaders })
          return originalFetch(modifiedRequest, init)
        }
      }
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[fetch interceptor] failed', e)
  }
  return originalFetch(input, init)
}

function ClerkFailedState({ error }) {
  if (import.meta.env.DEV) console.error('[Clerk] Failed to load:', error)
  return (
    <div style={{minHeight:'100vh', background:'var(--paper)', display:'flex', alignItems:'center', justifyContent:'center', padding:24}}>
      <div className="card" style={{maxWidth:480, borderColor:'rgba(161,61,46,0.2)'}}>
        <h3 style={{color:'var(--error-rust)'}}>Authentication failed to load</h3>
        <p style={{fontSize:13, color:'var(--ink-60)', marginTop:8}}>
          Clerk could not initialize. This is often caused by:
        </p>
        <ul style={{fontSize:12, color:'var(--ink-60)', marginTop:8, paddingLeft:16, lineHeight:1.6}}>
          <li>Domain not in Clerk Dashboard → Domains → Allowed Origins: <code>{window.location.hostname}</code></li>
          <li>Invalid publishable key or network issue</li>
          <li>Ad-blocker blocking Clerk</li>
        </ul>
        <p style={{fontSize:11, color:'var(--ink-40)', marginTop:12, fontFamily:'ui-monospace, monospace'}}>
          {String(error?.message || error || 'Unknown error')}
        </p>
        <div style={{marginTop:16, display:'flex', gap:8, flexWrap:'wrap'}}>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Retry</button>
          <button className="btn btn-secondary" onClick={() => {
            localStorage.removeItem('aasthi_user')
            localStorage.removeItem('aasthi_token')
            window.location.href = '/login'
          }}>Continue with demo auth</button>
        </div>
        <div style={{marginTop:12, fontSize:11, color:'var(--ink-40)'}}>
          Check console for [Clerk] logs. Key: {clerkPubKey ? clerkPubKey.slice(0,20)+'...' : 'not set'}
        </div>
      </div>
    </div>
  )
}

function Root() {
  if (isClerkConfigured) {
    return (
      <React.StrictMode>
        <ClerkProvider 
          publishableKey={clerkPubKey} 
          afterSignOutUrl="/login"
          appearance={{
            elements: {
              // Make Google OAuth primary, email+code fallback
              socialButtonsBlockButton: { 
                background:'var(--surface)', 
                border:'1px solid var(--ink-12)',
                fontWeight:600,
                order: -1 // Google first
              },
              socialButtonsBlockButtonText: { fontWeight:600 },
              formButtonPrimary: { background:'var(--registry-navy)' },
              card: { boxShadow:'none', border:'1px solid var(--ink-8)' }
            },
            layout: {
              socialButtonsPlacement: 'top', // Google OAuth on top
              socialButtonsVariant: 'blockButton'
            }
          }}
        >
          {/* The app renders straight away; Clerk finishes booting in the
              background and auth-gated routes wait on it individually. This
              removes the full-screen "Loading secure authentication" delay
              that every first-time visitor used to sit through. */}
          <ClerkFailed>
            {(error) => <ClerkFailedState error={error} />}
          </ClerkFailed>
          <App />
          <Suspense fallback={null}><Analytics /></Suspense>
        </ClerkProvider>
      </React.StrictMode>
    )
  }
  return (
    <React.StrictMode>
      <App />
      <Suspense fallback={null}><Analytics /></Suspense>
    </React.StrictMode>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<Root />)
