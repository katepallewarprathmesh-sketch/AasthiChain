import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { SignIn, useUser, useAuth, Show } from '@clerk/react'

const isClerkConfigured = (() => {
  const k = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
  return k && k.startsWith('pk_') && !k.includes('placeholder') && !k.includes('your-key-here') && k.length > 20
})()

const ROLES = [
  { id: 'originator1', role: 'Originator', label: 'Originator', desc: 'Lists property, initiates tokenization', color: 'var(--registry-navy)', mspId: 'OriginatorMSP' },
  { id: 'registrar1', role: 'Registrar', label: 'Registrar', desc: 'Validates legal title, co-signs mint', color: 'var(--pending-amber)', mspId: 'RegistrarMSP' },
  { id: 'investor1', role: 'Investor', label: 'Investor 1', desc: 'Buys, holds, transfers — KYC Verified', color: 'var(--verified-green)', mspId: 'InvestorMSP' },
  { id: 'investor2', role: 'Investor', label: 'Investor 2', desc: 'Second investor for peer transfer demo', color: 'var(--verified-green)', mspId: 'InvestorMSP' },
  { id: 'regulator1', role: 'Regulator', label: 'Regulator', desc: 'Read-only audit, emergency freeze', color: 'var(--ink)', mspId: 'RegulatorMSP' },
]

function ClerkLogin({ onLogin }) {
  const navigate = useNavigate()
  const { isLoaded, isSignedIn, user } = useUser()
  const { getToken } = useAuth()
  const [selectedRoleId, setSelectedRoleId] = useState(() => {
    try { return localStorage.getItem('aasthi_clerk_demo_identity') || 'investor1' } catch { return 'investor1' }
  })

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) return
    const roleData = ROLES.find(r => r.id === selectedRoleId) || ROLES[2]
    localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)

    const doLogin = async () => {
      let token = null
      try { token = await getToken() } catch {}
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
      onLogin(aasthiUser)
      navigate('/marketplace')
    }
    doLogin()
  }, [isLoaded, isSignedIn, user])

  useEffect(() => {
    localStorage.setItem('aasthi_clerk_demo_identity', selectedRoleId)
  }, [selectedRoleId])

  return (
    <div style={{maxWidth:520, margin:'32px auto'}}>
      <div style={{marginBottom:24}}>
        <h1 className="display" style={{fontSize:32, marginBottom:8}}>AasthiChain</h1>
        <p style={{color:'var(--ink-60)', fontSize:14, lineHeight:1.5}}>Clerk-secured fractional real estate on Drunix. Registry-office grade.</p>
        <div style={{marginTop:12, display:'inline-flex', alignItems:'center', gap:6, background:'rgba(98,116,142,0.1)', border:'1px solid rgba(98,116,142,0.2)', padding:'4px 8px', borderRadius:6, fontSize:11, color:'var(--registry-navy)', fontWeight:600}}>
          <span style={{width:6, height:6, borderRadius:'50%', background:'var(--verified-green)', display:'inline-block'}}></span>
          Clerk Auth Enabled — @clerk/react v6
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <h3 style={{fontSize:14, fontWeight:600, marginBottom:8}}>Select Fabric Role (demo-only)</h3>
        <p style={{fontSize:11, color:'var(--ink-60)', marginBottom:12}}>Clerk verifies identity; role controls ledger permissions.</p>
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

      <div className="card" style={{display:'flex', justifyContent:'center', padding:'24px'}}>
        <Show when="signed-out">
          <SignIn afterSignInUrl="/marketplace" afterSignUpUrl="/marketplace" />
        </Show>
        <Show when="signed-in">
          <div style={{textAlign:'center', padding:'24px'}}>
            <div style={{fontSize:14, fontWeight:600, marginBottom:8}}>Signed in as {user?.primaryEmailAddress?.emailAddress || user?.username || 'user'}</div>
            <div style={{fontSize:12, color:'var(--ink-60)', marginBottom:16}}>Role: {ROLES.find(r=>r.id===selectedRoleId)?.label} — Redirecting...</div>
            <div style={{width:20, height:20, border:'2px solid var(--ink-12)', borderTopColor:'var(--registry-navy)', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto'}}></div>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        </Show>
      </div>
    </div>
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
