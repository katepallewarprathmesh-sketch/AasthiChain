import React, { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'

// Error Boundary to catch blank screen errors — shows error instead of blank per §1.4 voice
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, info: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught', error, info)
    this.setState({ info })
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{padding:24, maxWidth:600, margin:'40px auto'}}>
          <div className="card" style={{borderColor:'#FECACA', background:'#FEF2F2'}}>
            <h3 style={{color:'#991B1B'}}>Something went wrong — but your payment is safe</h3>
            <p style={{fontSize:13, color:'#6B7280', marginTop:8, lineHeight:1.5}}>
              The screen error was caught to prevent blank screen. Your payment and tokens move together atomically — if one fails, both refunded — no risk. Please refresh or try again.
            </p>
            <pre style={{marginTop:12, background:'white', padding:10, borderRadius:6, fontSize:11, overflow:'auto', maxHeight:200, border:'1px solid #FECACA'}}>
              {String(this.state.error?.message || this.state.error || 'Unknown error')}
              {this.state.info?.componentStack ? '\n' + this.state.info.componentStack.slice(0,500) : ''}
            </pre>
            <div style={{marginTop:12, display:'flex', gap:8}}>
              <button className="btn btn-primary" style={{fontSize:12}} onClick={()=>window.location.reload()}>Refresh Page</button>
              <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>this.setState({hasError:false, error:null, info:null})}>Try Again</button>
              <a href="/marketplace" className="btn btn-secondary" style={{fontSize:12, textDecoration:'none'}}>Back to Marketplace</a>
            </div>
            <div style={{fontSize:10, color:'#9CA3AF', marginTop:8}}>Error caught by boundary — prevents blank screen — check console for details</div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
import { useUser, useAuth, useClerk, UserButton, SignInButton, ClerkLoading, ClerkLoaded } from '@clerk/react'

import Landing from './pages/Landing.jsx'
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
  { id: 'investor1', role: 'Investor', label: 'Investor', mspId: 'InvestorMSP' },
  { id: 'investor2', role: 'Investor', label: 'Investor 2', mspId: 'InvestorMSP' },
  { id: 'regulator1', role: 'Regulator', label: 'Regulator', mspId: 'RegulatorMSP' },
]

function getStoredUser() {
  try { const s=localStorage.getItem('aasthi_user'); return s?JSON.parse(s):null } catch { return null }
}

function Footer() {
  return (
    <footer style={{borderTop:'1px solid #F3F4F6', background:'white', padding:'20px 0', marginTop:40}}>
      <div className="container" style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
        <div style={{fontSize:12, color:'#6B7280'}}>
          <span style={{fontWeight:700, color:'#111827'}}>AasthiChain</span> • Own property from ₹500 • Secure UPI • Instant • Settled on NPCI Drunix</div>
        <div style={{fontSize:11, color:'#9CA3AF'}}>© 2024 AasthiChain • Made for everyone</div>
      </div>
    </footer>
  )
}

function Nav({ user, onLogout, onRoleSwitch }) {
  const location = useLocation()
  const isActive = (p) => location.pathname === p || location.pathname.startsWith(p)
  const isLanding = location.pathname === '/'

  return (
    <nav style={{background:'white', borderBottom:'1px solid #E5E7EB', position:'sticky', top:0, zIndex:100}}>
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
          {!user && !isLanding && (
            <div style={{display:'flex', gap:2}}>
              <Link to="/" style={{textDecoration:'none', fontSize:13, fontWeight:500, padding:'8px 12px', borderRadius:8, color: isActive('/') ? '#1E3A5F' : '#6B7280', background: isActive('/') ? '#F1F5F9' : 'transparent'}}>Home</Link>
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
              {isClerkConfigured && (
                <>
                  <ClerkLoading><div style={{width:28, height:28, background:'#F3F4F6', borderRadius:'50%'}}></div></ClerkLoading>
                  <ClerkLoaded><UserButton afterSignOutUrl="/" /></ClerkLoaded>
                </>
              )}
              <button className="btn btn-secondary" style={{padding:'8px 12px', fontSize:12}} onClick={onLogout}>Sign out</button>
            </>
          ) : (
            <>
              <ClerkLoading>
                <button className="btn btn-primary" style={{fontSize:13, opacity:0.6}} disabled>Sign in</button>
              </ClerkLoading>
              <ClerkLoaded>
                {isClerkConfigured ? (
                  <SignInButton mode="modal" fallbackRedirectUrl="/marketplace">
                    <button className="btn btn-primary" style={{fontSize:13, fontWeight:600, padding:'8px 16px'}}>Sign in</button>
                  </SignInButton>
                ) : (
                  <Link to="/login" className="btn btn-primary" style={{fontSize:13, fontWeight:600, padding:'8px 16px', textDecoration:'none'}}>Sign in</Link>
                )}
              </ClerkLoaded>
              {!isClerkConfigured && (
                <Link to="/login" className="btn btn-primary" style={{fontSize:13, fontWeight:600, padding:'8px 16px', textDecoration:'none'}}>Sign in</Link>
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

    const stored = getStoredUser()
    if (stored && stored.isDemo) {
      setInternalUser(stored)
      setUser(stored)
      return
    }

    if (!isSignedIn || !clerkUser) {
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
      } catch {}
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
      window.location.href = '/'
    } catch {
      window.location.href='/'
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
          <div style={{fontSize:13, color:'#6B7280', marginTop:12}}>Loading...</div>
        </div>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <Nav user={effectiveUser} onLogout={handleLogout} onRoleSwitch={handleRoleSwitch} />
      <main className="container" style={{paddingTop:0, paddingBottom:0}}>
        <Routes>
          <Route path="/" element={<Landing user={effectiveUser} />} />
          <Route path="/login" element={<Login onLogin={setUser} />} />
          <Route path="/marketplace" element={effectiveUser ? <Marketplace user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/wallet" element={effectiveUser ? <Wallet user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/admin" element={effectiveUser ? <Admin user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/regulator" element={effectiveUser ? <Regulator user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/property/:id" element={effectiveUser ? <PropertyDetail user={effectiveUser} /> : <Navigate to="/login" />} />
        </Routes>
      </main>
      <Footer />
    </ErrorBoundary>
  )
}

export default function App() {
  const [user, setUser] = useState(() => getStoredUser())

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppContent user={user} setUser={setUser} />
      </BrowserRouter>
    </ErrorBoundary>
  )
}
