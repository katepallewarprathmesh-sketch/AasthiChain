import React, { useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { SignIn, useUser, useAuth, Show, ClerkLoading, ClerkLoaded } from '@clerk/react'

const isClerkConfigured = (() => {
  const k = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
  return k && k.startsWith('pk_') && !k.includes('placeholder') && !k.includes('your-key-here') && k.length > 20
})()

const ROLES = [
  { id: 'originator1', role: 'Originator', label: 'Property Owner', mspId: 'OriginatorMSP', desc: 'List & tokenize', color:'#1E3A5F' },
  { id: 'registrar1', role: 'Registrar', label: 'Registrar', mspId: 'RegistrarMSP', desc: 'Validate title', color:'#059669' },
  { id: 'investor1', role: 'Investor', label: 'Investor', mspId: 'InvestorMSP', desc: 'Buy via UPI', color:'#7C3AED' },
  { id: 'regulator1', role: 'Regulator', label: 'Regulator', mspId: 'RegulatorMSP', desc: 'Audit & freeze', color:'#DC2626' },
]

function DemoPresets({ onLogin, title }) {
  const navigate = useNavigate()
  const [loadingId, setLoadingId] = React.useState(null)

  const handleDemo = (roleData) => {
    setLoadingId(roleData.id)
    try {
      const token = btoa(JSON.stringify({ identityId: roleData.id, role: roleData.role, mspId: roleData.mspId, exp: Date.now()+3600000 }))
      const demoUser = {
        token,
        identityId: roleData.id,
        role: roleData.role,
        mspId: roleData.mspId,
        fabricMode: 'demo',
        isDemo: true
      }
      localStorage.setItem('aasthi_user', JSON.stringify(demoUser))
      localStorage.setItem('aasthi_token', token)
      localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)
      onLogin(demoUser)
      navigate('/marketplace')
    } catch (e) {
      console.error('demo login failed', e)
      setLoadingId(null)
    }
  }

  return (
    <div style={{marginTop:24}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
        <h3 style={{fontSize:13, fontWeight:700}}>{title || 'Quick Demo Access — Instant, no verification'}</h3>
        <span style={{fontSize:9, background:'#F0FDF4', color:'#065F46', border:'1px solid #BBF7D0', padding:'3px 8px', borderRadius:20, fontWeight:600}}>LIVE + LOCAL</span>
      </div>
      <p style={{fontSize:11, color:'#64748B', marginBottom:12}}>Works on LIVE https://aasthi-chain.vercel.app + local npm run dev — mock JWT, no Clerk network, &lt;1s, no email verification</p>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
        {ROLES.map(r => (
          <button key={r.id} onClick={()=>handleDemo(r)} disabled={!!loadingId} style={{textAlign:'left', background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:12, padding:12, cursor:'pointer'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <div style={{width:24, height:24, background:r.color, color:'white', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700}}>{r.label[0]}</div>
              <span style={{fontSize:9, background:'white', border:'1px solid #E2E8F0', padding:'2px 6px', borderRadius:10, color:'#64748B'}}>{r.id}</span>
            </div>
            <div style={{fontSize:12, fontWeight:600, marginTop:8}}>{r.label}</div>
            <div style={{fontSize:10, color:'#64748B', marginTop:2}}>{r.desc} · {r.role}</div>
            <div style={{fontSize:10, color:r.color, fontWeight:600, marginTop:6}}>{loadingId===r.id ? 'Signing in...' : 'Instant access →'}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div style={{maxWidth:400, margin:'80px auto', textAlign:'center'}}>
      <div style={{width:32, height:32, border:'3px solid #E5E7EB', borderTopColor:'#1E3A5F', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto'}}></div>
      <div style={{fontSize:13, color:'#6B7280', marginTop:12}}>Loading sign-in...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

function ClerkLogin({ onLogin }) {
  const navigate = useNavigate()
  const { isLoaded, isSignedIn, user } = useUser()
  const { getToken } = useAuth()

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) return
    const doLogin = async () => {
      try {
        let token = null
        try { token = await getToken() } catch {}
        const email = user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress || user.id
        const aasthiUser = {
          token: token || 'clerk-' + user.id,
          identityId: 'investor1',
          role: 'Investor',
          mspId: 'InvestorMSP',
          clerkId: user.id,
          clerkEmail: email,
          fabricMode: 'clerk'
        }
        localStorage.setItem('aasthi_user', JSON.stringify(aasthiUser))
        if (token) localStorage.setItem('aasthi_token', token)
        onLogin(aasthiUser)
        navigate('/marketplace')
      } catch (err) {
        console.error('[Clerk] Login failed:', err)
      }
    }
    doLogin()
  }, [isLoaded, isSignedIn, user])

  return (
    <>
      <ClerkLoading><LoadingSkeleton /></ClerkLoading>
      <ClerkLoaded>
        <div style={{maxWidth:520, margin:'40px auto', padding:'0 16px'}}>
          <div style={{textAlign:'center', marginBottom:24}}>
            <Link to="/" style={{textDecoration:'none', display:'inline-flex', alignItems:'center', gap:8, marginBottom:16}}>
              <div style={{width:36, height:36, background:'#1E3A5F', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:800}}>A</div>
              <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:20, color:'#111827'}}>AasthiChain</span>
            </Link>
            <h1 style={{fontSize:24, fontWeight:700, color:'#111827'}}>Sign in to AasthiChain</h1>
            <p style={{fontSize:13, color:'#6B7280', marginTop:6}}>Clerk auth available — or use instant demo presets below (no verification, works LIVE + local)</p>
          </div>

          <div className="card" style={{padding:20}}>
            <div style={{display:'flex', justifyContent:'center', marginBottom:16}}>
              <Show when="signed-out">
                <SignIn 
                  afterSignInUrl="/marketplace" 
                  afterSignUpUrl="/marketplace"
                  appearance={{
                    elements: {
                      socialButtonsBlockButton: { background:'white', border:'1px solid #E5E7EB', fontWeight:600 },
                      formButtonPrimary: { background:'#1E3A5F', fontWeight:600 },
                      card: { boxShadow:'none', border:'none' },
                      headerTitle: { fontFamily:'Fraunces', fontWeight:700, fontSize:18 },
                    },
                    layout: {
                      socialButtonsPlacement: 'top',
                      socialButtonsVariant: 'blockButton'
                    }
                  }}
                />
              </Show>
              <Show when="signed-in">
                <div style={{textAlign:'center', padding:24}}>
                  <div style={{fontSize:14, fontWeight:600}}>Already signed in — redirecting to marketplace...</div>
                  <div style={{width:20, height:20, border:'2px solid #E5E7EB', borderTopColor:'#1E3A5F', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'16px auto 0'}}></div>
                </div>
              </Show>
            </div>

            <div style={{borderTop:'1px solid #F1F5F9', paddingTop:16}}>
              <DemoPresets onLogin={onLogin} title="Or — Quick Demo Access (bypass Clerk, instant)" />
            </div>
          </div>

          <div style={{textAlign:'center', marginTop:16}}>
            <Link to="/" style={{fontSize:12, color:'#6B7280', textDecoration:'none'}}>← Back to home — https://aasthi-chain.vercel.app</Link>
          </div>
        </div>
      </ClerkLoaded>
    </>
  )
}

function SimpleLogin({ onLogin }) {
  const navigate = useNavigate()

  return (
    <div style={{maxWidth:520, margin:'40px auto', padding:'0 16px'}}>
      <div style={{textAlign:'center', marginBottom:20}}>
        <div style={{display:'inline-flex', alignItems:'center', gap:10, marginBottom:12}}>
          <div style={{width:40, height:40, background:'#1E3A5F', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:800, fontSize:20}}>A</div>
          <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:22}}>AasthiChain</span>
        </div>
        <h1 style={{fontSize:24, fontWeight:700}}>Sign in</h1>
        <p style={{fontSize:13, color:'#6B7280', marginTop:8}}>One easy auth — demo presets work LIVE + local, no verification</p>
      </div>
      
      <div className="card" style={{padding:20}}>
        <p style={{fontSize:11, color:'#6B7280', marginBottom:8}}>Clerk not configured in this env (.env missing VITE_CLERK_PUBLISHABLE_KEY) — using demo auth. On LIVE https://aasthi-chain.vercel.app Clerk IS configured, but demo presets still work instantly below.</p>
        <DemoPresets onLogin={onLogin} title="Quick Demo Access — Click any role" />
        <div style={{marginTop:16, textAlign:'center'}}>
          <Link to="/" style={{fontSize:12, color:'#6B7280', textDecoration:'none'}}>← Back to home — https://aasthi-chain.vercel.app</Link>
        </div>
      </div>

      <div style={{marginTop:12, fontSize:11, color:'#9CA3AF', textAlign:'center'}}>
        LIVE: https://aasthi-chain.vercel.app — presets work live + local · No email verification · &lt;2s from page load
      </div>
    </div>
  )
}

export default function Login({ onLogin }) {
  if (isClerkConfigured) {
    return <ClerkLogin onLogin={onLogin} />
  }
  return <SimpleLogin onLogin={onLogin} />
}
