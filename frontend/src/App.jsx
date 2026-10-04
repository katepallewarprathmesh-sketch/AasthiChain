import React, { useState, useEffect, Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { trackPageview } from './lib/track'
import { applySeo } from './lib/seo'

// Error Boundary to catch blank screen errors shows error instead of blank per §1.4 voice
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
            <h3 style={{color:'#991B1B'}}>Something went wrong but your payment is safe</h3>
            <p style={{fontSize:13, color:'#6B7280', marginTop:8, lineHeight:1.5}}>
              The screen error was caught to prevent blank screen. Your payment and tokens move together atomically if one fails, both refunded no risk. Please refresh or try again.
            </p>
            <pre style={{marginTop:12, background:'white', padding:10, borderRadius:6, fontSize:11, overflow:'auto', maxHeight:200, border:'1px solid #FECACA'}}>
              {String(this.state.error?.message || this.state.error || 'Unknown error')}
              {this.state.info?.componentStack ? '\n' + this.state.info.componentStack.slice(0,500) : ''}
            </pre>
            <div style={{marginTop:12, display:'flex', gap:8, flexWrap:'wrap'}}>
              <button className="btn btn-primary" style={{fontSize:12}} onClick={()=>window.location.reload()}>Refresh Page</button>
              <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>this.setState({hasError:false, error:null, info:null})}>Try Again</button>
              <a href="/marketplace" className="btn btn-secondary" style={{fontSize:12, textDecoration:'none'}}>Back to Marketplace</a>
            </div>
            <div style={{fontSize:10, color:'#9CA3AF', marginTop:8}}>Error caught by boundary prevents blank screen check console for details</div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
import { useUser, useAuth, useClerk, UserButton, SignInButton, ClerkLoading, ClerkLoaded } from '@clerk/react'

// Landing is the first screen for almost every visitor, so it stays in the
// initial bundle. Everything else is fetched on demand, which keeps the first
// download small and the site interactive almost immediately.
import Landing from './pages/Landing.jsx'

const Login = lazy(() => import('./pages/Login.jsx'))
const Marketplace = lazy(() => import('./pages/Marketplace.jsx'))
const Wallet = lazy(() => import('./pages/Wallet.jsx'))
const Admin = lazy(() => import('./pages/Admin.jsx'))
const Regulator = lazy(() => import('./pages/Regulator.jsx'))
const PropertyDetail = lazy(() => import('./pages/PropertyDetail.jsx'))
const Support = lazy(() => import('./pages/Support.jsx'))
const LedgerExplorer = lazy(() => import('./pages/LedgerExplorer.jsx'))
const InvestorDashboard = lazy(() => import('./pages/InvestorDashboard.jsx'))
const Insights = lazy(() => import('./pages/Insights.jsx'))
const UMISettlement = lazy(() => import('./pages/UMISettlement.jsx')) // UMI rail (additive)
// Public free tools. No auth, no API calls - they exist to be found in search
// and to be useful on their own.
const ToolsIndex = lazy(() => import('./pages/tools/ToolsIndex.jsx'))
const RentalYieldCalculator = lazy(() => import('./pages/tools/RentalYieldCalculator.jsx'))
const FractionalCalculator = lazy(() => import('./pages/tools/FractionalCalculator.jsx'))
// Trust pages. People and AI agents both check these before trusting a site.
const About = lazy(() => import('./pages/legal/About.jsx'))
const Privacy = lazy(() => import('./pages/legal/Privacy.jsx'))
const Terms = lazy(() => import('./pages/legal/Terms.jsx'))

function RouteFallback() {
  return (
    <div style={{minHeight:'60vh', display:'flex', alignItems:'center', justifyContent:'center'}}>
      <div style={{width:28, height:28, border:'3px solid rgba(127,127,127,0.25)', borderTopColor:'#1E3A5F', borderRadius:'50%', animation:'spin 0.8s linear infinite'}} />
    </div>
  )
}

// Warm the most likely next screens once the browser is idle, so the first
// click after landing feels instant instead of triggering a cold fetch.
function prefetchLikelyRoutes() {
  const run = () => {
    import('./pages/Marketplace.jsx')
    import('./pages/Login.jsx')
    import('./pages/PropertyDetail.jsx')
  }
  if (typeof window === 'undefined') return
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 2500 })
  else setTimeout(run, 1200)
}

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

function useIsMobile(breakpoint = 860) {
  const [m, setM] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(max-width: ${breakpoint}px)`).matches : false))
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const on = () => setM(mq.matches)
    if (mq.addEventListener) mq.addEventListener('change', on)
    else mq.addListener(on)
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on) }
  }, [])
  return m
}

function getChromeTheme() {
  try { return localStorage.getItem('aasthi_theme') || 'dark' } catch { return 'dark' }
}

// Landing-scoped theme: Nav/Footer adapt (dark glass on the landing, light in-app)
function useChromeTheme(isLanding) {
  const [theme, setTheme] = useState(getChromeTheme)
  useEffect(() => {
    const onTheme = (e) => setTheme(e.detail || getChromeTheme())
    const onStorage = () => setTheme(getChromeTheme())
    window.addEventListener('aasthi-theme', onTheme)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('aasthi-theme', onTheme); window.removeEventListener('storage', onStorage) }
  }, [])
  return isLanding ? theme : 'light'
}

function Footer() {
  const location = useLocation()
  const look = useChromeTheme(location.pathname === '/')
  const dark = look === 'dark'
  const isMobileF = useIsMobile()
  const line = dark ? 'rgba(255,255,255,0.08)' : '#E5E7EB'
  const head = dark ? '#EAEEF5' : '#111827'
  const mut = dark ? '#9DA9BC' : '#6B7280'
  const faint = dark ? '#64718A' : '#9CA3AF'

  const cols = [
    { h: 'Product', links: [['Marketplace', '/marketplace'], ['My Wallet', '/wallet'], ['List a Property', '/admin'], ['Regulator Audit', '/regulator']] },
    { h: 'Platform', links: [['How it works', '/#how-it-works'], ['Free calculators', '/tools'], ['Trust & Transparency', '/#trust'], ['Support the project', '/support']] },
    { h: 'Legal', links: [['About', '/about'], ['Privacy', '/privacy'], ['Terms of Use', '/terms']] },
  ]

  return (
    <footer className="site-footer" data-look={look} style={{ padding: '44px 0 28px', marginTop: 0 }}>
      <div className="container">
        <div style={{ display: 'grid', gridTemplateColumns: isMobileF ? '1fr' : '1.6fr 1fr 1fr 1fr', gap: isMobileF ? 26 : 32 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, background: dark ? 'linear-gradient(145deg,#A9C6F4,#5F8BD4)' : '#1E3A5F', display: 'flex', alignItems: 'center', justifyContent: 'center', color: dark ? '#0A1422' : 'white', fontFamily: 'Fraunces, Georgia, serif', fontWeight: 800 }}>A</div>
              <span style={{ fontFamily: 'Fraunces, Georgia, serif', fontWeight: 700, fontSize: 18, color: head }}>AasthiChain</span>
            </div>
            <p style={{ fontSize: 12.5, color: mut, lineHeight: 1.7, marginTop: 12, maxWidth: '38ch' }}>
              Fractional ownership of verified Indian real estate from ₹500. Secure UPI payments, atomic settlement on NPCI Drunix.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {['Built on NPCI Drunix', 'UPI · IMPS rails', 'Testnet simulation'].map(t => (
                <span key={t} style={{ fontSize: 10.5, padding: '5px 10px', borderRadius: 999, border: `1px solid ${line}`, color: mut }}>{t}</span>
              ))}
            </div>
          </div>
          {cols.map(c => (
            <div key={c.h}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: faint }}>{c.h}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 14 }}>
                {c.links.map(([label, to]) => (
                  <a key={label} href={to} style={{ fontSize: 13, color: mut, textDecoration: 'none' }}
                    onMouseEnter={e => e.target.style.color = head} onMouseLeave={e => e.target.style.color = mut}>{label}</a>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${line}`, marginTop: 34, paddingTop: 18, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ fontSize: 11, color: faint }}>
            © 2024 AasthiChain • Own property from ₹500 • Settled on NPCI Drunix • Made for everyone
          </div>
          <div style={{ fontSize: 10.5, color: faint, maxWidth: '52ch' }}>
            UPI rail is a clearly-labeled testnet simulation (no live NPCI credentials). Aligned with the Asset Tokenisation (Regulation) Bill 2026 pending legislation.
          </div>
        </div>
      </div>
    </footer>
  )
}

function Nav({ user, onLogout, onRoleSwitch }) {
  const location = useLocation()
  const isActive = (p) => location.pathname === p || location.pathname.startsWith(p)
  const isLanding = location.pathname === '/'
  const theme = useChromeTheme(isLanding)
  const dark = isLanding && theme === 'dark'
  const isMobile = useIsMobile()
  // Signed-in phones get a two-row navbar so role + sign out are always reachable
  const twoRow = isMobile && !!user

  const bg = dark ? 'transparent' : '#FFFFFF'
  const border = dark ? 'rgba(255,255,255,0.07)' : '#E5E7EB'
  const text = dark ? '#EAEEF5' : '#111827'
  const mut = dark ? '#9DA9BC' : '#6B7280'
  const chipBg = dark ? 'rgba(255,255,255,0.06)' : '#F9FAFB'
  const chipBorder = dark ? 'rgba(255,255,255,0.12)' : '#E5E7EB'
  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark'
    try { localStorage.setItem('aasthi_theme', next) } catch {}
    window.dispatchEvent(new CustomEvent('aasthi-theme', { detail: next }))
  }

  return (
    <nav className="site-nav" data-look={dark ? 'dark' : 'light'} style={{ position: 'sticky', top: 0, zIndex: 100, background: bg, borderBottom: `1px solid ${border}` }}>
      <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: twoRow ? 'flex-start' : 'center', flexWrap: twoRow ? 'wrap' : undefined, height: twoRow ? undefined : (isMobile ? 56 : 64), gap: isMobile ? 10 : 24, rowGap: twoRow ? 0 : undefined, padding: twoRow ? '2px 12px' : (isMobile ? '0 12px' : undefined) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: twoRow ? 10 : 22, flex: twoRow ? '1 1 100%' : undefined, minHeight: twoRow ? 50 : undefined }}>
          <Link to="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: dark ? 'linear-gradient(145deg,#A9C6F4,#5F8BD4)' : '#1E3A5F', display: 'flex', alignItems: 'center', justifyContent: 'center', color: dark ? '#0A1422' : 'white', fontFamily: 'Fraunces, Georgia, serif', fontWeight: 800, flexShrink: 0 }}>A</div>
            {!isMobile && <span style={{ fontFamily: 'Fraunces, Georgia, serif', fontWeight: 700, fontSize: 18, color: text }}>AasthiChain</span>}
          </Link>
          <div className="site-nav-links" style={{ flex: isMobile ? '1 1 auto' : undefined, minWidth: 0 }}>
            {(user
              ? [
                  { path: '/dashboard', label: 'Dashboard' },
                  { path: '/marketplace', label: 'Marketplace' },
                  { path: '/wallet', label: 'Wallet' },
                  { path: '/ledger', label: 'Ledger' },
                  { path: '/umi', label: 'UMI' },
                  ...(user.role === 'Originator' || user.role === 'Registrar' ? [{ path: '/admin', label: 'Admin' }] : []),
                  ...(user.role === 'Regulator' ? [{ path: '/regulator', label: 'Audit' }] : []),
                ]
              : [{ path: '/', label: 'Home' }]
            ).map(item => (
              <Link key={item.path} to={item.path} style={{
                textDecoration: 'none', fontSize: isMobile ? 12.5 : 13, fontWeight: 500, padding: isMobile ? '6px 9px' : '8px 12px', borderRadius: 8, whiteSpace: 'nowrap', flexShrink: 0,
                color: isActive(item.path) ? (dark ? '#EAEEF5' : '#1E3A5F') : mut,
                background: isActive(item.path) ? (dark ? 'rgba(255,255,255,0.08)' : '#F1F5F9') : 'transparent',
              }}>{item.label}</Link>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 10, flexShrink: 0, flex: twoRow ? '1 1 100%' : undefined, justifyContent: twoRow ? 'space-between' : undefined, borderTop: twoRow ? `1px solid ${border}` : undefined, padding: twoRow ? '7px 0' : undefined }}>
          {isLanding && (
            <button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`} style={{ color: mut }} title="Toggle light / dark">
              {dark ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/></svg>
              )}
            </button>
          )}
          {user ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: chipBg, border: `1px solid ${chipBorder}`, borderRadius: 8, padding: '4px 8px' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: dark ? '#64718A' : '#9CA3AF' }}>ROLE</span>
                <select value={user.identityId} onChange={e => { const s = ROLES.find(r => r.id === e.target.value); if (s) onRoleSwitch(s) }} style={{ fontSize: isMobile ? 11 : 12, fontWeight: 600, background: dark ? '#101623' : 'white', color: text, border: `1px solid ${chipBorder}`, borderRadius: 6, padding: isMobile ? '3px 4px' : '4px 8px', maxWidth: twoRow ? 130 : isMobile ? 110 : undefined }}>
                  {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </div>
              {isClerkConfigured && (
                <>
                  <ClerkLoading><div style={{ width: 28, height: 28, background: chipBg, borderRadius: '50%' }}></div></ClerkLoading>
                  <ClerkLoaded><UserButton afterSignOutUrl="/" /></ClerkLoaded>
                </>
              )}
              <button onClick={onLogout} style={{ padding: isMobile ? '6px 8px' : '8px 12px', fontSize: isMobile ? 11 : 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer', background: 'transparent', color: mut, border: `1px solid ${chipBorder}` }}>Sign out</button>
            </>
          ) : (
            <Link to="/login" style={{ textDecoration: 'none', padding: isMobile ? '8px 12px' : '9px 16px', fontSize: isMobile ? 12 : 13, fontWeight: 600, borderRadius: 9, background: dark ? 'linear-gradient(180deg,#A9C6F4,#7FA8E8)' : '#1E3A5F', color: dark ? '#0A1422' : 'white', boxShadow: dark ? '0 8px 24px -8px rgba(127,168,232,0.5)' : 'none', flexShrink: 0 }}>
              Sign in
            </Link>
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
  const location = useLocation()

  useEffect(() => { setInternalUser(user) }, [user])

  useEffect(() => { prefetchLikelyRoutes() }, [])

  // First-party pageview beacon. Fires on every route change; silent, honours
  // Do Not Track, and cannot throw into the render path.
  useEffect(() => { trackPageview(location.pathname) }, [location.pathname])

  // Per-route title, description, canonical and robots directive. A SPA
  // otherwise shows search engines the same metadata on every URL.
  useEffect(() => { applySeo(location.pathname) }, [location.pathname])

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

  // Public pages must never wait on the auth SDK — they render immediately and
  // Clerk finishes initialising in the background. Only auth-gated routes pause.
  const PUBLIC_PATHS = ['/', '/login', '/ledger', '/support', '/umi']
  const isPublicPath = PUBLIC_PATHS.includes(location.pathname)

  if (isClerkConfigured && !isLoaded && !isPublicPath) {
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
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Landing user={effectiveUser} />} />
          <Route path="/login" element={<Login onLogin={setUser} />} />
          <Route path="/marketplace" element={<Marketplace user={effectiveUser} />} />
          <Route path="/dashboard" element={effectiveUser ? <InvestorDashboard user={effectiveUser} /> : <Navigate to="/login" />} />
          {/* Private operator dashboard: no nav link, guarded server-side by ADMIN_DASHBOARD_KEY */}
          <Route path="/insights" element={<Insights />} />
          <Route path="/wallet" element={effectiveUser ? <Wallet user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/ledger" element={<LedgerExplorer />} />
          <Route path="/umi" element={<UMISettlement />} />
          <Route path="/support" element={<Support />} />
          <Route path="/about" element={<About />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/tools" element={<ToolsIndex />} />
          <Route path="/tools/rental-yield-calculator" element={<RentalYieldCalculator />} />
          <Route path="/tools/fractional-investment-calculator" element={<FractionalCalculator />} />
          <Route path="/admin" element={effectiveUser ? <Admin user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/regulator" element={effectiveUser ? <Regulator user={effectiveUser} /> : <Navigate to="/login" />} />
          <Route path="/property/:id" element={<PropertyDetail user={effectiveUser} />} />
        </Routes>
        </Suspense>
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
