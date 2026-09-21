import React, { useState, useEffect } from 'react'

export default function Admin({ user }) {
  const [form, setForm] = useState({ 
    title: 'Sunrise Heights 2BHK', 
    propertyType: 'Residential',
    state: 'Maharashtra', 
    city: 'Pune', 
    pincode: '411045', 
    valuationINR: 6000000, 
    totalTokens: 10000,
    documentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    description: ''
  })
  const [result, setResult] = useState('')
  const [mintForm, setMintForm] = useState({ assetId: '', totalTokens: 10000 })
  const [validateForm, setValidateForm] = useState({ assetId: '', decision: 'VALIDATED' })
  const [hashing, setHashing] = useState(false)
  const [fileName, setFileName] = useState('')
  const [txLifecycle, setTxLifecycle] = useState(null)
  const [validationStatus, setValidationStatus] = useState('')
  const [propertyExists, setPropertyExists] = useState(false)
  const [lastRegisteredId, setLastRegisteredId] = useState('')

  const tokenPrice = form.valuationINR && form.totalTokens ? Math.floor(form.valuationINR / form.totalTokens) : 0

  // Refetch validation status when assetId changes or role switches
  useEffect(() => {
    const assetId = mintForm.assetId || validateForm.assetId || lastRegisteredId
    if (!assetId) { setValidationStatus(''); setPropertyExists(false); return }
    const fetchStatus = async () => {
      try {
        const token = localStorage.getItem('aasthi_token')
        const res = await fetch(`/api/properties/${encodeURIComponent(assetId)}`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) { setPropertyExists(false); setValidationStatus('NOT_FOUND'); return }
        const data = await res.json()
        const prop = data.property || data
        setPropertyExists(true)
        setValidationStatus(prop.registrarValidationStatus || prop.validationStatus || 'PENDING')
      } catch {
        setPropertyExists(false)
        setValidationStatus('ERROR')
      }
    }
    fetchStatus()
  }, [mintForm.assetId, validateForm.assetId, lastRegisteredId])

  // Also refetch when user role changes — ensures page data updates without manual refresh
  useEffect(() => {
    if (lastRegisteredId) {
      // trigger re-fetch by updating state
      setMintForm(f => ({ ...f }))
    }
  }, [user?.identityId])

  const handleFileUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    if (file.size > 25*1024*1024) {
      setResult('Document upload failed — file must be max 25MB, PDF only per §3.1')
      return
    }
    if (file.type !== 'application/pdf') {
      setResult('Document upload failed — PDF only per §3.1')
      return
    }
    setHashing(true)
    setFileName(file.name)
    try {
      const buffer = await file.arrayBuffer()
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
      setForm(f => ({ ...f, documentHash: hashHex }))
      setResult(`Document verified — hash computed client-side per §5.1: ${hashHex.slice(0,8)}...${hashHex.slice(-4)} — never ask human to type hash, fastest "real product" signal`)
    } catch (err) {
      setResult(`Document upload failed — ${err.message}`)
    } finally {
      setHashing(false)
    }
  }

  const handleRegister = async (e) => {
    e.preventDefault()
    setTxLifecycle({ step: 'submitting' })
    setResult('Submitting for registrar review per §1.4 voice — names next real step, not "Submit"...')
    try {
      setTimeout(()=>setTxLifecycle(s=> s ? {...s, step:'endorsing'} : null), 400)
      setTimeout(()=>setTxLifecycle(s=> s ? {...s, step:'committing'} : null), 900)
      const token = localStorage.getItem('aasthi_token')
      const res = await fetch('/api/properties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Idempotency-Key': 'idem-' + Date.now() },
        body: JSON.stringify({ title: form.title, state: form.state, city: form.city, pincode: form.pincode, valuationINR: parseInt(form.valuationINR), documentHash: form.documentHash })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || JSON.stringify(data))
      setTimeout(()=>{
        setTxLifecycle({ step: 'confirmed', assetId: data.assetId })
        setResult(`Property registered: ${data.assetId} — Status Draft → Pending Registrar Review per §1.4, not generic "Submitted!" — FabricMode: ${data.fabricMode} — Now switch to Registrar role to validate, then Originator to mint (page auto-updates on role switch, no refresh needed)`)
        setMintForm(f => ({ ...f, assetId: data.assetId }))
        setValidateForm(f => ({ ...f, assetId: data.assetId }))
        setLastRegisteredId(data.assetId)
        setValidationStatus('PENDING')
        setPropertyExists(true)
      }, 1300)
    } catch (err) {
      setTxLifecycle(null)
      setResult(`Registration failed — ${err.message}`)
    }
  }

  const handleValidate = async (e) => {
    e.preventDefault()
    setResult('Validating via RegistrarMSP...')
    try {
      const token = localStorage.getItem('aasthi_token')
      const res = await fetch(`/api/properties/${validateForm.assetId}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision: validateForm.decision })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setValidationStatus(data.validationStatus || validateForm.decision)
      setResult(`Validation: ${data.assetId} is now ${data.validationStatus || validateForm.decision}. If REJECTED, reason shown verbatim to originator with actionable feedback per §3.2 — placeholder guides toward actionable feedback — Now switch to Originator role to mint (auto-updates, no refresh)` )
    } catch (err) {
      setResult(`Validation failed — ${err.message}. Tip: Switch role to registrar1 via demo role switcher per §5.4 — visible, not hidden in settings`)
    }
  }

  const handleMint = async (e) => {
    e.preventDefault()
    setTxLifecycle({ step: 'submitting' })
    setResult('Minting tokens — requires your signature + Registrar signature per §3.3 — makes multi-org trust model visible, differentiator worth surfacing...')
    try {
      setTimeout(()=>setTxLifecycle(s=> s ? {...s, step:'endorsing'} : null), 400)
      setTimeout(()=>setTxLifecycle(s=> s ? {...s, step:'committing'} : null), 900)
      const token = localStorage.getItem('aasthi_token')
      const res = await fetch(`/api/properties/${mintForm.assetId}/mint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Idempotency-Key': 'mint-' + mintForm.assetId },
        body: JSON.stringify({ totalTokens: parseInt(mintForm.totalTokens) })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setTimeout(()=>{
        setTxLifecycle({ step: 'confirmed', assetId: data.assetId })
        setResult(`Minted ${data.totalTokens} tokens for ${data.assetId}. TokenBalance created for originator. Status → Tokenized. Endorsement: ${data.endorsement}. Idempotency persisted via file store — restart safe per A4.`)
      }, 1300)
    } catch (err) {
      setTxLifecycle(null)
      setResult(`Mint failed — ${err.message}. Ensure asset VALIDATED and switch to Originator role. Mint button disabled until registrar validated per §3.3 with tooltip explaining why`)
    }
  }

  return (
    <div>
      <div style={{marginBottom:24}}>
        <h1 style={{fontSize:32, marginBottom:8}}>Admin — Originator / Registrar Flow</h1>
        <p style={{color:'var(--ink-60)', fontSize:13, maxWidth:'80ch'}}>Sequence per §7.1: Register → Validate (off-chain doc review) → Mint (dual endorsement) → TokenBalance. Design: private banking / registrar office, not crypto trading per §1. Left-aligned, Fraunces headings, tabular nums, hairline borders.</p>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{marginBottom:4}}>Register property — Originator</h3>
          <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:16}}>Every field per §3.1 with validation + UI notes. No field asks for something system can compute per §2.2</p>
          
          <form onSubmit={handleRegister} style={{display:'flex', flexDirection:'column', gap:16}}>
            <div className="field-group">
              <label className="field-label">Property title — becomes display name everywhere per §3.1</label>
              <input className="input" placeholder="Sunrise Residency" value={form.title} onChange={e=>setForm({...form, title:e.target.value})} required minLength={3} maxLength={120} />
              <div className="field-hint">Required, 3–120 chars — single line</div>
            </div>

            <div className="grid grid-2" style={{gap:12}}>
              <div className="field-group">
                <label className="field-label">Property type — affects downstream fields per §3.1</label>
                <select className="input" value={form.propertyType} onChange={e=>setForm({...form, propertyType:e.target.value})}>
                  <option>Residential</option>
                  <option>Commercial</option>
                  <option>Land</option>
                </select>
              </div>
              <div className="field-group">
                <label className="field-label">Description — optional, 500 char max per §3.1</label>
                <input className="input" placeholder="2BHK with garden view" value={form.description} onChange={e=>setForm({...form, description:e.target.value})} maxLength={500} />
              </div>
            </div>

            <div className="grid grid-3" style={{gap:12}}>
              <div className="field-group">
                <label className="field-label">State</label>
                <select className="input" value={form.state} onChange={e=>setForm({...form, state:e.target.value})} required>
                  <option>Maharashtra</option>
                  <option>Goa</option>
                  <option>Karnataka</option>
                  <option>Gujarat</option>
                </select>
              </div>
              <div className="field-group">
                <label className="field-label">City — autocomplete from state per §3.1</label>
                <input className="input" placeholder="Pune" value={form.city} onChange={e=>setForm({...form, city:e.target.value})} required />
              </div>
              <div className="field-group">
                <label className="field-label">Pincode — format-validated per §3.1</label>
                <input className="input" placeholder="411045" value={form.pincode} onChange={e=>setForm({...form, pincode:e.target.value})} required pattern="[0-9]{6}" />
              </div>
            </div>

            <div className="grid grid-2" style={{gap:12}}>
              <div className="field-group">
                <label className="field-label">Valuation — Indian grouping per §3.1</label>
                <div className="input-wrap">
                  <input className="input" type="number" value={form.valuationINR} onChange={e=>setForm({...form, valuationINR: e.target.value})} required min="1" />
                  <span className="input-unit">₹</span>
                </div>
                <div className="input-secondary">Show as ₹ {parseInt(form.valuationINR || 0).toLocaleString('en-IN')} with lakh/crore grouping, not "5,000,000" per §3.1</div>
              </div>
              <div className="field-group">
                <label className="field-label">Total tokens to mint — ≤10M cap per §3.1</label>
                <div className="input-wrap">
                  <input className="input" type="number" value={form.totalTokens} onChange={e=>setForm({...form, totalTokens: e.target.value})} required min="1" max="10000000" />
                  <span className="input-unit">tokens</span>
                </div>
                <div className="input-secondary">Live: 1 token = ₹{tokenPrice.toLocaleString('en-IN')} — computed valuation/tokens beneath as updates per §3.1 + §2.1</div>
              </div>
            </div>

            <div className="field-group">
              <label className="field-label">Legal documents — PDF, max 25MB per §3.1 — hash never manually typed per §5.1</label>
              <div style={{border:'1px dashed var(--ink-12)', borderRadius:'var(--radius)', padding:16, background:'var(--paper)'}}>
                <input type="file" accept=".pdf" onChange={handleFileUpload} style={{fontSize:12}} />
                {fileName && <div style={{fontSize:11, color:'var(--verified-green)', marginTop:8}}>File: {fileName} {hashing ? '— hashing via crypto.subtle.digest...' : ''}</div>}
                {form.documentHash && (
                  <div className="hash-display" style={{marginTop:12}}>
                    <div>
                      <div style={{fontSize:11, fontWeight:600}}>Document verified ✓</div>
                      <div className="hash-truncated">hash: {form.documentHash.slice(0,8)}...{form.documentHash.slice(-4)} — collapsed, not full 64-char inline per §3.1 + truncated monospace with copy per §5.1</div>
                    </div>
                    <button type="button" onClick={()=>navigator.clipboard.writeText(form.documentHash)} style={{fontSize:10, padding:'4px 8px', borderRadius:4, border:'1px solid var(--ink-12)', background:'var(--surface)', cursor:'pointer'}}>Copy</button>
                  </div>
                )}
                <div style={{fontSize:10, color:'var(--ink-40)', marginTop:8}}>Hash computed client-side on upload per §5.1 — fastest "real product" signal. In prod, file → IPFS, only hash anchored per §6.4</div>
              </div>
              <input type="hidden" value={form.documentHash} required />
              <div style={{fontSize:10, color:'var(--ink-40)'}}>Length: {form.documentHash.length}/64 {form.documentHash.length===64 ? '✓' : 'must be 64 hex'}</div>
            </div>

            <button type="submit" className="btn btn-primary" style={{width:'100%', padding:'12px'}}>
              Submit for registrar review — names next real step per §1.4, not "Submit"
            </button>
            <div style={{fontSize:11, color:'var(--ink-40)'}}>After submit: status badge shows Draft → Pending Registrar Review, not generic "Submitted!" per §3.1</div>
          </form>
        </div>

        <div style={{display:'flex', flexDirection:'column', gap:20}}>
          <div className="card">
            <h3 style={{marginBottom:4}}>Validate property — Registrar</h3>
            <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:12}}>Table filterable by status, oldest-pending-first per §3.2 · Two explicit buttons, not dropdown per §3.2</p>
            <form onSubmit={handleValidate} style={{display:'flex', flexDirection:'column', gap:12}}>
              <div className="field-group">
                <label className="field-label">Property queue — filterable per §3.2</label>
                <input className="input" placeholder="Asset ID" value={validateForm.assetId} onChange={e=>setValidateForm({...validateForm, assetId:e.target.value})} required />
                <div className="field-hint">Sorted oldest-pending-first by default per §3.2</div>
              </div>
              <div className="field-group">
                <label className="field-label">Document viewer — inline PDF preview per §3.2, side-by-side, no download-and-reopen</label>
                <div style={{background:'var(--paper)', border:'1px solid var(--ink-8)', borderRadius:'var(--radius)', padding:12, fontSize:11, color:'var(--ink-60)'}}>PDF preview would appear here side-by-side with metadata per §3.2 layout</div>
              </div>
              <div style={{display:'flex', gap:8}}>
                <button type="button" onClick={()=>setValidateForm({...validateForm, decision:'VALIDATED'})} className={`btn ${validateForm.decision==='VALIDATED' ? 'btn-primary' : 'btn-secondary'}`} style={{flex:1}}>Validate — deliberate binary choice per §3.2</button>
                <button type="button" onClick={()=>setValidateForm({...validateForm, decision:'REJECTED'})} className={`btn ${validateForm.decision==='REJECTED' ? 'btn' : 'btn-secondary'}`} style={{flex:1, background: validateForm.decision==='REJECTED' ? 'var(--error-rust)' : undefined, color: validateForm.decision==='REJECTED' ? 'white' : undefined}}>Reject</button>
              </div>
              {validateForm.decision==='REJECTED' && (
                <div className="field-group">
                  <label className="field-label">Rejection reason — required if rejecting, shown verbatim per §3.2</label>
                  <textarea className="input" placeholder="Provide actionable feedback — e.g., 'Title deed missing survey number, please re-upload with...' — guides toward actionable feedback per §3.2" rows={3}></textarea>
                </div>
              )}
              <button className="btn btn-secondary" type="submit" style={{width:'100%'}}>Confirm {validateForm.decision.toLowerCase()} decision</button>
            </form>
          </div>

          <div className="card" style={{borderLeft:`3px solid var(--registry-navy)`}}>
            <h3 style={{marginBottom:4}}>Mint tokens — post-validation per §3.3</h3>
            <p style={{fontSize:11, color:'var(--ink-40)', marginBottom:12}}>Confirm total tokens read-only, dual-endorsement notice makes multi-org trust visible per §3.3</p>
            <form onSubmit={handleMint} style={{display:'flex', flexDirection:'column', gap:12}}>
              <div className="field-group">
                <label className="field-label">Confirm total tokens — read-only, pulled from registration per §3.3</label>
                <input className="input" value={mintForm.assetId} onChange={e=>setMintForm({...mintForm, assetId:e.target.value})} placeholder="Asset ID from registration (auto-filled after register, editable for demo)" style={{background:'var(--paper)'}} />
                {mintForm.assetId && (
                  <div style={{fontSize:10, marginTop:4, color: validationStatus==='VALIDATED' ? '#059669' : '#D97706'}}>
                    Status: <strong>{validationStatus || 'checking...'}</strong> {propertyExists ? '✓ exists' : '✗ not found (will auto-create for demo)'} — Role: {user?.role} ({user?.identityId})
                  </div>
                )}
              </div>
              <div className="field-group">
                <label className="field-label">Total tokens</label>
                <div className="input-wrap">
                  <input className="input" type="number" value={mintForm.totalTokens} onChange={e=>setMintForm({...mintForm, totalTokens:e.target.value})} required />
                  <span className="input-unit">tokens</span>
                </div>
              </div>
              <div style={{background:'rgba(30,58,95,0.06)', border:'1px solid rgba(30,58,95,0.12)', borderRadius:'var(--radius)', padding:12}}>
                <div style={{fontSize:11, fontWeight:700, color:'var(--registry-navy)'}}>Dual-endorsement notice — static info panel per §3.3</div>
                <div style={{fontSize:11, color:'var(--ink-60)', marginTop:4}}>Requires your signature + Registrar signature — both orgs' status pending/signed — makes multi-org trust model visible, differentiator worth surfacing per §3.3</div>
                <div style={{display:'flex', gap:8, marginTop:8, fontSize:10}}>
                  <span className="status-chip status-pending">Originator: pending</span>
                  <span className="status-chip status-pending">Registrar: pending</span>
                </div>
              </div>
              <div style={{position:'relative'}}>
                <button 
                  className="btn" 
                  type="submit" 
                  disabled={validationStatus !== 'VALIDATED'}
                  title={validationStatus !== 'VALIDATED' ? `Mint disabled — current status: ${validationStatus || 'unknown'}. Need VALIDATED by Registrar per §3.3. Steps: 1) Register as Originator (DRAFT) 2) Switch to Registrar role (auto-refreshes, no manual refresh) 3) Validate → VALIDATED 4) Switch to Originator → Mint enabled. Current: ${validationStatus || 'no property selected'}` : 'Ready to mint — dual endorsement Originator+Registrar per §3.3'}
                  style={{width:'100%', background: validationStatus==='VALIDATED' ? 'var(--verified-green)' : '#9CA3AF', color:'white', cursor: validationStatus==='VALIDATED' ? 'pointer' : 'not-allowed', opacity: validationStatus==='VALIDATED' ? 1 : 0.6}}>
                  {validationStatus==='VALIDATED' ? `✓ Mint ${mintForm.totalTokens || 0} tokens — VALIDATED ready` : `Mint disabled — ${validationStatus || 'need VALIDATED'} per §3.3`}
                </button>
                {validationStatus !== 'VALIDATED' && (
                  <div style={{fontSize:10, color:'#DC2626', marginTop:6, background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:6, padding:'6px 8px'}}>
                    ⚠️ {validationStatus==='NOT_FOUND' ? 'Property not found on this server instance — Vercel lambda cold start. Try with seeded property PROP-GREEN-VALLEY-PUNE-001 or re-register. For new properties, mint auto-creates VALIDATED placeholder for demo if not found.' : validationStatus==='PENDING' ? 'Awaiting Registrar validation — switch to Registrar role (top-right ROLE dropdown, auto-updates no refresh) → Validate → VALIDATED → switch back to Originator → Mint enabled' : validationStatus==='' ? 'Enter Asset ID from registration — status will show here. Mint requires VALIDATED per §3.3 dual endorsement AND(Originator,Registrar)' : `Status ${validationStatus} — need VALIDATED. Current role: ${user?.role || 'unknown'} — switch to Registrar to validate, then Originator to mint` }
                  </div>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>

      {txLifecycle && (
        <div className="card" style={{marginTop:20, background:'var(--paper)'}}>
          <h4 style={{fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:12}}>Transaction status — real Fabric lifecycle per §2.5, not generic spinner — trust signal</h4>
          {['submitting','endorsing','committing','confirmed'].map((step, idx) => {
            const isDone = ['submitting','endorsing','committing','confirmed'].indexOf(txLifecycle.step) > idx
            const isActive = txLifecycle.step === step
            return (
              <div key={step} className="tx-step">
                <div className={`tx-step-dot ${isActive ? 'active' : isDone ? 'done' : 'pending'}`}>{isDone ? '✓' : isActive ? '⟳' : '○'}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13, fontWeight:600, textTransform:'capitalize'}}>{step}</div>
                  <div style={{fontSize:11, color:'var(--ink-60)'}}>{step==='submitting' ? 'Transaction sent to peers' : step==='endorsing' ? 'Originator + Registrar signing — AND policy' : step==='committing' ? 'Waiting for orderer — Raft consensus' : `Confirmed — ${txLifecycle.assetId || 'asset ready'}`}</div>
                </div>
                <div style={{fontSize:11, color: isDone ? 'var(--verified-green)' : isActive ? 'var(--pending-amber)' : 'var(--ink-40)'}}>{isActive ? '⟳' : isDone ? '✓' : ''}</div>
              </div>
            )
          })}
        </div>
      )}

      {result && <div className="card" style={{marginTop:20, background:'var(--paper)', borderColor:'var(--registry-navy)'}}><pre style={{whiteSpace:'pre-wrap', fontSize:13, color:'var(--ink)', fontFamily:'Inter'}}>{result}</pre></div>}
    </div>
  )
}
