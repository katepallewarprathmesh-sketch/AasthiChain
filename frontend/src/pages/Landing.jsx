import React from 'react'
import { Link } from 'react-router-dom'
import { SignInButton } from '@clerk/react'
import { isClerkConfigured } from '../App.jsx'

export default function Landing({ user }) {
  return (
    <div style={{minHeight:'calc(100vh - 64px - 80px)'}}>
      {/* Hero */}
      <div style={{maxWidth:1120, margin:'0 auto', padding:'48px 24px 32px'}}>
        <div style={{display:'grid', gridTemplateColumns:'1.2fr 0.8fr', gap:32, alignItems:'center'}}>
          <div>
            <div style={{display:'inline-flex', alignItems:'center', gap:8, background:'#F1F5F9', border:'1px solid #E2E8F0', padding:'6px 12px', borderRadius:20, fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#1E3A5F', marginBottom:16}}>
              <span style={{width:6, height:6, background:'#059669', borderRadius:'50%'}}></span>
              Drunix Hackathon x Citi — Real Asset Tokenization + Future of Payments
            </div>
            <h1 style={{fontFamily:'Fraunces', fontSize:44, fontWeight:800, lineHeight:0.95, letterSpacing:'-0.03em', color:'#0F172A'}}>
              Tokenized real-asset ownership on Drunix + <br/>
              <span style={{color:'#1E3A5F'}}>payment settlement on NPCI rails.</span>
            </h1>
            <p style={{fontSize:15, color:'#475569', lineHeight:1.6, marginTop:16, maxWidth:'62ch'}}>
              AasthiChain converts real estate into fixed-supply tradable tokens on a permissioned 4-org Drunix network, with atomic DvP settlement modeled on NPCI's <strong>UPI Collect (P2M) + IMPS UTR</strong> pattern — INR leg, not testnet ETH. Built for registry-office grade trust.
            </p>

            <div style={{display:'flex', gap:12, marginTop:20, flexWrap:'wrap'}}>
              {user ? (
                <Link to="/marketplace" className="btn btn-primary" style={{padding:'12px 20px', fontSize:14, textDecoration:'none'}}>Go to Marketplace →</Link>
              ) : (
                <>
                  {isClerkConfigured ? (
                    <SignInButton mode="modal" fallbackRedirectUrl="/marketplace">
                      <button className="btn btn-primary" style={{padding:'12px 20px', fontSize:14}}>Sign in to explore →</button>
                    </SignInButton>
                  ) : (
                    <Link to="/login" className="btn btn-primary" style={{padding:'12px 20px', fontSize:14, textDecoration:'none'}}>Sign in to explore →</Link>
                  )}
                  <a href="#payments" className="btn btn-secondary" style={{padding:'12px 20px', fontSize:14, textDecoration:'none'}}>How payments work</a>
                </>
              )}
            </div>

            <div style={{display:'flex', gap:16, marginTop:20, flexWrap:'wrap'}}>
              {[
                { k: '4 Orgs', v: 'Originator, Registrar, Investor, Regulator' },
                { k: 'UPI Collect', v: 'P2M collect + IMPS UTR (INR)' },
                { k: 'Atomic DvP', v: 'Payment CONFIRMED → TransferTokens → RELEASED' },
              ].map(item => (
                <div key={item.k} style={{display:'flex', flexDirection:'column', gap:2}}>
                  <span style={{fontSize:12, fontWeight:700, color:'#0F172A'}}>{item.k}</span>
                  <span style={{fontSize:11, color:'#64748B'}}>{item.v}</span>
                </div>
              ))}
            </div>

            <div style={{marginTop:14, background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:8, padding:'8px 10px', display:'inline-flex', gap:8, alignItems:'center'}}>
              <span style={{fontSize:9, background:'#F59E0B', color:'white', padding:'2px 6px', borderRadius:4, fontWeight:700}}>SIMULATION</span>
              <span style={{fontSize:10, color:'#92400E'}}>NPCI rail is simulation — no live NPCI sandbox credentials available for hackathon. Honest labeling per Track A6.</span>
            </div>
          </div>

          <div className="card" style={{padding:16, borderColor:'#1E3A5F', borderWidth:2}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10}}>
              <h3 style={{fontSize:12, fontWeight:700, display:'flex', gap:6, alignItems:'center'}}><span style={{background:'#1E3A5F', color:'white', fontSize:9, padding:'2px 5px', borderRadius:4}}>PRIMARY</span> UPI Collect — INR</h3>
              <span style={{fontSize:9, background:'#FEF3C7', border:'1px solid #FDE68A', padding:'2px 6px', borderRadius:4, color:'#92400E'}}>SIMULATION</span>
            </div>
            <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:10, padding:12}}>
              <div style={{display:'flex', justifyContent:'space-between', fontSize:11}}>
                <span style={{color:'#64748B'}}>Payer VPA</span><span style={{fontFamily:'monospace', fontWeight:600}}>investor@aasthichain</span>
              </div>
              <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginTop:4}}>
                <span style={{color:'#64748B'}}>Payee VPA</span><span style={{fontFamily:'monospace', fontWeight:600}}>originator@aasthichain</span>
              </div>
              <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginTop:4}}>
                <span style={{color:'#64748B'}}>Amount</span><span style={{fontWeight:700}}>₹2,50,000 = 500 tokens × ₹500</span>
              </div>
              <div style={{marginTop:10, display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, fontSize:10}}>
                <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:6, padding:8}}><div style={{color:'#94A3B8', fontWeight:700, textTransform:'uppercase'}}>UPI Txn ID</div><div style={{fontFamily:'monospace', marginTop:2}}>AAST20260921X7K9P2Q1</div></div>
                <div style={{background:'white', border:'1px solid #E2E8F0', borderRadius:6, padding:8}}><div style={{color:'#94A3B8', fontWeight:700, textTransform:'uppercase'}}>RRN / UTR</div><div style={{fontFamily:'monospace', marginTop:2}}>418209123456 / IMPS...</div></div>
              </div>
              <div style={{marginTop:10}}>
                <div style={{display:'flex', justifyContent:'space-between', fontSize:10, color:'#64748B', marginBottom:4}}><span>Collect Initiated</span><span>→ Approved</span><span>→ Drunix</span><span>→ Released</span></div>
                <div style={{height:6, background:'#E2E8F0', borderRadius:10, display:'flex', gap:3}}><div style={{flex:1, background:'#1E3A5F', borderRadius:10}}></div><div style={{flex:1, background:'#1E3A5F', borderRadius:10}}></div><div style={{flex:1, background:'#1E3A5F', borderRadius:10}}></div><div style={{flex:1, background:'#059669', borderRadius:10}}></div></div>
              </div>
            </div>
            <div style={{marginTop:10, display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:11}}>
              <div style={{background:'#F1F5F9', borderRadius:8, padding:10}}><div style={{fontWeight:700}}>Atomic DvP</div><div style={{color:'#64748B', marginTop:2}}>Money + tokens move together or both refunded</div></div>
              <div style={{background:'#F0FDF4', borderRadius:8, padding:10}}><div style={{fontWeight:700, color:'#059669'}}>INR, not ETH</div><div style={{color:'#64748B', marginTop:2}}>₹500/token, paise int64, no float</div></div>
            </div>
          </div>
        </div>
      </div>

      {/* What we solve */}
      <div id="how-it-works" style={{background:'white', borderTop:'1px solid #E2E8F0', borderBottom:'1px solid #E2E8F0'}}>
        <div style={{maxWidth:1120, margin:'0 auto', padding:'32px 24px'}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:20}}>
            <div>
              <h2 style={{fontFamily:'Fraunces', fontSize:18, fontWeight:700}}>The problem — illiquid assets + disconnected payments</h2>
              <p style={{fontSize:12, color:'#475569', lineHeight:1.6, marginTop:8}}>
                Real estate is illiquid, high-ticket (₹75L+ entry), paperwork-heavy. Existing tokenization demos ignore payments — they show tokens moving but not how INR moves. Citi problem statement asks for "Build the Future of Payments in India" — needs NPCI-style rail, not just asset tokenization.
              </p>
              <ul style={{fontSize:11, color:'#475569', marginTop:10, paddingLeft:16, lineHeight:1.7}}>
                <li>₹75L+ entry barrier, no fractional ownership in India today</li>
                <li>Registration Act, 1908 needs SPV wrapper — tokens = beneficial interest in SPV</li>
                <li>Payments half missing in most demos — we fix that with UPI Collect + IMPS UTR</li>
              </ul>
            </div>
            <div>
              <h2 style={{fontFamily:'Fraunces', fontSize:18, fontWeight:700}}>What we built — Drunix + NPCI UPI Collect</h2>
              <p style={{fontSize:12, color:'#475569', lineHeight:1.6, marginTop:8}}>
                Tokenize property into integer-only tokens (no decimals). Originator lists, Registrar validates, dual endorsement `AND('OriginatorMSP.peer','RegistrarMSP.peer')` prevents unilateral mint. Payment leg: <strong>UPI Collect P2M</strong> — payee (originator@aasthichain) requests money from payer (investor@aasthichain) via NPCI switch → payer approves in UPI app → IMPS settlement with UTR → Drunix `TransferTokens` → atomic DvP.
              </p>
              <ul style={{fontSize:11, color:'#475569', marginTop:10, paddingLeft:16, lineHeight:1.7}}>
                <li>9 chaincode functions, full edge-case coverage, 216+ tests</li>
                <li>JWT + MSP auth, rate limit 100/min, persistent idempotency, bookmark pagination</li>
                <li>Payment-gateway module: VPA, UPI Txn ID, RRN, UTR, expiry 5min, KYC gate, balance check</li>
              </ul>
            </div>
            <div>
              <h2 style={{fontFamily:'Fraunces', fontSize:18, fontWeight:700}}>Why UPI Collect + Why Drunix</h2>
              <p style={{fontSize:12, color:'#475569', lineHeight:1.6, marginTop:8}}>
                <strong>UPI Collect P2M</strong> matches real estate: seller requests, buyer approves — like merchant collect. Settlement via IMPS gives UTR for reconciliation (NPCI pattern). <strong>Drunix</strong>: Permissioned 4 orgs, Raft 3 orderers (1 fault tolerant, chaos_test.sh), Postgres SQL state with 4 indexes O(log n), MVCC double-spend protection.
              </p>
              <ul style={{fontSize:11, color:'#475569', marginTop:10, paddingLeft:16, lineHeight:1.7}}>
                <li>idx_property_status, idx_balance_owner/asset, idx_transfer_asset_time</li>
                <li>UPI Collect → IMPS: real-world UTR = 12-digit RRN + IMPS prefix, expiry 5 min</li>
                <li>Block timestamp from orderer, not peer clock — prevents time manipulation</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div style={{maxWidth:1120, margin:'0 auto', padding:'32px 24px'}}>
        <h2 style={{fontFamily:'Fraunces', fontSize:20, fontWeight:700}}>How it works — 4 roles + payments</h2>
        <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginTop:16}}>
          {[
            { role:'Originator', desc:'Lists property, uploads docs, SHA-256 auto-computed, initiates UPI Collect as payee', color:'#1E3A5F', steps:['Register property','Upload doc → hash','Wait validation','Mint + Request ₹ via UPI Collect'] },
            { role:'Registrar', desc:'Validates legal title, co-signs mint — prevents unilateral mint, KYC gate per Bill 2026', color:'#D97706', steps:['Review doc hash','Validate title (KYC/AML)','Co-sign mint','Audit + Freeze if needed'] },
            { role:'Investor', desc:'Buys via UPI: receives collect request at investor@aasthichain, approves in UPI app', color:'#059669', steps:['Browse marketplace','Receive UPI Collect','Approve in UPI app','Tokens + UTR received'] },
            { role:'Regulator', desc:'Read-only audit, emergency freeze, transfer history, UTR reconciliation', color:'#111827', steps:['View all properties','Audit cap table + UTRs','Check transfers + RRNs','Freeze if fraud'] },
          ].map(item => (
            <div key={item.role} className="card" style={{padding:14}}>
              <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
                <div style={{width:8, height:8, borderRadius:'50%', background:item.color}}></div>
                <div style={{fontSize:12, fontWeight:700}}>{item.role}</div>
              </div>
              <div style={{fontSize:10, color:'#64748B', lineHeight:1.5, minHeight:36}}>{item.desc}</div>
              <div style={{marginTop:10, display:'flex', flexDirection:'column', gap:4}}>
                {item.steps.map((s,i) => (
                  <div key={i} style={{fontSize:10, display:'flex', gap:6, alignItems:'center'}}>
                    <span style={{width:16, height:16, borderRadius:'50%', background:'#F1F5F9', border:'1px solid #E2E8F0', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700}}>{i+1}</span>
                    <span style={{color:'#475569'}}>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Payments */}
      <div id="payments" style={{background:'#0F172A', color:'white'}}>
        <div style={{maxWidth:1120, margin:'0 auto', padding:'28px 24px', display:'grid', gridTemplateColumns:'1.2fr 0.8fr', gap:24}}>
          <div>
            <h3 style={{fontFamily:'Fraunces', fontSize:18, fontWeight:700, display:'flex', alignItems:'center', gap:8}}><span style={{background:'#1E3A5F', color:'white', fontSize:10, padding:'3px 8px', borderRadius:4}}>PRIMARY</span> Atomic DvP — UPI Collect + Drunix</h3>
            <p style={{fontSize:11, color:'#94A3B8', lineHeight:1.6, marginTop:6, maxWidth:'65ch'}}>
              <strong>UPI Collect (P2M)</strong>: Payee (originator@aasthichain) → NPCI switch → payer PSP → payer approves in UPI app. On <code>CONFIRMED</code>, backend calls <code>TransferTokens</code> chaincode — token ownership moves on Drunix. Then <code>RELEASED</code> — IMPS settlement with UTR credited to payee. If Drunix fails, <code>REFUNDED</code> — atomic. INR, not testnet ETH. VPA validated via regex, RRN 12-digit, UTR IMPS+RRN, expiry 5 min.
            </p>
            <div style={{display:'flex', gap:8, marginTop:12, flexWrap:'wrap'}}>
              <span style={{fontSize:10, background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:20}}>UPI Collect P2M</span>
              <span style={{fontSize:10, background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:20}}>IMPS UTR: IMPS418...</span>
              <span style={{fontSize:10, background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:20}}>VPA: investor@aasthichain</span>
              <span style={{fontSize:10, background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:20}}>Idempotency: X-Idempotency-Key</span>
              <span style={{fontSize:10, background:'#FEF3C7', color:'#92400E', padding:'4px 8px', borderRadius:20}}>SIMULATION — No live NPCI</span>
            </div>
            <div style={{marginTop:12, background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:10, padding:10}}>
              <div style={{fontSize:10, fontWeight:700, color:'#94A3B8', textTransform:'uppercase'}}>Regulatory awareness — Asset Tokenisation (Regulation) Bill, 2026</div>
              <p style={{fontSize:10, color:'#94A3B8', lineHeight:1.5, marginTop:4}}>
                Pending Private Member's Bill, not yet law — proposes KYC/AML for token holders, registered custodian for property SPV, registrar validation, and regulator freeze powers. AasthiChain addresses: RegistrarMSP validates title + KYC (DigiLocker mock), RegulatorMSP can freeze asset (FreezeAsset), cap table auditable via idx_balance_asset, transfer history via idx_transfer_asset_time. Payment rail adds KYC gate at approval — unverified payer → FAILED_KYC_NOT_VERIFIED → REFUNDED.
              </p>
            </div>
          </div>
          <div>
            <div style={{background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:12, padding:14}}>
              <div style={{fontSize:10, fontWeight:700, color:'#94A3B8', textTransform:'uppercase', marginBottom:8}}>DvP Flow — INR Primary</div>
              <div style={{display:'flex', flexDirection:'column', gap:8, fontSize:11}}>
                {[
                  { n:'1. Collect Initiated', d:'originator@aasthichain requests ₹2.5L via NPCI switch — UPI Txn ID AAST... + RRN 418... + UTR IMPS... — PENDING', c:'#38BDF8' },
                  { n:'2. Payer Approves', d:'investor@aasthichain approves in UPI app — KYC + balance check — CONFIRMED + webhook callback', c:'#38BDF8' },
                  { n:'3. Drunix Transfer', d:'Backend TransferTokens — 500 tokens move originator→investor — TXN-... — always real', c:'#38BDF8' },
                  { n:'4. Settlement Released', d:'IMPS UTR credited to payee — RELEASED — atomic DvP complete. If Drunix fails → REFUNDED', c:'#22C55E' },
                ].map(item => (
                  <div key={item.n} style={{display:'flex', gap:8}}>
                    <div style={{width:6, height:6, borderRadius:'50%', background:item.c, marginTop:6, flexShrink:0}}></div>
                    <div><div style={{fontWeight:600}}>{item.n}</div><div style={{fontSize:10, color:'#94A3B8', marginTop:2, lineHeight:1.4}}>{item.d}</div></div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{marginTop:12, background:'rgba(255,255,255,0.04)', border:'1px dashed rgba(255,255,255,0.15)', borderRadius:10, padding:10}}>
              <div style={{fontSize:9, fontWeight:700, color:'#64748B', textTransform:'uppercase'}}>Secondary / Experimental</div>
              <div style={{fontSize:10, color:'#94A3B8', marginTop:4, lineHeight:1.4}}>Sepolia PaymentEscrow.sol — cross-chain settlement pattern demo (bonus / future extensibility — could bridge to tokenized deposits or stablecoin rails later). Not primary DvP. Kept behind Advanced toggle.</div>
              <div style={{display:'flex', gap:6, marginTop:8}}><span style={{fontSize:9, background:'rgba(255,255,255,0.08)', padding:'3px 6px', borderRadius:4}}>PaymentEscrow.sol</span><span style={{fontSize:9, background:'rgba(255,255,255,0.08)', padding:'3px 6px', borderRadius:4}}>Chain 0xaa36a7</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div style={{maxWidth:1120, margin:'0 auto', padding:'28px 24px', textAlign:'center'}}>
        <h2 style={{fontFamily:'Fraunces', fontSize:22, fontWeight:700}}>Ready to explore UPI + Drunix DvP?</h2>
        <p style={{fontSize:12, color:'#64748B', marginTop:6, maxWidth:'60ch', margin:'6px auto 0'}}>Primary payment demo: UPI Collect (INR) with VPA investor@aasthichain, RRN, UTR, atomic DvP. Secondary: Sepolia experimental behind toggle. Sign in from top-right corner — one easy auth for all.</p>
        <div style={{marginTop:14, display:'flex', justifyContent:'center', gap:12}}>
          {user ? (
            <Link to="/marketplace" className="btn btn-primary" style={{padding:'12px 20px', textDecoration:'none'}}>Go to Marketplace — Try UPI Collect</Link>
          ) : (
            isClerkConfigured ? (
              <SignInButton mode="modal" fallbackRedirectUrl="/marketplace">
                <button className="btn btn-primary" style={{padding:'12px 20px'}}>Sign in — top corner →</button>
              </SignInButton>
            ) : (
              <Link to="/login" className="btn btn-primary" style={{padding:'12px 20px', textDecoration:'none'}}>Sign in — top corner →</Link>
            )
          )}
        </div>
        <div style={{marginTop:10, fontSize:10, color:'#94A3B8'}}>LIVE: Chaincode 9 funcs, JWT+MSP, Raft 3, SQL 4 indexes · MOCKED: KYC DigiLocker stub, DILRMP hash, NPCI UPI simulation (no live credentials), Sepolia secondary experimental</div>
      </div>
    </div>
  )
}
