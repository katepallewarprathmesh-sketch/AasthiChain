import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { SignInButton } from '@clerk/react'
import { isClerkConfigured } from '../App.jsx'

/* ============================================================
   AasthiChain — premium landing (dark-first, light option)
   Brand preserved: registry navy → azure accent, Fraunces + Inter,
   registry-office trust language, honest simulation labeling.
   ============================================================ */

const THEME_KEY = 'aasthi_theme'

function useLandingTheme() {
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'dark' } catch { return 'dark' }
  })
  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, mode) } catch {}
    document.documentElement.setAttribute('data-landing-theme', mode)
    window.dispatchEvent(new CustomEvent('aasthi-theme', { detail: mode }))
    // keep the body backdrop in sync (overscroll edges match the hero)
    document.body.style.background = mode === 'dark' ? '#0A0D13' : '#F7F5F0'
    return () => { document.body.style.background = '' }
  }, [mode])
  // Listen for theme changes from OTHER toggles (e.g. the navbar) so the whole
  // page reacts instantly — no refresh needed. Same-value setMode bails, so the
  // echo of our own dispatch causes no re-render loop.
  useEffect(() => {
    const onTheme = (e) => { if (e?.detail) setMode(e.detail) }
    window.addEventListener('aasthi-theme', onTheme)
    return () => window.removeEventListener('aasthi-theme', onTheme)
  }, [])
  return [mode, () => setMode(m => (m === 'dark' ? 'light' : 'dark'))]
}

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('.rv')
    if (!('IntersectionObserver' in window)) { els.forEach(el => el.classList.add('in')); return }
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } })
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' })
    els.forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [])
}

/* ---------- tiny inline icon set (stroke = currentColor) ---------- */
const I = {
  arrow: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
  ),
  shield: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z"/><path d="M9.2 12.2l2 2 3.6-4"/></svg>
  ),
  zap: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg>
  ),
  rupee: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h12M6 8h12M15 3c0 5-3.5 6.5-9 6.5L15 21"/></svg>
  ),
  swap: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h13M13 4l4 4-4 4"/><path d="M20 16H7M11 20l-4-4 4-4"/></svg>
  ),
  badge: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15a6 6 0 100-12 6 6 0 000 12z"/><path d="M8.2 13.9L7 22l5-3 5 3-1.2-8.1"/></svg>
  ),
  eye: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>
  ),
  spark: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>
  ),
  sun: (s = 15) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
  ),
  moon: (s = 15) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/></svg>
  ),
}

/* ---------- ecosystem network SVG (hero visual) ---------- */
function NetworkViz() {
  const N = ({ x, y, label, sub, accent }) => (
    <g>
      <circle cx={x} cy={y} r="34" fill="var(--raised)" stroke="var(--line-2)" />
      <circle cx={x} cy={y} r="34" fill="none" stroke={accent || 'var(--accent)'} strokeOpacity="0.35" />
      <circle cx={x} cy={y} r="5" fill={accent || 'var(--accent)'} />
      <text x={x} y={y + 52} textAnchor="middle" fill="var(--text)" fontSize="11.5" fontWeight="600" fontFamily="Inter, sans-serif">{label}</text>
      <text x={x} y={y + 66} textAnchor="middle" fill="var(--faint)" fontSize="9.5" fontFamily="Inter, sans-serif">{sub}</text>
    </g>
  )
  return (
    <svg viewBox="0 0 560 480" style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="AasthiChain network — owners, registrar, investors and regulator settling on the Drunix ledger">
      <defs>
        <radialGradient id="core" cx="50%" cy="42%" r="65%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* edges ledger ↔ orgs */}
      <g stroke="var(--accent)" strokeOpacity="0.4" strokeWidth="1.4">
        <line className="flow" x1="280" y1="225" x2="105" y2="105" />
        <line className="flow" x1="280" y1="225" x2="455" y2="105" />
        <line className="flow-slow" x1="280" y1="225" x2="105" y2="345" />
        <line className="flow-slow" x1="280" y1="225" x2="455" y2="345" />
        <line className="flow" x1="280" y1="225" x2="280" y2="415" />
      </g>

      {/* core ledger */}
      <g>
        <circle cx="280" cy="225" r="120" fill="url(#core)" />
        <circle className="pulse-ring" cx="280" cy="225" r="74" fill="none" stroke="var(--accent)" strokeOpacity="0.5" />
        <circle cx="280" cy="225" r="58" fill="var(--raised)" stroke="var(--line-2)" />
        <circle cx="280" cy="225" r="74" fill="none" stroke="var(--accent)" strokeOpacity="0.35" strokeDasharray="1 6" />
        <text x="280" y="219" textAnchor="middle" fill="var(--text)" fontSize="13.5" fontWeight="700" fontFamily="Fraunces, Georgia, serif">Aasthi Ledger</text>
        <text x="280" y="236" textAnchor="middle" fill="var(--accent)" fontSize="10" fontWeight="600" fontFamily="Inter, sans-serif" letterSpacing="1.4">DRUNIX · FABRIC</text>
        <text x="280" y="251" textAnchor="middle" fill="var(--faint)" fontSize="9" fontFamily="Inter, sans-serif">4-org permissioned network</text>
      </g>

      <N x={105} y={105} label="Property Owner" sub="lists & tokenizes" />
      <N x={455} y={105} label="Registrar" sub="verifies title" accent="var(--ok)" />
      <N x={455} y={345} label="Regulator" sub="audits · can freeze" accent="var(--warn)" />
      <N x={105} y={345} label="Investors" sub="own from ₹500" />
      <N x={280} y={415} label="UPI · IMPS Rail" sub="collect → UTR proof" accent="var(--accent-2)" />
    </svg>
  )
}

/* ---------- settlement pipeline ---------- */
function Pipeline() {
  const steps = [
    { k: 'Collect', d: 'UPI request to you' },
    { k: 'Approve', d: 'in your UPI app' },
    { k: 'CONFIRMED', d: 'bank UTR issued' },
    { k: 'Transfer', d: 'tokens on Drunix' },
    { k: 'RELEASED', d: 'escrow settles' },
  ]
  return (
    <div className="acx-card-glass rv rv-d2" style={{ padding: '26px 26px 22px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <span className="acx-eyebrow">Atomic settlement — live pipeline</span>
        <span className="acx-chip" style={{ padding: '4px 10px', fontSize: 10.5 }}><span className="acx-dot" style={{ background: 'var(--ok)' }} /> money &amp; tokens move together</span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', marginTop: 20 }}>
        {steps.map((s, i) => (
          <React.Fragment key={s.k}>
            <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
              <div style={{
                width: 34, height: 34, margin: '0 auto', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: i >= 2 ? 'var(--accent-deep)' : 'var(--panel-2)', border: '1px solid var(--line-2)',
                color: i >= 2 ? 'var(--accent-2)' : 'var(--muted)', fontSize: 12, fontWeight: 700,
              }}>{i + 1}</div>
              <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 8, color: 'var(--text)' }}>{s.k}</div>
              <div style={{ fontSize: 10, color: 'var(--faint)', marginTop: 2 }}>{s.d}</div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ flex: '0 0 26px', display: 'flex', alignItems: 'center' }}>
                <div className="acx-pipe-line" style={{ width: '100%' }} />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px dashed var(--line)', fontSize: 11, color: 'var(--faint)', lineHeight: 1.6 }}>
        If the payment fails — no tokens move. If the transfer fails — the payment is refunded. No partial failures, ever.
      </div>
    </div>
  )
}

/* ============================================================ */
export default function Landing({ user }) {
  const [showDev, setShowDev] = useState(false)
  const [mode, toggleTheme] = useLandingTheme()
  useReveal()

  const handleDemoLogin = (roleData) => {
    try {
      const token = btoa(JSON.stringify({ identityId: roleData.id, role: roleData.role, mspId: roleData.mspId, exp: Date.now() + 3600000 }))
      const demoUser = { token, identityId: roleData.id, role: roleData.role, mspId: roleData.mspId, fabricMode: 'demo', isDemo: true }
      localStorage.setItem('aasthi_user', JSON.stringify(demoUser))
      localStorage.setItem('aasthi_token', token)
      localStorage.setItem('aasthi_clerk_demo_identity', roleData.id)
      window.location.href = '/marketplace'
    } catch (e) { console.error('demo login failed', e) }
  }

  const ctaPrimary = user ? (
    <Link to="/marketplace" className="acx-btn acx-btn-primary acx-btn-lg">Explore Properties {I.arrow(15)}</Link>
  ) : isClerkConfigured ? (
    <SignInButton mode="modal" fallbackRedirectUrl="/marketplace">
      <button className="acx-btn acx-btn-primary acx-btn-lg">Start Investing {I.arrow(15)}</button>
    </SignInButton>
  ) : (
    <Link to="/login" className="acx-btn acx-btn-primary acx-btn-lg">Start Investing {I.arrow(15)}</Link>
  )

  return (
    <div className="acx acx-anim" data-mode={mode} style={{ minHeight: 'calc(100vh - 64px)' }}>

      {/* ================= HERO ================= */}
      <header style={{ position: 'relative' }}>
        <div className="acx-hero-bg" />
        <div className="acx-wrap" style={{ position: 'relative', paddingTop: 96, paddingBottom: 40 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -46 }}>
            <button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
              style={{ color: 'var(--muted)' }} title="Toggle light / dark">
              {mode === 'dark' ? I.sun() : I.moon()}
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,0.95fr)', gap: 48, alignItems: 'center' }}>
            <div>
              <div className="rv in acx-chip" style={{ marginBottom: 22 }}>
                <span className="acx-dot" />
                Built on NPCI Drunix · UPI-settled · Testnet simulation
              </div>
              <h1 className="acx-h1 rv in" style={{ fontSize: 'clamp(40px, 5.2vw, 64px)', margin: 0 }}>
                Own a piece of<br />premium real estate.<br />
                <em>From ₹500.</em>
              </h1>
              <p className="rv in rv-d1" style={{ fontSize: 16.5, lineHeight: 1.65, color: 'var(--muted)', marginTop: 22, maxWidth: '56ch' }}>
                AasthiChain turns verified properties into fractional tokens. Pay by UPI, own instantly, trade anytime —
                registry-office trust, not crypto hype. No paperwork. No ₹75 lakh barrier.
              </p>
              <div className="rv in rv-d2" style={{ display: 'flex', gap: 12, marginTop: 30, flexWrap: 'wrap' }}>
                {ctaPrimary}
                <a href="#how-it-works" className="acx-btn acx-btn-ghost acx-btn-lg">How it works</a>
              </div>
              <div className="rv in rv-d3" style={{ display: 'flex', gap: 34, marginTop: 40, flexWrap: 'wrap' }}>
                {[['₹500', 'entry, not ₹75L'], ['T+0', 'UPI settlement'], ['4 orgs', 'permissioned network'], ['100%', 'atomic transfers']].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 24, fontWeight: 600, color: 'var(--text)' }}>{k}</div>
                    <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3, letterSpacing: '0.02em' }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ecosystem visual + live settlement card */}
            <div className="rv in rv-d2" style={{ position: 'relative' }}>
              <div className="acx-card-glass acx-anim" style={{ padding: '18px 10px 6px', position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 14px' }}>
                  <span className="acx-eyebrow" style={{ letterSpacing: '0.12em' }}>The AasthiChain network</span>
                  <span className="acx-chip" style={{ padding: '4px 10px', fontSize: 10 }}><span className="acx-dot pip" /> live testnet</span>
                </div>
                <NetworkViz />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ================= TRUST BAR ================= */}
      <section className="acx-band">
        <div className="acx-wrap" style={{ paddingTop: 22, paddingBottom: 22 }}>
          <div className="rv" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            {['NPCI Drunix ledger', 'UPI · IMPS rails', 'Atomic DvP settlement', 'Registrar-verified titles', 'Regulator oversight'].map((t, i) => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {i > 0 && <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--faint)', opacity: 0.5 }} />}
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.02em' }}>{t}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= WHY (preserved copy, premium cards) ================= */}
      <section className="acx-wrap" style={{ paddingTop: 76, paddingBottom: 76 }}>
        <div style={{ maxWidth: 640 }}>
          <div className="acx-eyebrow rv">Why AasthiChain</div>
          <h2 className="acx-h1 rv rv-d1" style={{ fontSize: 'clamp(26px, 3.2vw, 38px)', marginTop: 12 }}>
            Real estate, rebuilt for <em>everyone else</em>.
          </h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18, marginTop: 36 }}>
          {[
            {
              ico: I.eye(), t: 'The problem', d: 'Premium properties cost ₹75L+ — out of reach for most. Selling takes months, paperwork is messy, and you can\u2019t own just 0.1% of a villa. No transparency, no liquidity.',
            },
            {
              ico: I.swap(), t: 'The AasthiChain way', d: 'Each property becomes fixed tokens — like shares. A ₹75L villa becomes 15,000 tokens at ₹500. Buy 100 tokens for ₹50,000, hold fractional ownership, trade instantly.',
            },
            {
              ico: I.shield(), t: 'Why you can trust it', d: 'Every property is verified, every transfer is recorded, every payment is atomic — money and tokens move together or both refunded. Registry-office grade trust, not crypto hype.',
            },
          ].map((c, i) => (
            <div key={c.t} className={`acx-card rv rv-d${i + 1}`} style={{ padding: 26 }}>
              <div className="acx-ico">{c.ico}</div>
              <h3 style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 19, fontWeight: 600, marginTop: 18, color: 'var(--text)' }}>{c.t}</h3>
              <p style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--muted)', marginTop: 10 }}>{c.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ================= FEATURES ================= */}
      <section id="platform" className="acx-band">
        <div className="acx-wrap" style={{ paddingTop: 76, paddingBottom: 80 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
            <div style={{ maxWidth: 560 }}>
              <div className="acx-eyebrow rv">Platform</div>
              <h2 className="acx-h1 rv rv-d1" style={{ fontSize: 'clamp(26px, 3.2vw, 38px)', marginTop: 12 }}>
                Institutional rails, <em>retail-simple</em> experience.
              </h2>
            </div>
            <p className="rv rv-d2" style={{ fontSize: 13.5, color: 'var(--muted)', maxWidth: '40ch', lineHeight: 1.7 }}>
              Everything serious about the plumbing — hidden behind one familiar action: pay by UPI.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18, marginTop: 40 }}>
            {[
              { ico: I.rupee(), t: 'Fractional from ₹500', d: 'Own 0.1% of a villa, not a 30-year loan. Tokens are fixed-supply and priced from the verified valuation.' },
              { ico: I.zap(), t: 'UPI Collect payments', d: 'The seller requests, you approve in your UPI app — merchant-grade collect with RRN and IMPS UTR proof on every payment.' },
              { ico: I.swap(), t: 'Atomic DvP settlement', d: 'Delivery-versus-payment on the Drunix ledger: SettleDvP moves tokens and escrow together, with the UTR anchored on-chain.' },
              { ico: I.badge(), t: 'Registrar-verified titles', d: 'No listing goes live without document hash anchoring and a Registrar review — fraud is stopped before tokenization.' },
              { ico: I.shield(), t: 'Regulator guardrails', d: 'A full audit view with emergency freeze. Cap table, transfers and payment trails are inspectable end-to-end.' },
              { ico: I.spark(), t: 'AI fraud shield', d: 'An explainable risk engine screens every collect — velocity, structuring, high-value patterns — and re-screens at approval.' },
            ].map((f, i) => (
              <div key={f.t} className={`acx-card rv ${i % 3 === 1 ? 'rv-d1' : i % 3 === 2 ? 'rv-d2' : ''}`} style={{ padding: 26 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div className="acx-ico">{f.ico}</div>
                  <span style={{ fontSize: 10, color: 'var(--faint)', fontFamily: 'Inter, sans-serif', letterSpacing: '0.08em' }}>0{i + 1}</span>
                </div>
                <h3 style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, fontWeight: 600, marginTop: 18, color: 'var(--text)' }}>{f.t}</h3>
                <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--muted)', marginTop: 9 }}>{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= HOW IT WORKS ================= */}
      <section id="how-it-works" className="acx-wrap" style={{ paddingTop: 80, paddingBottom: 40 }}>
        <div style={{ maxWidth: 640 }}>
          <div className="acx-eyebrow rv">How it works</div>
          <h2 className="acx-h1 rv rv-d1" style={{ fontSize: 'clamp(26px, 3.2vw, 38px)', marginTop: 12 }}>
            Four roles. One secure flow.
          </h2>
          <p className="rv rv-d2" style={{ fontSize: 14, color: 'var(--muted)', marginTop: 12, lineHeight: 1.7 }}>
            From listing to ownership — every step permissioned, every step recorded.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginTop: 40 }}>
          {[
            { role: 'Property Owner', n: '01', desc: 'Lists property with documents — hash anchored, verified before tokenization', steps: ['List property', 'Upload documents', 'Get verified', 'Tokens created'] },
            { role: 'Registrar', n: '02', desc: 'Checks legal title and approves — prevents fraud before it starts', steps: ['Review documents', 'Verify title', 'Approve', 'Monitor'] },
            { role: 'You — Investor', n: '03', desc: 'Browse, pay via UPI, own instantly — trade anytime', steps: ['Browse properties', 'Pay via UPI', 'Own tokens', 'Trade or hold'] },
            { role: 'Regulator', n: '04', desc: 'Audits everything — can pause markets if needed for safety', steps: ['Audit properties', 'Check ownership', 'Review transfers', 'Ensure safety'] },
          ].map((item, i) => (
            <div key={item.role} className={`acx-card rv rv-d${(i % 4) + 1}`} style={{ padding: 22, position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 14, right: 18, fontFamily: 'Fraunces, Georgia, serif', fontSize: 30, fontWeight: 600, color: 'var(--line-2)' }}>{item.n}</div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.02em' }}>{item.role}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginTop: 8, minHeight: 38 }}>{item.desc}</div>
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {item.steps.map((s, j) => (
                  <div key={j} style={{ fontSize: 11.5, display: 'flex', gap: 9, alignItems: 'center' }}>
                    <span style={{ width: 18, height: 18, borderRadius: 6, background: 'var(--accent-deep)', color: 'var(--accent-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700, flexShrink: 0 }}>{j + 1}</span>
                    <span style={{ color: 'var(--muted)' }}>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ================= PAYMENTS / PIPELINE (preserved anchor #payments) ================= */}
      <section id="payments" className="acx-wrap" style={{ paddingTop: 40, paddingBottom: 80 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.15fr)', gap: 40, alignItems: 'center' }}>
          <div>
            <div className="acx-eyebrow rv">Payments</div>
            <h2 className="acx-h1 rv rv-d1" style={{ fontSize: 'clamp(24px, 3vw, 34px)', marginTop: 12 }}>
              Secure payments,<br /><em>instant</em> ownership.
            </h2>
            <p className="rv rv-d2" style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.75, marginTop: 16, maxWidth: '52ch' }}>
              Pay via UPI — just like you pay for anything. Your payment is verified with a bank UTR, then tokens transfer
              instantly on the Drunix ledger. Both happen together or both are reversed.
            </p>
            <div className="rv rv-d3" style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
              {['UPI Collect', 'UTR reconciliation', 'Escrow release', 'Idempotent by design'].map(t => (
                <span key={t} className="acx-chip" style={{ fontSize: 11 }}>{t}</span>
              ))}
            </div>
          </div>
          <Pipeline />
        </div>
      </section>

      {/* ================= TRUST / SECURITY / TRANSPARENCY ================= */}
      <section id="trust" className="acx-band">
        <div className="acx-wrap" style={{ paddingTop: 80, paddingBottom: 84 }}>
          <div style={{ maxWidth: 640 }}>
            <div className="acx-eyebrow rv">Trust &amp; transparency</div>
            <h2 className="acx-h1 rv rv-d1" style={{ fontSize: 'clamp(26px, 3.2vw, 38px)', marginTop: 12 }}>
              Boring where it matters.<br /><em>That's the point.</em>
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18, marginTop: 40 }}>
            {[
              { t: 'Permissioned identity', d: 'Every actor signs with JWT + MSP identity across four organizations. No anonymous actors can touch the ledger.' },
              { t: 'Double-spend protection', d: 'MVCC versioning on the Fabric state DB plus composite-key balances — the same token cannot be sold twice.' },
              { t: 'Idempotent everything', d: 'Payments, webhooks and settlements are idempotent — retries and refreshes can never double-credit an investor.' },
              { t: 'Auditable cap table', d: 'Who owns what is a ledger query, not a spreadsheet. Regulators see the same truth investors see.' },
              { t: 'Honest by labeling', d: 'The UPI rail is a clearly-labeled testnet simulation — no live NPCI credentials exist for hackathons. Production swap is one config line.' },
              { t: 'Aligned with regulation', d: 'Designed around the Asset Tokenisation (Regulation) Bill 2026: KYC/AML gates, registrar validation, custodian pathway, regulator freeze.' },
            ].map((c, i) => (
              <div key={c.t} className={`acx-card rv ${i % 3 === 1 ? 'rv-d1' : i % 3 === 2 ? 'rv-d2' : ''}`} style={{ padding: 24 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }}>{I.shield(18)}</div>
                  <div>
                    <h3 style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>{c.t}</h3>
                    <p style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--muted)', marginTop: 7 }}>{c.d}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= DEMO ACCESS (preserved behavior) ================= */}
      <section id="demo" className="acx-wrap" style={{ paddingTop: 80, paddingBottom: 30 }}>
        <div className="acx-card-glass rv" style={{ padding: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h3 style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 20, fontWeight: 600, color: 'var(--text)', margin: 0 }}>Try every role — instantly</h3>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
                One-click demo identities with instant mock sign-in. Works on the live deployment and locally — no verification, under 2 seconds.
              </p>
            </div>
            <span className="acx-chip" style={{ fontSize: 10.5 }}><span className="acx-dot" style={{ background: 'var(--ok)' }} /> LIVE + LOCAL</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 22 }}>
            {[
              { id: 'originator1', role: 'Originator', label: 'Owner', desc: 'List & tokenize property', color: 'var(--accent)' },
              { id: 'registrar1', role: 'Registrar', label: 'Registrar', desc: 'Validate title & approve', color: 'var(--ok)' },
              { id: 'investor1', role: 'Investor', label: 'Investor', desc: 'Buy via UPI & own', color: 'var(--accent-2)' },
              { id: 'regulator1', role: 'Regulator', label: 'Regulator', desc: 'Audit & freeze', color: 'var(--warn)' },
            ].map(r => (
              <button
                key={r.id}
                onClick={() => handleDemoLogin(r)}
                className="acx-card"
                style={{ textAlign: 'left', padding: 18, cursor: 'pointer', background: 'var(--panel)', color: 'var(--text)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ width: 30, height: 30, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, background: r.color, color: 'var(--accent-ink)' }}>{r.label[0]}</div>
                  <span style={{ fontSize: 10, color: 'var(--faint)', fontFamily: 'Inter, monospace' }}>{r.id}</span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 12 }}>{r.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>{r.desc}</div>
                <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 5 }}>Enter as {r.label} {I.arrow(12)}</div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ================= FINAL CTA ================= */}
      <section className="acx-wrap" style={{ paddingTop: 50, paddingBottom: 80 }}>
        <div className="acx-card-glass rv" style={{
          padding: 'clamp(36px, 6vw, 64px)', textAlign: 'center', position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(600px 220px at 50% -40px, var(--glow), transparent)' }} />
          <h2 className="acx-h1" style={{ fontSize: 'clamp(26px, 3.4vw, 40px)', margin: 0, position: 'relative' }}>
            Ready to own premium real estate?
          </h2>
          <p style={{ fontSize: 14.5, color: 'var(--muted)', maxWidth: '52ch', margin: '14px auto 0', lineHeight: 1.7, position: 'relative' }}>
            Start from ₹500. Verified properties, secure UPI payments, instant blockchain ownership. No paperwork, no waiting.
          </p>
          <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap', position: 'relative' }}>
            {ctaPrimary}
            <a href="#demo" className="acx-btn acx-btn-ghost acx-btn-lg">Use a demo role</a>
          </div>
          <div style={{ marginTop: 18, fontSize: 11.5, color: 'var(--faint)', position: 'relative' }}>
            Sign in with Clerk top-right, or use a demo preset — both work on the live site and locally.
          </div>
        </div>
      </section>

      {/* ================= JUDGE / DEV DETAILS (preserved content) ================= */}
      <section className="acx-band">
        <div className="acx-wrap" style={{ paddingTop: 26, paddingBottom: 60 }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={() => setShowDev(!showDev)}
              className="acx-chip"
              style={{ cursor: 'pointer', padding: '9px 18px', background: 'transparent' }}
            >
              {showDev ? 'Hide' : 'Show'} Technical Details — For Judges &amp; Developers
            </button>
          </div>

          {showDev && (
            <div className="rv in" style={{ marginTop: 24 }}>
              <div className="acx-card" style={{ padding: 22, marginBottom: 16, borderColor: 'var(--accent-deep)' }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--accent-2)' }}>NPCI Drunix — Core Platform (Golang)</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, lineHeight: 1.75 }}>
                  Built ON Drunix (NPCI's open-source Fabric fork for tokenization), not just integrated:
                  Go chaincode (property.go / token.go / kyc.go — RecordSettlement + SettleDvP atomic DvP with UTR proof),
                  Go Drunix gateway (<code style={{ color: 'var(--accent-2)' }}>drunix-gateway/</code>: PROPOSED → ENDORSED → COMMITTED lifecycle, deterministic txIDs, read/write sets, SettlementRecorded events — <code style={{ color: 'var(--accent-2)' }}>go test ./...</code> green),
                  Go AI fraud engine (<code style={{ color: 'var(--accent-2)' }}>fraud.go</code> — explainable weights, ML-pluggable).
                  Demo flow: <code style={{ color: 'var(--accent-2)' }}>/api/drunix/ledger</code> shows the full Drunix transaction flow per payment.
                  Themes: Real-Time Payments + Financial Inclusion (₹500 entry) + AI &amp; Fraud Detection + Open Finance APIs (<code style={{ color: 'var(--accent-2)' }}>/api/openfinance/capabilities</code>).
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
                <span className="acx-chip" style={{ borderColor: 'var(--warn)', color: 'var(--warn)', fontSize: 10 }}>SIMULATION</span>
                <span style={{ fontSize: 11, color: 'var(--faint)' }}>NPCI UPI rail is a testnet simulation — no live NPCI sandbox credentials available for hackathons. Honest labeling per Track A6.</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                <div className="acx-card" style={{ padding: 22 }}>
                  <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Primary Rail — UPI Collect P2M + IMPS UTR (INR)</h4>
                  <ul style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, paddingLeft: 18, lineHeight: 1.8 }}>
                    <li>VPA: investor@aasthichain, originator@aasthichain — regex validated</li>
                    <li>IDs: PaymentID NPCI-XXXXXXXXXXXX, RRN 12-digit 418…, UTR IMPS+RRN</li>
                    <li>Flow: PENDING (5 min) → CONFIRMED (KYC+balance) → RELEASED / REFUNDED — atomic DvP</li>
                    <li>INR in paise (int64), X-Idempotency-Key, webhook callbacks + UTR reconciliation</li>
                    <li>Optional PayU test-mode bridge — real PSP hash contract, simulated settlement</li>
                    <li>8 payment tests: success→transfer, timeout→refund, idempotency, KYC, funds, VPA, zero, formats</li>
                  </ul>
                </div>
                <div className="acx-card" style={{ padding: 22 }}>
                  <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Secondary — Sepolia + Drunix + Regulatory</h4>
                  <ul style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, paddingLeft: 18, lineHeight: 1.8 }}>
                    <li>Sepolia PaymentEscrow.sol — experimental cross-chain pattern behind Advanced toggle</li>
                    <li>Drunix: 4 orgs, Raft 3 orderers, Postgres state with 4 SQL indexes, MVCC double-spend protection</li>
                    <li>Chaincode: 9 funcs, JWT+MSP auth, rate limit 100/min, persistent idempotency, 216+ tests</li>
                    <li>Regulatory: Asset Tokenisation (Regulation) Bill 2026 — registrar validation, regulator freeze, auditable cap table, KYC payment gate</li>
                  </ul>
                </div>
              </div>

              <div className="acx-card" style={{ marginTop: 16, padding: 20 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>LIVE vs MOCKED — Honest Scoping (Track A6 Extended)</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginTop: 10, fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
                  <div><strong style={{ color: 'var(--ok)' }}>LIVE:</strong> Chaincode 9 funcs, JWT+MSP, Raft 3, SQL 4 indexes, payment-gateway module, Drunix TransferTokens, atomic DvP, 216+ tests + 8 payment tests</div>
                  <div><strong style={{ color: 'var(--warn)' }}>MOCKED (pluggable):</strong> KYC DigiLocker stub, DILRMP hash anchored, NPCI UPI testnet simulation (no live credentials), Sepolia secondary experimental</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
