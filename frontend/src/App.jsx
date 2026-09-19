import React, { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import Login from './pages/Login.jsx'
import Marketplace from './pages/Marketplace.jsx'
import Wallet from './pages/Wallet.jsx'
import Admin from './pages/Admin.jsx'
import Regulator from './pages/Regulator.jsx'
import PropertyDetail from './pages/PropertyDetail.jsx'

function Nav({ user, onLogout, onRoleSwitch }) {
  const location = useLocation()
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path)
  
  const roles = [
    { id: 'originator1', role: 'Originator', label: 'Originator' },
    { id: 'registrar1', role: 'Registrar', label: 'Registrar' },
    { id: 'investor1', role: 'Investor', label: 'Investor 1' },
    { id: 'investor2', role: 'Investor', label: 'Investor 2' },
    { id: 'regulator1', role: 'Regulator', label: 'Regulator' },
  ]

  return (
    <nav style={{background:'var(--surface)', borderBottom:'1px solid var(--ink-8)', position:'sticky', top:0, zIndex:20}}>
      <div className="container" style={{display:'flex', justifyContent:'space-between', alignItems:'center', height:64, gap:24}}>
        <div style={{display:'flex', alignItems:'center', gap:32}}>
          <Link to="/" style={{textDecoration:'none', display:'flex', alignItems:'center', gap:10}}>
            <div style={{width:32, height:32, background:'var(--registry-navy)', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontFamily:'Fraunces', fontWeight:800, fontSize:16}}>A</div>
            <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:20, color:'var(--ink)', letterSpacing:'-0.02em'}}>AasthiChain</span>
            <span style={{fontSize:10, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', background:'var(--paper)', border:'1px solid var(--ink-8)', padding:'3px 6px', borderRadius:4, color:'var(--ink-60)'}}>Drunix</span>
          </Link>
          {user && (
            <div style={{display:'flex', gap:4}}>
              {[
                { path: '/marketplace', label: 'Marketplace' },
                { path: '/wallet', label: 'Wallet' },
                ...(user.role === 'Originator' || user.role === 'Registrar' ? [{ path: '/admin', label: 'Admin' }] : []),
                ...(user.role === 'Regulator' ? [{ path: '/regulator', label: 'Audit' }] : []),
              ].map(item => (
                <Link key={item.path} to={item.path} 
                  style={{
                    textDecoration:'none', fontSize:13, fontWeight:600, padding:'8px 12px', borderRadius:6,
                    color: isActive(item.path) ? 'var(--registry-navy)' : 'var(--ink-60)',
                    background: isActive(item.path) ? 'rgba(30,58,95,0.08)' : 'transparent',
                    border: isActive(item.path) ? '1px solid rgba(30,58,95,0.12)' : '1px solid transparent'
                  }}>
                  {item.label}
                </Link>
              ))}
            </div>
          )}
        </div>

        <div style={{display:'flex', alignItems:'center', gap:12}}>
          {user ? (
            <>
              {/* Demo-only role switcher per §5.4 */}
              <div style={{display:'flex', alignItems:'center', gap:8, background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:6, padding:'4px 8px'}}>
                <span style={{fontSize:10, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)'}}>Demo Role</span>
                <select value={user.identityId} onChange={e=>{
                  const selected = roles.find(r=>r.id===e.target.value)
                  if (selected) onRoleSwitch(selected)
                }} style={{fontSize:12, fontWeight:600, background:'var(--surface)', border:'1px solid var(--ink-12)', borderRadius:4, padding:'4px 8px', color:'var(--ink)'}}>
                  {roles.map(r=> <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <span style={{fontSize:10, color:'var(--ink-40)', fontStyle:'italic'}}>demo-only</span>
              </div>

              <div style={{textAlign:'right', lineHeight:1.2}}>
                <div style={{fontSize:12, fontWeight:600, color:'var(--ink)'}}>{user.identityId}</div>
                <div style={{fontSize:10, color:'var(--ink-60)'}}>{user.role} · {user.mspId}</div>
              </div>
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

function AppContent({ user, setUser }) {
  const handleLogout = () => {
    localStorage.removeItem('aasthi_user')
    localStorage.removeItem('aasthi_token')
    setUser(null)
  }

  const handleRoleSwitch = (roleData) => {
    // Demo-only role switching per §5.4 - no re-login needed
    const mspMap = { Originator: 'OriginatorMSP', Registrar: 'RegistrarMSP', Investor: 'InvestorMSP', Regulator: 'RegulatorMSP' }
    const mockUser = {
      token: btoa(JSON.stringify({ identityId: roleData.id, role: roleData.role, mspId: mspMap[roleData.role] })),
      identityId: roleData.id,
      role: roleData.role,
      mspId: mspMap[roleData.role]
    }
    localStorage.setItem('aasthi_user', JSON.stringify(mockUser))
    localStorage.setItem('aasthi_token', mockUser.token)
    setUser(mockUser)
    // Force reload to update wallet etc
    window.location.reload()
  }

  return (
    <>
      <Nav user={user} onLogout={handleLogout} onRoleSwitch={handleRoleSwitch} />
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
      <footer style={{borderTop:'1px solid var(--ink-8)', background:'var(--surface)', padding:'24px 0'}}>
        <div className="container" style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
          <div style={{fontSize:12, color:'var(--ink-40)'}}>
            <span style={{fontFamily:'Fraunces', fontWeight:600, color:'var(--ink)'}}>AasthiChain</span> v1.1 · Production-Ready · Registry-office grade, not crypto-trading aesthetic
          </div>
          <div style={{fontSize:11, color:'var(--ink-40)', maxWidth:'60ch', textAlign:'right'}}>
            On-chain token ≠ Registration Act, 1908 · KYC/Payment pluggable · SPV structure for legal title per Phase-2
          </div>
        </div>
      </footer>
    </>
  )
}

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('aasthi_user')
    return saved ? JSON.parse(saved) : null
  })

  return (
    <BrowserRouter>
      <AppContent user={user} setUser={setUser} />
    </BrowserRouter>
  )
}
