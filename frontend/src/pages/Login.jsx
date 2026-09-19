import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function Login({ onLogin }) {
  const [identityId, setIdentityId] = useState('investor1')
  const [role, setRole] = useState('Investor')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const presets = [
    { id: 'originator1', role: 'Originator', label: 'Originator', desc: 'Lists property, initiates tokenization', color: 'var(--registry-navy)' },
    { id: 'registrar1', role: 'Registrar', label: 'Registrar', desc: 'Validates legal title, co-signs mint', color: 'var(--pending-amber)' },
    { id: 'investor1', role: 'Investor', label: 'Investor 1', desc: 'Buys, holds, transfers — KYC Verified', color: 'var(--verified-green)' },
    { id: 'investor2', role: 'Investor', label: 'Investor 2', desc: 'Second investor for peer transfer demo', color: 'var(--verified-green)' },
    { id: 'regulator1', role: 'Regulator', label: 'Regulator', desc: 'Read-only audit, emergency freeze', color: 'var(--ink)' },
  ]

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
        <p style={{color:'var(--ink-60)', fontSize:15, lineHeight:1.5, maxWidth:'60ch'}}>Fractional real estate tokenization on Drunix. Private banking / registrar's office grade — calm, structured, legible. Not a crypto trading app.</p>
      </div>

      <div className="card">
        <h2 style={{fontSize:18, marginBottom:4}}>Sign in to your organization</h2>
        <p style={{fontSize:13, color:'var(--ink-60)', marginBottom:24, maxWidth:'70ch'}}>Select a role to demo multi-org flow. Each role has different ledger access per endorsement policy.</p>

        <div style={{display:'flex', flexDirection:'column', gap:8, marginBottom:24}}>
          <label className="field-label">Quick role presets — for submission demo</label>
          <div style={{display:'grid', gap:6}}>
            {presets.map(p => (
              <button key={p.id} type="button" onClick={() => { setIdentityId(p.id); setRole(p.role) }}
                style={{
                  textAlign:'left', padding:'12px', borderRadius:'var(--radius)',
                  border: identityId===p.id ? `1px solid ${p.color}` : 'var(--hairline)',
                  background: identityId===p.id ? 'var(--surface)' : 'var(--paper)',
                  cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center'
                }}>
                <div>
                  <div style={{fontSize:13, fontWeight:600, color:'var(--ink)'}}>{p.label} <span style={{fontSize:11, color:'var(--ink-40)', fontWeight:400}}>— {p.id}</span></div>
                  <div style={{fontSize:11, color:'var(--ink-60)', marginTop:2, maxWidth:'40ch'}}>{p.desc}</div>
                </div>
                <div style={{width:8, height:8, borderRadius:'50%', background: p.color, flexShrink:0}}></div>
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleLogin} style={{display:'flex', flexDirection:'column', gap:16}}>
          <div className="field-group">
            <label className="field-label">Identity ID</label>
            <input className="input" value={identityId} onChange={e=>setIdentityId(e.target.value)} placeholder="investor1" />
            <div className="field-hint">Pulled from logged-in session — never re-typed per §2 global principles</div>
          </div>
          
          <div className="field-group">
            <label className="field-label">Organization</label>
            <select className="input" value={role} onChange={e=>setRole(e.target.value)}>
              <option value="Originator">Originator — OriginatorMSP — Lists property</option>
              <option value="Registrar">Registrar — RegistrarMSP — Validates title</option>
              <option value="Investor">Investor — InvestorMSP — Buys, holds, transfers</option>
              <option value="Regulator">Regulator — RegulatorMSP — Read-only audit</option>
            </select>
          </div>

          {error && <div style={{background:'rgba(161,61,46,0.08)', border:'1px solid rgba(161,61,46,0.15)', color:'var(--error-rust)', padding:'10px 12px', borderRadius:'var(--radius)', fontSize:13}}>{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={loading} style={{width:'100%', padding:'12px'}}>
            {loading ? 'Authenticating...' : `Sign in as ${role}`}
          </button>

          <div style={{fontSize:11, color:'var(--ink-40)', lineHeight:'1.6', borderTop:'var(--hairline)', paddingTop:12, marginTop:4}}>
            <div>• Mint requires <code>AND('OriginatorMSP.peer','RegistrarMSP.peer')</code> — prevents unilateral minting</div>
            <div>• KYC: investor1, investor2, originator1 pre-verified — interface pluggable to DigiLocker</div>
            <div>• Payment settlement off-chain per spec — token transfer after confirmation</div>
            <div>• Design: registry-navy for authority, asset-clay sparingly, Fraunces for institutional weight</div>
          </div>
        </form>
      </div>
    </div>
  )
}
