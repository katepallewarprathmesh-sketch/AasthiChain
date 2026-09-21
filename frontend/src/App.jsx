import React, { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { useUser, useAuth, useClerk, UserButton, SignInButton, ClerkLoading, ClerkLoaded } from '@clerk/react'

import Login from './pages/Login.jsx'
import Marketplace from './pages/Marketplace.jsx'
import Wallet from './pages/Wallet.jsx'
import Admin from './pages/Admin.jsx'
import Regulator from './pages/Regulator.jsx'
import PropertyDetail from './pages/PropertyDetail.jsx'

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
export const isClerkConfigured = clerkPubKey && 
  clerkPubKey.startsWith('pk_') && 
  !clerkPubKey.includes('placeholder') &&
  !clerkPubKey.includes('your-key-here') &&
  clerkPubKey.length > 20

const ROLES = [
  { id: 'originator1', role: 'Originator', label: 'Originator', mspId: 'OriginatorMSP' },
  { id: 'registrar1', role: 'Registrar', label: 'Registrar', mspId: 'RegistrarMSP' },
  { id: 'investor1', role: 'Investor', label: 'Investor 1', mspId: 'InvestorMSP' },
  { id: 'investor2', role: 'Investor', label: 'Investor 2', mspId: 'InvestorMSP' },
  { id: 'regulator1', role: 'Regulator', label: 'Regulator', mspId: 'RegulatorMSP' },
]

function getStoredUser() {
  try { const s=localStorage.getItem('aasthi_user'); return s?JSON.parse(s):null } catch { return null }
}

function Footer() {
  return (
    <footer style={{borderTop:'1px solid #E5E7EB', background:'white', padding:'20px 0', marginTop:40}}>
      <div className="container" style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
        <div style={{fontSize:12, color:'#6B7280'}}>
          <span style={{fontFamily:'Fraunces', fontWeight:600, color:'#111827'}}>AasthiChain</span> v2.0 · One easy auth for all · {isClerkConfigured ? 'Clerk + Demo' : 'Demo auth'}
        </div>
        <div style={{fontSize:11, color:'#9CA3AF'}}>No email verification friction · One-click roles</div>
      </div>
    </footer>
  )
}

function Nav({ user, onLogout, onRoleSwitch }) {
  const location = useLocation()
  const isActive = (p) => location.pathname === p || location.pathname.startsWith(p)

  return (
    <nav style={{background:'white', borderBottom:'1px solid #E5E7EB', position:'sticky', top:0, zIndex:100, backdropFilter:'blur(8px)'}}>
      <div className="container" style={{display:'flex', justifyContent:'space-between', alignItems:'center', height:64, gap:24}}>
        <div style={{display:'flex', alignItems:'center', gap:24}}>
          <Link to="/" style={{textDecoration:'none', display:'flex', alignItems:'center', gap:10}}>
            <div style={{width:32, height:32, background:'#1E3A5F', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontFamily:'Fraunces', fontWeight:800}}>A</div>
            <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:18, color:'#111827'}}>AasthiChain</span>
          </Link>
          {user && (
            <div style={{display:'flex', gap:2}}>
              {[
                { path: '/marketplace', label: 'Marketplace' },
                { path: '/wallet', label: 'Wallet' },
                ...(user.role === 'Originator' || user.role === 'Registrar' ? [{ path: '/admin', label: 'Admin' }] : []),
                ...(user.role === 'Regulator' ? [{ path: '/regulator', label: 'Audit' }] : []),
              ].map(item => (
                <Link key={item.path} to={item.path} style={{textDecoration:'none', fontSize:13, fontWeight:500, padding:'8px 12px', borderRadius:8, color: isActive(item.path) ? '#1E3A5F' : '#6B7280', background: isActive(item.path) ? '#F1F5F9' : 'transparent'}}>{item.label}</Link>
              ))}
            </div>
          )}
        </div>

        <div style={{display:'flex', alignItems:'center', gap:10}}>
          {user ? (
            <>
              <div style={{display:'flex', alignItems:'center', gap:8, background:'#F9FAFB', border:'1px solid #E5E7EB', borderRadius:8, padding:'4px 8px'}}>
                <span style={{fontSize:10, fontWeight:700, color:'#9CA3AF'}}>ROLE</span>
                <select value={user.identityId} onChange={e=>{ const s=ROLES.find(r=>r.id===e.target.value); if(s) onRoleSwitch(s) }} style={{fontSize:12, fontWeight:600, background:'white', border:'1px solid #E5E7EB', borderRadius:6, padding:'4px 8px'}}>
                  {ROLES.map(r=> <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </div>
              <div style={{textAlign:'right', lineHeight:1.2, display:'none'}}>
                <div style={{fontSize:12, fontWeight:600}}>{user.identityId}</div>
                <div style={{fontSize:10, color:'#6B7280'}}>{user.role}</div>
              </div>
              {isClerkConfigured && (
                <>
                  <ClerkLoading><div style={{width:28, height:28, background:'#F3F4F6', borderRadius:'50%'}}></div></ClerkLoading>
                  <ClerkLoaded><UserButton afterSignOutUrl="/login" /></ClerkLoaded>
                </>
              )}
              <button className="btn btn-secondary" style={{padding:'8px 12px', fontSize:12}} onClick={onLogout}>Sign out</button>
            </>
          ) : (
            <>
              <ClerkLoading>
                <button className="btn btn-primary" style={{fontSize:13, opacity:0.6}} disabled>Loading...</button>
              </ClerkLoading>
              <ClerkLoaded>
                {isClerkConfigured ? (
                  <SignInButton mode="modal" fallbackRedirectUrl="/marketplace">
                    <button className="btn btn-primary" style={{fontSize:13}} onClick={() => console.log('[Auth] Sign in modal clicked — should open in 1-2s')}>Sign in</button>
                  </SignInButton>
                ) : (
                  <Link to="/login" className="btn btn-primary" style={{fontSize:13, textDecoration:'none'}}>Sign in</Link>
                )}
              </ClerkLoaded>
              {!isClerkConfigured && (
                <Link to="/login" className="btn btn-primary" style={{fontSize:13, textDecoration:'none'}}>Sign in</Link>
              )}
            </>
          )}
        </div>
      </div>
    </nav>
  )
}

function AppContent({ user, setUser }) {
  const clerk = isClerkConfigured ? useClerk() : null
  const { isLoaded, isSignedIn, user: clerkUser } = isClerkConfigured ? useUser() : { isLoaded: true, isSignedIn: false, user: null }
  const { getToken } = isClerkConfigured ? useAuth() : { getToken: async () => null }

  const [internalUser, setInternalUser] = useState(user)

  useEffect(() => { setInternalUser(user) }, [user])

  useEffect(() => {
    if (!isClerkConfigured) return
    if (!isLoaded) return

    // Allow demo bypass to persist even when Clerk is configured — one easy auth for all
    const stored = getStoredUser()
    if (stored && stored.isDemo) {
      setInternalUser(stored)
      setUser(stored)
      return
    }

    if (!isSignedIn || !clerkUser) {
      // If we have a demo user, don't clear it — keep one easy auth
      const current = getStoredUser()
      if (current && current.isDemo) return
      setInternalUser(null)
      setUser(null)
      return
    }

    const fetchToken = async () => {
      try {
        const t = await getToken()
        if (t) localStorage.setItem('aasthi_token', t)
      } catch (e) { console.error('[Clerk] getToken failed', e) }
    }
    fetchToken()

    const storedDemoId = (() => { try { return localStorage.getItem('aasthi_clerk_demo_identity') || 'investor1' } catch { return 'investor1' } })()
    let selectedRole = ROLES.find(r=>r.id===storedDemoId) || ROLES[2]

    const aasthiUser = {
      token: localStorage.getItem('aasthi_token') || 'clerk-' + clerkUser.id,
      identityId: selectedRole.id,
      role: selectedRole.role,
      mspId: selectedRole.mspId,
      clerkId: clerkUser.id,
      clerkEmail: clerkUser.primaryEmailAddress?.emailAddress || clerkUser.emailAddresses?.[0]?.emailAddress,
      fabricMode: 'clerk'
    }
    localStorage.setItem('aasthi_user', JSON.stringify(aasthiUser))
    setInternalUser(aasthiUser)
    setUser(aasthiUser)
  }, [isClerkConfigured, isLoaded, isSignedIn, clerkUser])

  const handleLogout = async () => {
    try {
      localStorage.removeItem('aasthi_user')
      localStorage.removeItem('aasthi_token')
      setInternalUser(null)
      setUser(null)
      if (isClerkConfigured && clerk) {
        await clerk.signOut()
      }
    } catch {
      window.location.href='/login'
    }
  }

  const handleRoleSwitch = (roleData) => {
    const updated = {
      ...(internalUser || {}),
      identityId: roleData.id,
      role: roleData.role,
      mspId: roleData.mspId
    }
    localStorage.setItem('aasthi_user', JSON.stringify(updated))
    localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)
    setInternalUser(updated)
    setUser(updated)
  }

  const effectiveUser = internalUser || user

  if (isClerkConfigured && !isLoaded) {
    return (
      <div style={{minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center'}}>
        <div style={{textAlign:'center'}}>
          <div style={{width:32, height:32, border:'3px solid #E5E7EB', borderTopColor:'#1E3A5F', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto'}}></div>
          <div style={{fontSize:13, color:'#6B7280', marginTop:12}}>Loading authentication...</div>
        </div>
      </div>
    )
  }

  return (
    <>
      <Nav user={effectiveUser} onLogout={handleLogout} onRoleSwitch={handleRoleSwitch} />
      <main className="container" style={{paddingTop:24, paddingBottom:48}}>
        <Routes>
          <Route path="/login" element={<Login onLogin={setUser} />} />
          <Route path="/" element={effectiveUser ? <Navigate to="/marketplace" /> : <Navigate to="/login" />} />
          <Route path="/marketplace" element={effectiveUser ? <Marketplace user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/wallet" element={effectiveUser ? <Wallet user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/admin" element={effectiveUser ? <Admin user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/regulator" element={effectiveUser ? <Regulator user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/property/:id" element={effectiveUser ? <PropertyDetail user={effectiveUser} /> : <Navigate to="/login" />} />
        </Routes>
      </main>
      <Footer />
    </>
  )
}

export default function App() {
  const [user, setUser] = useState(() => getStoredUser())

  return (
    <BrowserRouter>
      <AppContent user={user} setUser={setUser} />
    </BrowserRouter>
  )
}
