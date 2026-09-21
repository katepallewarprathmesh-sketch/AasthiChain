import React, { useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { SignIn, useUser, useAuth, Show, ClerkLoading, ClerkLoaded } from '@clerk/react'

const isClerkConfigured = (() => {
  const k = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
  return k && k.startsWith('pk_') && !k.includes('placeholder') && !k.includes('your-key-here') && k.length > 20
})()

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
        <div style={{maxWidth:480, margin:'40px auto', padding:'0 16px'}}>
          <div style={{textAlign:'center', marginBottom:24}}>
            <Link to="/" style={{textDecoration:'none', display:'inline-flex', alignItems:'center', gap:8, marginBottom:16}}>
              <div style={{width:36, height:36, background:'#1E3A5F', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:800}}>A</div>
              <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:20, color:'#111827'}}>AasthiChain</span>
            </Link>
            <h1 style={{fontSize:24, fontWeight:700, color:'#111827'}}>Sign in to AasthiChain</h1>
            <p style={{fontSize:13, color:'#6B7280', marginTop:6}}>Secure authentication via Clerk — one easy sign-in for all</p>
          </div>

          <div className="card" style={{padding:24, display:'flex', justifyContent:'center'}}>
            <Show when="signed-out">
              <SignIn 
                afterSignInUrl="/marketplace" 
                afterSignUpUrl="/marketplace"
                appearance={{
                  elements: {
                    socialButtonsBlockButton: { background:'white', border:'1px solid #E5E7EB', fontWeight:600 },
                    formButtonPrimary: { background:'#1E3A5F', fontWeight:600 },
                    card: { boxShadow:'none', border:'none' },
                    headerTitle: { fontFamily:'Fraunces', fontWeight:700, fontSize:20 },
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

          <div style={{textAlign:'center', marginTop:16}}>
            <Link to="/" style={{fontSize:12, color:'#6B7280', textDecoration:'none'}}>← Back to home — learn about AasthiChain</Link>
          </div>
        </div>
      </ClerkLoaded>
    </>
  )
}

function SimpleLogin({ onLogin }) {
  const navigate = useNavigate()
  const [loading, setLoading] = React.useState(false)

  const handleQuickSignIn = () => {
    setLoading(true)
    const mockUser = {
      token: btoa(JSON.stringify({ identityId: 'investor1', role: 'Investor', mspId: 'InvestorMSP' })),
      identityId: 'investor1',
      role: 'Investor',
      mspId: 'InvestorMSP',
      fabricMode: 'demo'
    }
    localStorage.setItem('aasthi_user', JSON.stringify(mockUser))
    localStorage.setItem('aasthi_token', mockUser.token)
    onLogin(mockUser)
    navigate('/marketplace')
  }

  return (
    <div style={{maxWidth:440, margin:'60px auto', padding:'0 16px', textAlign:'center'}}>
      <div style={{display:'inline-flex', alignItems:'center', gap:10, marginBottom:20}}>
        <div style={{width:40, height:40, background:'#1E3A5F', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:800, fontSize:20}}>A</div>
        <span style={{fontFamily:'Fraunces', fontWeight:700, fontSize:22}}>AasthiChain</span>
      </div>
      <h1 style={{fontSize:24, fontWeight:700}}>Sign in</h1>
      <p style={{fontSize:13, color:'#6B7280', marginTop:8}}>One easy sign-in for all — no demo complexity</p>
      
      <div className="card" style={{marginTop:20, padding:24}}>
        <p style={{fontSize:12, color:'#6B7280', marginBottom:16}}>Clerk not configured. Using quick sign-in for development.</p>
        <button onClick={handleQuickSignIn} disabled={loading} className="btn btn-primary" style={{width:'100%', padding:'12px', fontSize:14}}>
          {loading ? 'Signing in...' : 'Sign in as Investor →'}
        </button>
        <div style={{marginTop:16}}>
          <Link to="/" style={{fontSize:12, color:'#6B7280', textDecoration:'none'}}>← Back to home</Link>
        </div>
      </div>

      <div style={{marginTop:12, fontSize:11, color:'#9CA3AF'}}>
        Set VITE_CLERK_PUBLISHABLE_KEY in .env to enable Clerk — sign in from top corner
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
