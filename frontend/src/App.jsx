import React, { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useUser, useAuth, useClerk, UserButton } from '@clerk/react'

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

function getStoredClerkDemoIdentity() {
  try { return localStorage.getItem('aasthi_clerk_demo_identity') || 'investor1' } catch { return 'investor1' }
}

function Footer() {
  return (
    <footer style={{borderTop:'1px solid var(--ink-8)', background:'var(--surface)', padding:'24px 0'}}>
      <div className="container" style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
        <div style={{fontSize:12, color:'var(--ink-40)'}}>
          <span style={{fontFamily:'Fraunces', fontWeight:600, color:'var(--ink)'}}>AasthiChain</span> v1.8 · Clerk Auth · Production-Ready · {isClerkConfigured ? 'Clerk enabled' : 'Mock fallback — set VITE_CLERK_PUBLISHABLE_KEY to enable Clerk'}
        </div>
        <div style={{fontSize:11, color:'var(--ink-40)', maxWidth:'60ch', textAlign:'right'}}>
          On-chain token ≠ Registration Act, 1908 · KYC/Payment pluggable · SPV · Sepolia test ETH no monetary value
        </div>
      </div>
    </footer>
  )
}

// ================= LEGACY NAV (no Clerk) =================
function NavLegacy({ user, onLogout, onRoleSwitch }) {
  const location = useLocation()
  const navigate = useNavigate()
  const isActive = (p) => location.pathname === p || location.pathname.startsWith(p)

  const handleSignIn = (e) => {
    e?.preventDefault()
    try { navigate('/login') } catch { window.location.href='/login' }
    setTimeout(()=>{ if(window.location.pathname!=='/login') window.location.href='/login' },100)
  }
  const handleLogo = (e) => {
    e.preventDefault()
    try { navigate(user ? '/marketplace' : '/login') } catch { window.location.href = user ? '/marketplace' : '/login' }
  }

  return (
    <nav style={{background:'var(--surface)', borderBottom:'1px solid var(--ink-8)', position:'sticky', top:0, zIndex:100}}>
      <div className="container" style={{display:'flex', justifyContent:'space-between', alignItems:'center', height:64, gap:24}}>
        <div style={{display:'flex', alignItems:'center', gap:32}}>
          <a href="/" onClick={handleLogo} style={{textDecoration:'none', display:'flex', alignItems:'center', gap:10, cursor:'pointer'}}>
            <div style={{width:32, height:32, background:'var(--registry-navy)', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontFamily:'Fraunces', fontWeight:800}}>A</div>
            <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:20, color:'var(--ink)'}}>AasthiChain</span>
            <span style={{fontSize:10, fontWeight:700, textTransform:'uppercase', background:'var(--paper)', border:'1px solid var(--ink-8)', padding:'3px 6px', borderRadius:4, color:'var(--ink-60)'}}>Drunix</span>
          </a>
          {user && (
            <div style={{display:'flex', gap:4}}>
              {[
                { path: '/marketplace', label: 'Marketplace' },
                { path: '/wallet', label: 'Wallet' },
                ...(user.role === 'Originator' || user.role === 'Registrar' ? [{ path: '/admin', label: 'Admin' }] : []),
                ...(user.role === 'Regulator' ? [{ path: '/regulator', label: 'Audit' }] : []),
              ].map(item => (
                <Link key={item.path} to={item.path} style={{textDecoration:'none', fontSize:13, fontWeight:600, padding:'8px 12px', borderRadius:6, color: isActive(item.path) ? 'var(--registry-navy)' : 'var(--ink-60)', background: isActive(item.path) ? 'rgba(30,58,95,0.08)' : 'transparent', border: isActive(item.path) ? '1px solid rgba(30,58,95,0.12)' : '1px solid transparent'}}>{item.label}</Link>
              ))}
            </div>
          )}
        </div>
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          {user ? (
            <>
              <div style={{display:'flex', alignItems:'center', gap:8, background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:6, padding:'4px 8px'}}>
                <span style={{fontSize:10, fontWeight:700, textTransform:'uppercase', color:'var(--ink-40)'}}>Demo Role</span>
                <select value={user.identityId} onChange={e=>{ const s=ROLES.find(r=>r.id===e.target.value); if(s) onRoleSwitch(s) }} style={{fontSize:12, fontWeight:600, background:'var(--surface)', border:'1px solid var(--ink-12)', borderRadius:4, padding:'4px 8px'}}>
                  {ROLES.map(r=> <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <span style={{fontSize:10, color:'var(--ink-40)', fontStyle:'italic'}}>demo-only</span>
              </div>
              <div style={{textAlign:'right', lineHeight:1.2}}>
                <div style={{fontSize:12, fontWeight:600}}>{user.identityId}</div>
                <div style={{fontSize:10, color:'var(--ink-60)'}}>{user.role} · {user.mspId}</div>
              </div>
              <button className="btn btn-secondary" style={{padding:'8px 12px', fontSize:12}} onClick={onLogout}>Sign out</button>
            </>
          ) : (
            <button onClick={handleSignIn} className="btn btn-primary" style={{fontSize:13, cursor:'pointer'}}>Sign in</button>
          )}
        </div>
      </div>
    </nav>
  )
}

function AppContentLegacy({ user, setUser }) {
  const handleLogout = () => {
    localStorage.removeItem('aasthi_user')
    localStorage.removeItem('aasthi_token')
    setUser(null)
  }
  const handleRoleSwitch = (roleData) => {
    const mockUser = {
      token: btoa(JSON.stringify({ identityId: roleData.id, role: roleData.role, mspId: roleData.mspId })),
      identityId: roleData.id,
      role: roleData.role,
      mspId: roleData.mspId
    }
    localStorage.setItem('aasthi_user', JSON.stringify(mockUser))
    localStorage.setItem('aasthi_token', mockUser.token)
    localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)
    setUser(mockUser)
    window.location.reload()
  }

  return (
    <>
      <NavLegacy user={user} onLogout={handleLogout} onRoleSwitch={handleRoleSwitch} />
      <main className="container" style={{paddingTop:32, paddingBottom:48}}>
        <Routes>
          <Route path="/login" element={<Login onLogin={setUser} />} />
          <Route path="/" element={user ? <Navigate to="/marketplace" /> : <Navigate to="/login" />} />
          <Route path="/marketplace" element={user ? <Marketplace user={user} /> : <Navigate to="/login" />} />
          <Route path="/wallet" element={user ? <Wallet user={user} /> : <Navigate to="/login" />} />
          <Route path="/admin" element={user ? <Admin user={user} /> : <Navigate to="/login" />} />
          <Route path="/regulator" element={user ? <Regulator user={user} /> : <Navigate to="/login" />} />
          <Route path="/property/:id" element={user ? <PropertyDetail user={user} /> : <Navigate to="/login" />} />
        </Routes>
      </main>
      <Footer />
    </>
  )
}

// ================= CLERK NAV =================
function NavClerk({ internalUser, clerkUser, onLogout, onRoleSwitch }) {
  const location = useLocation()
  const isActive = (p) => location.pathname === p || location.pathname.startsWith(p)

  return (
    <nav style={{background:'var(--surface)', borderBottom:'1px solid var(--ink-8)', position:'sticky', top:0, zIndex:100}}>
      <div className="container" style={{display:'flex', justifyContent:'space-between', alignItems:'center', height:64, gap:24}}>
        <div style={{display:'flex', alignItems:'center', gap:32}}>
          <Link to="/" style={{textDecoration:'none', display:'flex', alignItems:'center', gap:10}}>
            <div style={{width:32, height:32, background:'var(--registry-navy)', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontFamily:'Fraunces', fontWeight:800}}>A</div>
            <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:20, color:'var(--ink)'}}>AasthiChain</span>
            <span style={{fontSize:10, fontWeight:700, textTransform:'uppercase', background:'var(--paper)', border:'1px solid var(--ink-8)', padding:'3px 6px', borderRadius:4, color:'var(--ink-60)'}}>Drunix</span>
            <span style={{fontSize:9, fontWeight:700, textTransform:'uppercase', background:'rgba(98,116,142,0.12)', border:'1px solid rgba(98,116,142,0.2)', padding:'2px 5px', borderRadius:4, color:'var(--registry-navy)'}}>Clerk</span>
          </Link>
          {internalUser && (
            <div style={{display:'flex', gap:4}}>
              {[
                { path: '/marketplace', label: 'Marketplace' },
                { path: '/wallet', label: 'Wallet' },
                ...(internalUser.role === 'Originator' || internalUser.role === 'Registrar' ? [{ path: '/admin', label: 'Admin' }] : []),
                ...(internalUser.role === 'Regulator' ? [{ path: '/regulator', label: 'Audit' }] : []),
              ].map(item => (
                <Link key={item.path} to={item.path} style={{textDecoration:'none', fontSize:13, fontWeight:600, padding:'8px 12px', borderRadius:6, color: isActive(item.path) ? 'var(--registry-navy)' : 'var(--ink-60)', background: isActive(item.path) ? 'rgba(30,58,95,0.08)' : 'transparent', border: isActive(item.path) ? '1px solid rgba(30,58,95,0.12)' : '1px solid transparent'}}>{item.label}</Link>
              ))}
            </div>
          )}
        </div>
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          {internalUser ? (
            <>
              <div style={{display:'flex', alignItems:'center', gap:8, background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:6, padding:'4px 8px'}}>
                <span style={{fontSize:10, fontWeight:700, textTransform:'uppercase', color:'var(--ink-40)'}}>Demo Role</span>
                <select value={internalUser.identityId} onChange={e=>{ const s=ROLES.find(r=>r.id===e.target.value); if(s) onRoleSwitch(s) }} style={{fontSize:12, fontWeight:600, background:'var(--surface)', border:'1px solid var(--ink-12)', borderRadius:4, padding:'4px 8px'}}>
                  {ROLES.map(r=> <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <span style={{fontSize:10, color:'var(--ink-40)', fontStyle:'italic'}}>demo-only</span>
              </div>
              <div style={{textAlign:'right', lineHeight:1.2}}>
                <div style={{fontSize:12, fontWeight:600}}>{clerkUser?.primaryEmailAddress?.emailAddress || internalUser.identityId}</div>
                <div style={{fontSize:10, color:'var(--ink-60)'}}>{internalUser.role} · {internalUser.mspId} · Clerk</div>
              </div>
              <UserButton afterSignOutUrl="/login" />
              <button className="btn btn-secondary" style={{padding:'8px 12px', fontSize:12}} onClick={onLogout}>Sign out</button>
            </>
          ) : (
            <Link to="/login" className="btn btn-primary" style={{textDecoration:'none', fontSize:13}}>Sign in</Link>
          )}
        </div>
      </div>
    </nav>
  )
}

function AppContentClerk({ setLegacyUser }) {
  const { isLoaded, isSignedIn, user: clerkUser } = useUser()
  const { getToken } = useAuth()
  const { signOut } = useClerk()
  const location = useLocation()

  const [internalUser, setInternalUser] = useState(() => {
    try { const s=localStorage.getItem('aasthi_user'); return s?JSON.parse(s):null } catch { return null }
  })
  const [clerkToken, setClerkToken] = useState(null)

  useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn || !clerkUser) {
      setInternalUser(null)
      localStorage.removeItem('aasthi_user')
      localStorage.removeItem('aasthi_token')
      setLegacyUser(null)
      return
    }

    const fetchToken = async () => {
      try {
        const t = await getToken()
        if (t) { setClerkToken(t); localStorage.setItem('aasthi_token', t) }
      } catch {}
    }
    fetchToken()

    const storedDemoId = getStoredClerkDemoIdentity()
    let selectedRole = ROLES.find(r=>r.id===storedDemoId) || ROLES[2]
    try {
      const metaRole = clerkUser.publicMetadata?.fabricRole || clerkUser.unsafeMetadata?.fabricRole
      if (metaRole) {
        const found = ROLES.find(r=>r.role===metaRole || r.id===metaRole)
        if (found) selectedRole = found
      }
    } catch {}

    const email = clerkUser.primaryEmailAddress?.emailAddress || clerkUser.emailAddresses?.[0]?.emailAddress || clerkUser.id

    const aasthiUser = {
      token: clerkToken || 'clerk-' + clerkUser.id,
      identityId: selectedRole.id,
      role: selectedRole.role,
      mspId: selectedRole.mspId,
      clerkId: clerkUser.id,
      clerkEmail: email,
      fabricMode: 'clerk'
    }
    localStorage.setItem('aasthi_user', JSON.stringify(aasthiUser))
    setInternalUser(aasthiUser)
    setLegacyUser(aasthiUser)
  }, [isLoaded, isSignedIn, clerkUser, clerkToken])

  const handleLogout = async () => {
    try {
      localStorage.removeItem('aasthi_user')
      localStorage.removeItem('aasthi_token')
      setInternalUser(null)
      setLegacyUser(null)
      await signOut()
    } catch { window.location.href='/login' }
  }

  const handleRoleSwitch = (roleData) => {
    localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)
    const updated = { ...internalUser, identityId: roleData.id, role: roleData.role, mspId: roleData.mspId }
    localStorage.setItem('aasthi_user', JSON.stringify(updated))
    setInternalUser(updated)
    setLegacyUser(updated)
    window.location.reload()
  }

  if (!isLoaded) {
    return <div className="container" style={{paddingTop:64, textAlign:'center', color:'var(--ink-60)'}}>Loading Clerk...</div>
  }

  return (
    <>
      <NavClerk internalUser={internalUser} clerkUser={clerkUser} onLogout={handleLogout} onRoleSwitch={handleRoleSwitch} />
      <main className="container" style={{paddingTop:32, paddingBottom:48}}>
        <Routes>
          <Route path="/login" element={<Login onLogin={setLegacyUser} />} />
          <Route path="/" element={internalUser ? <Navigate to="/marketplace" /> : <Navigate to="/login" />} />
          <Route path="/marketplace" element={internalUser ? <Marketplace user={internalUser} /> : <Navigate to="/login" />} />
          <Route path="/wallet" element={internalUser ? <Wallet user={internalUser} /> : <Navigate to="/login" />} />
          <Route path="/admin" element={internalUser ? <Admin user={internalUser} /> : <Navigate to="/login" />} />
          <Route path="/regulator" element={internalUser ? <Regulator user={internalUser} /> : <Navigate to="/login" />} />
          <Route path="/property/:id" element={internalUser ? <PropertyDetail user={internalUser} /> : <Navigate to="/login" />} />
        </Routes>
      </main>
      <Footer />
    </>
  )
}

// ================= ROOT =================
function LegacyRoot() {
  const [user, setUser] = useState(() => {
    try { const s=localStorage.getItem('aasthi_user'); return s?JSON.parse(s):null } catch { return null }
  })
  return (
    <BrowserRouter>
      <AppContentLegacy user={user} setUser={setUser} />
    </BrowserRouter>
  )
}

function ClerkRoot() {
  const [user, setUser] = useState(() => {
    try { const s=localStorage.getItem('aasthi_user'); return s?JSON.parse(s):null } catch { return null }
  })
  return (
    <BrowserRouter>
      <AppContentClerk setLegacyUser={setUser} />
    </BrowserRouter>
  )
}

export default function App() {
  if (isClerkConfigured) {
    return <ClerkRoot />
  }
  return <LegacyRoot />
}
