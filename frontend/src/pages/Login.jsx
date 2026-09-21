import React, { useState, useEffect, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import { SignIn, useUser, useAuth, Show, ClerkLoading, ClerkLoaded, SignInButton } from '@clerk/react'

const isClerkConfigured = (() => {
  const k = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
  return k && k.startsWith('pk_') && !k.includes('placeholder') && !k.includes('your-key-here') && k.length > 20
})()

const ROLES = [
  { id: 'originator1', role: 'Originator', label: 'Originator', desc: 'List property, initiate tokenization', color: '#1E3A5F', mspId: 'OriginatorMSP', icon: '🏗️' },
  { id: 'registrar1', role: 'Registrar', label: 'Registrar', desc: 'Validate legal title, co-sign mint', color: '#D97706', mspId: 'RegistrarMSP', icon: '✓' },
  { id: 'investor1', role: 'Investor', label: 'Investor', desc: 'Buy, hold, transfer tokens', color: '#059669', mspId: 'InvestorMSP', icon: '💼' },
  { id: 'investor2', role: 'Investor', label: 'Investor 2', desc: 'Second investor for transfers', color: '#059669', mspId: 'InvestorMSP', icon: '💼' },
  { id: 'regulator1', role: 'Regulator', label: 'Regulator', desc: 'Audit & compliance view', color: '#111827', mspId: 'RegulatorMSP', icon: '🛡️' },
]

function LoadingSkeleton() {
  return (
    <div style={{display:'flex', flexDirection:'column', gap:12, alignItems:'center', padding:24}}>
      <div style={{width:32, height:32, border:'3px solid #E5E7EB', borderTopColor:'#1E3A5F', borderRadius:'50%', animation:'spin 0.8s linear infinite'}}></div>
      <div style={{fontSize:13, color:'#6B7280'}}>Loading authentication...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

// ONE AUTH — easy and accessible for all
export default function Login({ onLogin }) {
  const navigate = useNavigate()
  const [selectedRoleId, setSelectedRoleId] = useState(() => {
    try { return localStorage.getItem('aasthi_clerk_demo_identity') || 'investor1' } catch { return 'investor1' }
  })
  const [loading, setLoading] = useState(false)

  // Clerk hooks — only used when Clerk is configured, but safe to call inside ClerkLoaded
  const clerkUser = isClerkConfigured ? useUser() : { isLoaded: true, isSignedIn: false, user: null }
  const clerkAuth = isClerkConfigured ? useAuth() : { getToken: async () => null }

  useEffect(() => {
    if (!isClerkConfigured) return
    if (!clerkUser.isLoaded || !clerkUser.isSignedIn || !clerkUser.user) return
    
    const roleData = ROLES.find(r => r.id === selectedRoleId) || ROLES[2]
    const doLogin = async () => {
      try {
        let token = null
        try { token = await clerkAuth.getToken() } catch {}
        const email = clerkUser.user.primaryEmailAddress?.emailAddress || clerkUser.user.emailAddresses?.[0]?.emailAddress || clerkUser.user.id
        const aasthiUser = {
          token: token || 'clerk-' + clerkUser.user.id,
          identityId: roleData.id,
          role: roleData.role,
          mspId: roleData.mspId,
          clerkId: clerkUser.user.id,
          clerkEmail: email,
          fabricMode: 'clerk'
        }
        localStorage.setItem('aasthi_user', JSON.stringify(aasthiUser))
        if (token) localStorage.setItem('aasthi_token', token)
        onLogin(aasthiUser)
        navigate('/marketplace')
      } catch (err) {
        console.error('[Clerk] Login mapping failed:', err)
      }
    }
    doLogin()
  }, [clerkUser.isLoaded, clerkUser.isSignedIn, clerkUser.user])

  useEffect(() => {
    try { localStorage.setItem('aasthi_clerk_demo_identity', selectedRoleId) } catch {}
  }, [selectedRoleId])

  const handleDemoLogin = async (roleData) => {
    try {
      setLoading(true)
      console.log('[Auth] One-click demo login as', roleData.label)
      const mockUser = {
        token: btoa(JSON.stringify({ identityId: roleData.id, role: roleData.role, mspId: roleData.mspId })),
        identityId: roleData.id,
        role: roleData.role,
        mspId: roleData.mspId,
        fabricMode: 'demo',
        isDemo: true
      }
      localStorage.setItem('aasthi_user', JSON.stringify(mockUser))
      localStorage.setItem('aasthi_token', mockUser.token)
      localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)
      onLogin(mockUser)
      navigate('/marketplace')
    } catch (err) {
      console.error('[Auth] Demo login failed:', err)
    } finally {
      setLoading(false)
    }
  }

  const selectedRole = ROLES.find(r => r.id === selectedRoleId) || ROLES[2]

  return (
    <div style={{maxWidth:520, margin:'0 auto', padding:'24px 16px'}}>
      {/* Header */}
      <div style={{textAlign:'center', marginBottom:28}}>
        <div style={{display:'inline-flex', alignItems:'center', gap:10, marginBottom:12}}>
          <div style={{width:40, height:40, background:'#1E3A5F', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontFamily:'Fraunces', fontWeight:800, fontSize:20}}>A</div>
          <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:24, color:'#111827'}}>AasthiChain</span>
        </div>
        <h1 style={{fontSize:26, fontWeight:700, color:'#111827', marginBottom:6}}>Welcome — choose your role</h1>
        <p style={{fontSize:13, color:'#6B7280', lineHeight:1.5}}>One-click demo access for all. No email codes, no friction. Pick a role and explore instantly.</p>
        {isClerkConfigured && (
          <div style={{marginTop:10, display:'inline-flex', alignItems:'center', gap:6, background:'#F0FDF4', border:'1px solid #BBF7D0', padding:'4px 10px', borderRadius:20, fontSize:11, color:'#059669', fontWeight:600}}>
            <span style={{width:6, height:6, borderRadius:'50%', background:'#059669', display:'inline-block'}}></span>
            Secure auth enabled — demo is instant, Clerk available
          </div>
        )}
      </div>

      {/* ONE AUTH — Easy role grid */}
      <div className="card" style={{padding:20, marginBottom:16}}>
        <h3 style={{fontSize:14, fontWeight:700, marginBottom:4}}>Continue as</h3>
        <p style={{fontSize:12, color:'#6B7280', marginBottom:16}}>Same easy flow for judges, testers, investors — one click, no verification.</p>
        
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
          {ROLES.map(r => {
            const isSelected = selectedRoleId === r.id
            return (
              <button
                key={r.id}
                onClick={() => handleDemoLogin(r)}
                disabled={loading}
                style={{
                  textAlign:'left', padding:'14px 12px', borderRadius:12,
                  border: isSelected ? `2px solid ${r.color}` : '1px solid #E5E7EB',
                  background: isSelected ? '#F8FAFC' : 'white',
                  cursor:'pointer', transition:'all 0.15s',
                  opacity: loading ? 0.6 : 1,
                  display:'flex', flexDirection:'column', gap:6,
                  boxShadow: isSelected ? `0 0 0 3px ${r.color}15` : 'none'
                }}
              >
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', width:'100%'}}>
                  <span style={{fontSize:18}}>{r.icon}</span>
                  <span style={{fontSize:10, fontWeight:700, color: isSelected ? r.color : '#9CA3AF', background: isSelected ? `${r.color}15` : '#F3F4F6', padding:'2px 6px', borderRadius:10}}>
                    {isSelected ? 'Selected' : r.role}
                  </span>
                </div>
                <div style={{fontSize:13, fontWeight:700, color:'#111827'}}>{r.label}</div>
                <div style={{fontSize:11, color:'#6B7280', lineHeight:1.3}}>{r.desc}</div>
                <div style={{fontSize:11, fontWeight:700, color:r.color, marginTop:4, display:'flex', alignItems:'center', gap:4}}>
                  → Continue <span style={{fontSize:12}}>↗</span>
                </div>
              </button>
            )
          })}
        </div>

        <div style={{marginTop:16, padding:'10px 12px', background:'#F9FAFB', border:'1px solid #F3F4F6', borderRadius:8, display:'flex', gap:8, alignItems:'flex-start'}}>
          <span style={{fontSize:12}}>💡</span>
          <div style={{fontSize:11, color:'#6B7280', lineHeight:1.5}}>
            <strong style={{color:'#111827'}}>One auth for all:</strong> No email codes. Click any role to enter marketplace instantly. Balances are pre-seeded for demo. Works on Vercel production domain.
          </div>
        </div>
      </div>

      {/* Secondary — Clerk for real users, but not required */}
      {isClerkConfigured ? (
        <div className="card" style={{padding:20}}>
          <ClerkLoading>
            <LoadingSkeleton />
          </ClerkLoading>
          <ClerkLoaded>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
              <h3 style={{fontSize:13, fontWeight:700}}>Or secure sign-in</h3>
              <span style={{fontSize:10, color:'#6B7280'}}>Optional — for real accounts</span>
            </div>
            
            <Show when="signed-out">
              <div style={{display:'flex', flexDirection:'column', gap:10}}>
                <div style={{display:'flex', gap:8}}>
                  <SignInButton mode="modal">
                    <button className="btn btn-secondary" style={{flex:1, fontSize:12, padding:'10px'}}>Sign in with Clerk modal</button>
                  </SignInButton>
                </div>
                
                <div style={{position:'relative', textAlign:'center', margin:'8px 0'}}>
                  <div style={{height:1, background:'#E5E7EB'}}></div>
                  <span style={{position:'absolute', top:-8, left:'50%', transform:'translateX(-50%)', background:'white', padding:'0 8px', fontSize:10, color:'#9CA3AF'}}>OR</span>
                </div>

                <Suspense fallback={<LoadingSkeleton />}>
                  <div style={{display:'flex', justifyContent:'center'}}>
                    <SignIn 
                      afterSignInUrl="/marketplace" 
                      afterSignUpUrl="/marketplace"
                      appearance={{
                        elements: {
                          socialButtonsBlockButton: { background:'white', border:'1px solid #E5E7EB', fontWeight:600 },
                          formButtonPrimary: { background:'#1E3A5F' },
                          card: { boxShadow:'none', border:'none', padding:0 },
                          header: { display:'none' }, // Hide header, we have our own
                          footer: { fontSize:11 }
                        },
                        layout: {
                          socialButtonsPlacement: 'top',
                          socialButtonsVariant: 'blockButton'
                        }
                      }}
                    />
                  </div>
                </Suspense>
              </div>
            </Show>

            <Show when="signed-in">
              <div style={{textAlign:'center', padding:16}}>
                <div style={{fontSize:13, fontWeight:600}}>Already signed in — redirecting...</div>
                <div style={{fontSize:11, color:'#6B7280', marginTop:4}}>Role: {selectedRole.label} will be used in marketplace</div>
              </div>
            </Show>
          </ClerkLoaded>
        </div>
      ) : (
        <div style={{textAlign:'center', fontSize:11, color:'#9CA3AF', marginTop:8}}>
          Demo auth active — set VITE_CLERK_PUBLISHABLE_KEY to enable Clerk as secondary option
        </div>
      )}

      <div style={{textAlign:'center', marginTop:16, fontSize:10, color:'#9CA3AF'}}>
        AasthiChain v1.9 · One easy auth for all · No email verification friction
      </div>
    </div>
  )
}
