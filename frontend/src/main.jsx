import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { ClerkProvider } from '@clerk/react'

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const isClerkConfigured = clerkPubKey && 
  clerkPubKey.startsWith('pk_') && 
  !clerkPubKey.includes('placeholder') &&
  !clerkPubKey.includes('your-key-here') &&
  clerkPubKey.length > 20

if (isClerkConfigured) {
  console.log('[Clerk] Enabled — key:', clerkPubKey.slice(0, 20) + '...')
} else {
  console.log('[Clerk] Not configured — using mock auth fallback. Set VITE_CLERK_PUBLISHABLE_KEY to enable Clerk.')
}

// Global fetch interceptor to add X-Fabric-Identity header for Clerk + mock compatibility
// This ensures backend knows which demo identity (originator1, investor1, etc) to use even with Clerk JWT
const originalFetch = window.fetch
window.fetch = async (input, init = {}) => {
  try {
    const url = typeof input === 'string' ? input : input.url
    // Only intercept API calls
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
        // If input is Request object, need to handle differently
        if (typeof input !== 'string' && input instanceof Request) {
          const newHeaders = new Headers(input.headers)
          newHeaders.set('X-Fabric-Identity', identityId)
          // Preserve Authorization if not already set
          const modifiedRequest = new Request(input, { headers: newHeaders })
          return originalFetch(modifiedRequest, init)
        }
      }
    }
  } catch (e) {
    // Don't break fetch on interceptor error
    console.warn('[fetch interceptor] failed', e)
  }
  return originalFetch(input, init)
}

function Root() {
  if (isClerkConfigured) {
    return (
      <React.StrictMode>
        <ClerkProvider publishableKey={clerkPubKey} afterSignOutUrl="/login">
          <App />
        </ClerkProvider>
      </React.StrictMode>
    )
  }
  return (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<Root />)
