import React, { useState, useEffect, Suspense, lazy } from 'react'
import { useNavigate } from 'react-router-dom'
import { SignIn, useUser, useAuth, Show, ClerkLoading, ClerkLoaded, SignInButton, SignUpButton } from '@clerk/react'

const isClerkConfigured = (() => {
  const k = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
  return k && k.startsWith('pk_') && !k.includes('placeholder') && !k.includes('your-key-here') && k.length > 20
})()

// Demo bypass flag — enabled for hackathon demo so judges don't need email code
const ENABLE_DEMO_BYPASS = import.meta.env.VITE_ENABLE_DEMO_BYPASS !== 'false' // default true for demo

const ROLES = [
  { id: 'originator1', role: 'Originator', label: 'Originator', desc: 'Lists property, initiates tokenization', color: 'var(--registry-navy)', mspId: 'OriginatorMSP', demoEmail: 'originator@aasthi.demo', demoPassword: 'demo123' },
  { id: 'registrar1', role: 'Registrar', label: 'Registrar', desc: 'Validates legal title, co-signs mint', color: 'var(--pending-amber)', mspId: 'RegistrarMSP', demoEmail: 'registrar@aasthi.demo', demoPassword: 'demo123' },
  { id: 'investor1', role: 'Investor', label: 'Investor 1', desc: 'Buys, holds, transfers — KYC Verified', color: 'var(--verified-green)', mspId: 'InvestorMSP', demoEmail: 'investor1@aasthi.demo', demoPassword: 'demo123' },
  { id: 'investor2', role: 'Investor', label: 'Investor 2', desc: 'Second investor for peer transfer demo', color: 'var(--verified-green)', mspId: 'InvestorMSP', demoEmail: 'investor2@aasthi.demo', demoPassword: 'demo123' },
  { id: 'regulator1', role: 'Regulator', label: 'Regulator', desc: 'Read-only audit, emergency freeze', color: 'var(--ink)', mspId: 'RegulatorMSP', demoEmail: 'regulator@aasthi.demo', demoPassword: 'demo123' },
]

// Lazy-load Clerk SignIn for performance — doesn't block initial render
const LazySignIn = lazy(() => Promise.resolve({ default: SignIn }))

function ClerkLoadingSkeleton() {
  return (
    <div style={{maxWidth:520, margin:'32px auto'}}>
      <div style={{marginBottom:24}}>
        <div style={{width:200, height:32, background:'var(--ink-8)', borderRadius:6, animation:'pulse 1.5s infinite'}}></div>
        <div style={{width:'100%', height:16, background:'var(--ink-8)', borderRadius:4, marginTop:12, animation:'pulse 1.5s infinite'}}></div>
      </div>
      <div className="card" style={{padding:24, display:'flex', flexDirection:'column', gap:12, alignItems:'center'}}>
        <div style={{width:32, height:32, border:'3px solid var(--ink-8)', borderTopColor:'var(--registry-navy)', borderRadius:'50%', animation:'spin 0.8s linear infinite'}}></div>
        <div style={{fontSize:13, color:'var(--ink-60)'}}>Loading secure sign-in...</div>
        <div style={{fontSize:11, color:'var(--ink-40)'}}>Clerk widget initializing — 1-2 seconds</div>
      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.5 } }
      `}</style>
    </div>
  )
}

function ClerkLogin({ onLogin }) {
  const navigate = useNavigate()
  const { isLoaded, isSignedIn, user } = useUser()
  const { getToken } = useAuth()
  const [selectedRoleId, setSelectedRoleId] = useState(() => {
    try { return localStorage.getItem('aasthi_clerk_demo_identity') || 'investor1' } catch { return 'investor1' }
  })
  const [demoLoading, setDemoLoading] = useState(false)

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) return
    const roleData = ROLES.find(r => r.id === selectedRoleId) || ROLES[2]
    localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)

    const doLogin = async () => {
      try {
        let token = null
        try { token = await getToken() } catch (e) { console.warn('[Clerk] getToken failed:', e) }
        const email = user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress || user.id
        const aasthiUser = {
          token: token || 'clerk-' + user.id,
          identityId: roleData.id,
          role: roleData.role,
          mspId: roleData.mspId,
          clerkId: user.id,
          clerkEmail: email,
          fabricMode: 'clerk'
        }
        localStorage.setItem('aasthi_user', JSON.stringify(aasthiUser))
        if (token) localStorage.setItem('aasthi_token', token)
        console.log('[Clerk] Demo role mapped:', roleData.id, '→', roleData.role, '— navigating to marketplace')
        onLogin(aasthiUser)
        navigate('/marketplace')
      } catch (err) {
        console.error('[Clerk] Login mapping failed:', err)
      }
    }
    doLogin()
  }, [isLoaded, isSignedIn, user])

  useEffect(() => {
    localStorage.setItem('aasthi_clerk_demo_identity', selectedRoleId)
  }, [selectedRoleId])

  const handleDemoBypass = async (roleData) => {
    try {
      setDemoLoading(true)
      console.log('[Demo Bypass] Continuing as', roleData.label, '— bypassing email-code verification for hackathon demo')
      // Dev-only bypass: creates mock user without Clerk verification — for judges/testers
      const mockUser = {
        token: btoa(JSON.stringify({ identityId: roleData.id, role: roleData.role, mspId: roleData.mspId })),
        identityId: roleData.id,
        role: roleData.role,
        mspId: roleData.mspId,
        clerkEmail: roleData.demoEmail,
        fabricMode: 'demo-bypass',
        isDemoBypass: true
      }
      localStorage.setItem('aasthi_user', JSON.stringify(mockUser))
      localStorage.setItem('aasthi_token', mockUser.token)
      localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)
      onLogin(mockUser)
      navigate('/marketplace')
    } catch (err) {
      console.error('[Demo Bypass] Failed:', err)
    } finally {
      setDemoLoading(false)
    }
  }

  return (
    <>
      <ClerkLoading>
        <ClerkLoadingSkeleton />
      </ClerkLoading>
      <ClerkLoaded>
        <div style={{maxWidth:560, margin:'24px auto'}}>
          <div style={{marginBottom:20}}>
            <h1 className="display" style={{fontSize:32, marginBottom:8}}>AasthiChain</h1>
            <p style={{color:'var(--ink-60)', fontSize:14, lineHeight:1.5}}>Fractional real estate on Drunix — secure, registry-grade. Clerk handles auth, Fabric handles ledger.</p>
            <div style={{marginTop:12, display:'flex', gap:8, flexWrap:'wrap'}}>
              <div style={{display:'inline-flex', alignItems:'center', gap:6, background:'rgba(98,116,142,0.1)', border:'1px solid rgba(98,116,142,0.2)', padding:'4px 8px', borderRadius:6, fontSize:11, color:'var(--registry-navy)', fontWeight:600}}>
                <span style={{width:6, height:6, borderRadius:'50%', background:'var(--verified-green)', display:'inline-block'}}></span>
                Clerk Auth — @clerk/react v6
              </div>
              <div style={{display:'inline-flex', alignItems:'center', gap:6, background:'rgba(34,197,94,0.1)', border:'1px solid rgba(34,197,94,0.2)', padding:'4px 8px', borderRadius:6, fontSize:11, color:'var(--verified-green)', fontWeight:600}}>
                ⚡ Instant modal — Sign in opens in 1-2s
              </div>
            </div>
          </div>

          {ENABLE_DEMO_BYPASS && (
            <div className="card" style={{marginBottom:16, borderColor:'rgba(34,197,94,0.3)', background:'rgba(34,197,94,0.04)'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
                <h3 style={{fontSize:14, fontWeight:700, color:'var(--verified-green)'}}>⚡ Quick Demo Access — No Email Code Needed</h3>
                <span style={{fontSize:10, background:'var(--verified-green)', color:'white', padding:'2px 6px', borderRadius:4, fontWeight:700}}>FOR JUDGES</span>
              </div>
              <p style={{fontSize:11, color:'var(--ink-60)', marginBottom:12, lineHeight:1.5}}>
                Skip email verification for demo. Continue as pre-seeded demo persona — bypasses Clerk email-code flow. Full Clerk flow (Google OAuth + email-code) still available below for real sign-ups.
              </p>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
                {ROLES.map(r => (
                  <button 
                    key={r.id} 
                    onClick={() => handleDemoBypass(r)}
                    disabled={demoLoading}
                    style={{
                      textAlign:'left', padding:'10px 12px', borderRadius:8,
                      border: selectedRoleId===r.id ? `2px solid ${r.color}` : '1px solid var(--ink-12)',
                      background: selectedRoleId===r.id ? 'var(--surface)' : 'white',
                      cursor:'pointer', display:'flex', flexDirection:'column', gap:2,
                      opacity: demoLoading ? 0.6 : 1
                    }}
                  >
                    <div style={{fontSize:12, fontWeight:700, color:'var(--ink)', display:'flex', alignItems:'center', gap:6}}>
                      {r.label} {selectedRoleId===r.id && <span style={{fontSize:10, color:r.color}}>●</span>}
                    </div>
                    <div style={{fontSize:10, color:'var(--ink-60)'}}>{r.role} · {r.mspId}</div>
                    <div style={{fontSize:10, color:'var(--verified-green)', fontWeight:600, marginTop:2}}>→ Continue instantly</div>
                  </button>
                ))}
              </div>
              <div style={{marginTop:10, fontSize:10, color:'var(--ink-40)', display:'flex', alignItems:'center', gap:4}}>
                <span>💡</span> Demo bypass uses mock JWT — no email needed. For production, use Google OAuth or email-code below.
              </div>
            </div>
          )}

          <div className="card" style={{marginBottom:16}}>
            <h3 style={{fontSize:14, fontWeight:600, marginBottom:8}}>Select Fabric Role</h3>
            <p style={{fontSize:11, color:'var(--ink-60)', marginBottom:12}}>Clerk verifies identity; role controls ledger permissions. Demo mapping.</p>
            <div style={{display:'grid', gap:6}}>
              {ROLES.map(p => (
                <button key={p.id} type="button" onClick={() => setSelectedRoleId(p.id)}
                  style={{
                    textAlign:'left', padding:'10px 12px', borderRadius:'var(--radius)',
                    border: selectedRoleId===p.id ? `1px solid ${p.color}` : 'var(--hairline)',
                    background: selectedRoleId===p.id ? 'var(--surface)' : 'var(--paper)',
                    cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center'
                  }}>
                  <div>
                    <div style={{fontSize:12, fontWeight:600}}>{p.label} <span style={{fontSize:10, color:'var(--ink-40)'}}>— {p.id}</span></div>
                    <div style={{fontSize:10, color:'var(--ink-60)', marginTop:2}}>{p.desc} · {p.mspId}</div>
                  </div>
                  <div style={{width:8, height:8, borderRadius:'50%', background: p.color}}></div>
                </button>
              ))}
            </div>
          </div>

          <div className="card" style={{padding:'20px', display:'flex', flexDirection:'column', gap:16}}>
            <div>
              <h3 style={{fontSize:14, fontWeight:600}}>Real Authentication — Clerk</h3>
              <p style={{fontSize:11, color:'var(--ink-60)', marginTop:4}}>Google OAuth is primary (top), email+code is fallback. Full verification for real users — demo bypass above for judges.</p>
            </div>
            
            <Suspense fallback={<ClerkLoadingSkeleton />}>
              <div style={{display:'flex', justifyContent:'center'}}>
                <Show when="signed-out">
                  <div style={{width:'100%'}}>
                    <SignIn 
                      afterSignInUrl="/marketplace" 
                      afterSignUpUrl="/marketplace"
                      appearance={{
                        elements: {
                          socialButtonsBlockButton: { 
                            background:'white', 
                            border:'1px solid var(--ink-12)',
                            fontWeight:600,
                            order: -1
                          },
                          socialButtonsBlockButtonText: { fontWeight:600, color:'var(--ink)' },
                          formButtonPrimary: { background:'var(--registry-navy)', fontWeight:600 },
                          card: { boxShadow:'none', border:'none' },
                          headerTitle: { fontFamily:'Fraunces', fontWeight:700 },
                          formFieldLabel: { fontWeight:600, fontSize:13 }
                        },
                        layout: {
                          socialButtonsPlacement: 'top',
                          socialButtonsVariant: 'blockButton',
                          showOptionalFields: false
                        }
                      }}
                    />
                  </div>
                </Show>
                <Show when="signed-in">
                  <div style={{textAlign:'center', padding:'24px'}}>
                    <div style={{fontSize:14, fontWeight:600, marginBottom:8}}>Signed in as {user?.primaryEmailAddress?.emailAddress || user?.username || 'user'}</div>
                    <div style={{fontSize:12, color:'var(--ink-60)', marginBottom:16}}>Role: {ROLES.find(r=>r.id===selectedRoleId)?.label} — Redirecting to marketplace...</div>
                    <div style={{width:20, height:20, border:'2px solid var(--ink-12)', borderTopColor:'var(--registry-navy)', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto'}}></div>
                  </div>
                </Show>
              </div>
            </Suspense>

            <div style={{borderTop:'1px solid var(--ink-8)', paddingTop:12, display:'flex', gap:8, flexWrap:'wrap'}}>
              <SignInButton mode="modal">
                <button className="btn btn-secondary" style={{fontSize:12, flex:1}}>Open Sign In Modal (test instant open)</button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button className="btn btn-secondary" style={{fontSize:12, flex:1}}>Open Sign Up Modal</button>
              </SignUpButton>
            </div>

            <div style={{fontSize:10, color:'var(--ink-40)', lineHeight:1.5}}>
              <div>• Google OAuth is primary button (top) — faster than email-code</div>
              <div>• Email-code is fallback for real sign-ups</div>
              <div>• Demo bypass above skips verification for judges — instant access</div>
              <div>• Console shows [Clerk] logs for debugging sign-in button issues</div>
            </div>
          </div>
        </div>
      </ClerkLoaded>
    </>
  )
}

function LegacyLogin({ onLogin }) {
  const [identityId, setIdentityId] = useState('investor1')
  const [role, setRole] = useState('Investor')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      console.log('[Auth] Mock login attempt:', identityId, role)
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityId, role })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || data.error)
      localStorage.setItem('aasthi_user', JSON.stringify(data))
      localStorage.setItem('aasthi_token', data.token)
      onLogin(data)
      navigate('/marketplace')
    } catch (err) {
      console.warn('[Auth] API login failed, using mock fallback:', err.message)
      const mockMSP = { Originator: 'OriginatorMSP', Registrar: 'RegistrarMSP', Investor: 'InvestorMSP', Regulator: 'RegulatorMSP' }[role]
      const mockData = {
        token: btoa(JSON.stringify({ identityId, role, mspId: mockMSP })),
        identityId,
        role,
        mspId: mockMSP,
        fabricMode: 'mock'
      }
      localStorage.setItem('aasthi_user', JSON.stringify(mockData))
      localStorage.setItem('aasthi_token', mockData.token)
      onLogin(mockData)
      navigate('/marketplace')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{maxWidth:480, margin:'48px auto'}}>
      <div style={{marginBottom:32}}>
        <h1 className="display" style={{fontSize:36, marginBottom:8}}>AasthiChain</h1>
        <p style={{color:'var(--ink-60)', fontSize:15, lineHeight:1.5}}>Fractional real estate tokenization on Drunix. Registry-office grade — calm, structured.</p>
        <div style={{marginTop:12, display:'inline-flex', gap:6, background:'rgba(161,61,46,0.08)', border:'1px solid rgba(161,61,46,0.15)', padding:'4px 8px', borderRadius:6, fontSize:11, color:'var(--error-rust)'}}>
          Clerk not configured — mock auth. Set VITE_CLERK_PUBLISHABLE_KEY to enable Clerk.
        </div>
      </div>

      <div className="card">
        <h2 style={{fontSize:18, marginBottom:4}}>Sign in to your organization</h2>
        <p style={{fontSize:13, color:'var(--ink-60)', marginBottom:24}}>Select a role to demo multi-org flow.</p>

        <div style={{display:'flex', flexDirection:'column', gap:8, marginBottom:24}}>
          <label className="field-label">Quick role presets — demo</label>
          <div style={{display:'grid', gap:6}}>
            {ROLES.map(p => (
              <button key={p.id} type="button" onClick={() => { setIdentityId(p.id); setRole(p.role) }}
                style={{
                  textAlign:'left', padding:'12px', borderRadius:'var(--radius)',
                  border: identityId===p.id ? `1px solid ${p.color}` : 'var(--hairline)',
                  background: identityId===p.id ? 'var(--surface)' : 'var(--paper)',
                  cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center'
                }}>
                <div>
                  <div style={{fontSize:13, fontWeight:600}}>{p.label} <span style={{fontSize:11, color:'var(--ink-40)'}}>— {p.id}</span></div>
                  <div style={{fontSize:11, color:'var(--ink-60)', marginTop:2}}>{p.desc}</div>
                </div>
                <div style={{width:8, height:8, borderRadius:'50%', background: p.color}}></div>
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleLogin} style={{display:'flex', flexDirection:'column', gap:16}}>
          <div className="field-group">
            <label className="field-label">Identity ID</label>
            <input className="input" value={identityId} onChange={e=>setIdentityId(e.target.value)} placeholder="investor1" />
          </div>
          <div className="field-group">
            <label className="field-label">Organization</label>
            <select className="input" value={role} onChange={e=>setRole(e.target.value)}>
              <option value="Originator">Originator — OriginatorMSP</option>
              <option value="Registrar">Registrar — RegistrarMSP</option>
              <option value="Investor">Investor — InvestorMSP</option>
              <option value="Regulator">Regulator — RegulatorMSP</option>
            </select>
          </div>
          {error && <div style={{background:'rgba(161,61,46,0.08)', border:'1px solid rgba(161,61,46,0.15)', color:'var(--error-rust)', padding:'10px 12px', borderRadius:'var(--radius)', fontSize:13}}>{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={loading} style={{width:'100%', padding:'12px'}}>
            {loading ? 'Authenticating...' : `Sign in as ${role}`}
          </button>
          <div style={{fontSize:11, color:'var(--ink-40)', lineHeight:'1.6', borderTop:'var(--hairline)', paddingTop:12, marginTop:4}}>
            <div>• Mint requires AND('OriginatorMSP.peer','RegistrarMSP.peer')</div>
            <div>• KYC: investor1, investor2 pre-verified</div>
            <div>• Enable Clerk: dashboard.clerk.com → copy pk_test_... → .env → restart</div>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Login({ onLogin }) {
  if (isClerkConfigured) {
    return <ClerkLogin onLogin={onLogin} />
  }
  return <LegacyLogin onLogin={onLogin} />
}
