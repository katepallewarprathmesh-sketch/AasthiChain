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
              Drunix Hackathon x Citi — Problem Statement 2
            </div>
            <h1 style={{fontFamily:'Fraunces', fontSize:48, fontWeight:800, lineHeight:0.95, letterSpacing:'-0.03em', color:'#0F172A'}}>
              Fractional real estate, <br/>
              <span style={{color:'#1E3A5F'}}>tokenized on Drunix.</span>
            </h1>
            <p style={{fontSize:16, color:'#475569', lineHeight:1.6, marginTop:16, maxWidth:'60ch'}}>
              AasthiChain converts real estate assets into fixed-supply, tradable ownership tokens on a permissioned multi-organization Drunix (Hyperledger Fabric) network. Built for registry-office grade trust, not crypto-trading hype.
            </p>

            <div style={{display:'flex', gap:12, marginTop:24, flexWrap:'wrap'}}>
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
                  <a href="#how-it-works" className="btn btn-secondary" style={{padding:'12px 20px', fontSize:14, textDecoration:'none'}}>How it works</a>
                </>
              )}
            </div>

            <div style={{display:'flex', gap:16, marginTop:24, flexWrap:'wrap'}}>
              {[
                { k: '4 Orgs', v: 'Originator, Registrar, Investor, Regulator' },
                { k: 'Raft', v: '3 orderers, 1 fault tolerant' },
                { k: 'SQL State', v: 'Postgres on-chain, 4 indexes' },
              ].map(item => (
                <div key={item.k} style={{display:'flex', flexDirection:'column', gap:2}}>
                  <span style={{fontSize:12, fontWeight:700, color:'#0F172A'}}>{item.k}</span>
                  <span style={{fontSize:11, color:'#64748B'}}>{item.v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{padding:20}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
              <h3 style={{fontSize:13, fontWeight:700}}>Live Marketplace Preview</h3>
              <span className="status-chip status-tokenized" style={{fontSize:10}}>TOKENIZED</span>
            </div>
            <div style={{background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:10, padding:14}}>
              <div style={{fontSize:14, fontWeight:600}}>Green Valley Villas - Pune</div>
              <div style={{fontSize:11, color:'#64748B', marginTop:2}}>Pune, Maharashtra · 411045</div>
              <div style={{display:'flex', gap:12, marginTop:10}}>
                <div><div style={{fontSize:10, color:'#94A3B8', textTransform:'uppercase', fontWeight:700}}>Valuation</div><div style={{fontSize:14, fontWeight:700}}>₹75L</div></div>
                <div><div style={{fontSize:10, color:'#94A3B8', textTransform:'uppercase', fontWeight:700}}>Tokens</div><div style={{fontSize:14, fontWeight:700}}>15,000</div></div>
                <div><div style={{fontSize:10, color:'#94A3B8', textTransform:'uppercase', fontWeight:700}}>Price</div><div style={{fontSize:14, fontWeight:700}}>₹500</div></div>
              </div>
              <div style={{marginTop:12}}>
                <div style={{display:'flex', justifyContent:'space-between', fontSize:10, color:'#64748B', marginBottom:4}}><span>62% sold</span><span>9,300/15,000</span></div>
                <div style={{height:6, background:'#E2E8F0', borderRadius:10, overflow:'hidden'}}><div style={{width:'62%', height:'100%', background:'#1E3A5F'}}></div></div>
              </div>
            </div>
            <div style={{marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:11}}>
              <div style={{background:'#F1F5F9', borderRadius:8, padding:10}}><div style={{fontWeight:700}}>Fixed Supply</div><div style={{color:'#64748B', marginTop:2}}>No inflation, 10M cap</div></div>
              <div style={{background:'#F0FDF4', borderRadius:8, padding:10}}><div style={{fontWeight:700, color:'#059669'}}>Instant Finality</div><div style={{color:'#64748B', marginTop:2}}>Drunix consensus</div></div>
            </div>
          </div>
        </div>
      </div>

      {/* What we solve */}
      <div id="how-it-works" style={{background:'white', borderTop:'1px solid #E2E8F0', borderBottom:'1px solid #E2E8F0'}}>
        <div style={{maxWidth:1120, margin:'0 auto', padding:'32px 24px'}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:20}}>
            <div>
              <h2 style={{fontFamily:'Fraunces', fontSize:20, fontWeight:700}}>The problem</h2>
              <p style={{fontSize:13, color:'#475569', lineHeight:1.6, marginTop:8}}>
                Real estate is illiquid, high-ticket, and paperwork-heavy. Retail investors can't access prime assets. Transfers take weeks, cap tables are opaque, and rental income distribution is manual.
              </p>
              <ul style={{fontSize:12, color:'#475569', marginTop:10, paddingLeft:16, lineHeight:1.7}}>
                <li>₹75L+ entry barrier for Pune villas</li>
                <li>No fractional ownership in India today</li>
                <li>Registration Act, 1908 needs SPV wrapper</li>
              </ul>
            </div>
            <div>
              <h2 style={{fontFamily:'Fraunces', fontSize:20, fontWeight:700}}>What we built</h2>
              <p style={{fontSize:13, color:'#475569', lineHeight:1.6, marginTop:8}}>
                Tokenize property into integer-only tokens (no decimals). Originator lists, Registrar validates legal title, dual endorsement `AND('OriginatorMSP.peer','RegistrarMSP.peer')` prevents unilateral mint, Investor trades, Regulator audits.
              </p>
              <ul style={{fontSize:12, color:'#475569', marginTop:10, paddingLeft:16, lineHeight:1.7}}>
                <li>9 chaincode functions, full edge-case coverage</li>
                <li>JWT + MSP auth, rate limit 100/min, persistent idempotency</li>
                <li>Sepolia testnet escrow for atomic DvP (PaymentEscrow.sol)</li>
              </ul>
            </div>
            <div>
              <h2 style={{fontFamily:'Fraunces', fontSize:20, fontWeight:700}}>Why Drunix</h2>
              <p style={{fontSize:13, color:'#475569', lineHeight:1.6, marginTop:8}}>
                Permissioned, not public. 4 orgs, Raft 3 orderers (1 fault tolerant, verified via chaos_test.sh), Postgres SQL state store with 4 indexes for O(log n) queries — no full ledger scans.
              </p>
              <ul style={{fontSize:12, color:'#475569', marginTop:10, paddingLeft:16, lineHeight:1.7}}>
                <li>idx_property_status, idx_balance_owner/asset, idx_transfer_asset_time</li>
                <li>MVCC double-spend protection via Fabric, not custom locks</li>
                <li>Block timestamp from orderer, not peer clock</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div style={{maxWidth:1120, margin:'0 auto', padding:'32px 24px'}}>
        <h2 style={{fontFamily:'Fraunces', fontSize:22, fontWeight:700}}>How it works — 4 roles</h2>
        <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginTop:16}}>
          {[
            { role:'Originator', desc:'Lists property, uploads docs, SHA-256 auto-computed, initiates tokenization', color:'#1E3A5F', steps:['Register property','Upload doc → hash','Wait validation','Mint tokens'] },
            { role:'Registrar', desc:'Validates legal title, co-signs mint — prevents unilateral mint', color:'#D97706', steps:['Review doc hash','Validate title','Co-sign mint','Audit'] },
            { role:'Investor', desc:'Buys, holds, transfers — KYC verified, integer-only tokens', color:'#059669', steps:['Browse marketplace','Buy tokens','Transfer peer-to-peer','Track portfolio'] },
            { role:'Regulator', desc:'Read-only audit, emergency freeze, transfer history', color:'#111827', steps:['View all properties','Audit cap table','Check transfers','Freeze if needed'] },
          ].map(item => (
            <div key={item.role} className="card" style={{padding:16}}>
              <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
                <div style={{width:8, height:8, borderRadius:'50%', background:item.color}}></div>
                <div style={{fontSize:13, fontWeight:700}}>{item.role}</div>
              </div>
              <div style={{fontSize:11, color:'#64748B', lineHeight:1.5, minHeight:36}}>{item.desc}</div>
              <div style={{marginTop:10, display:'flex', flexDirection:'column', gap:4}}>
                {item.steps.map((s,i) => (
                  <div key={i} style={{fontSize:11, display:'flex', gap:6, alignItems:'center'}}>
                    <span style={{width:16, height:16, borderRadius:'50%', background:'#F1F5F9', border:'1px solid #E2E8F0', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700}}>{i+1}</span>
                    <span style={{color:'#475569'}}>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Testnet DvP */}
      <div style={{background:'#0F172A', color:'white', marginTop:8}}>
        <div style={{maxWidth:1120, margin:'0 auto', padding:'28px 24px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:24, alignItems:'center'}}>
          <div>
            <h3 style={{fontFamily:'Fraunces', fontSize:18, fontWeight:700}}>Atomic DvP Settlement — Sepolia Testnet</h3>
            <p style={{fontSize:12, color:'#94A3B8', lineHeight:1.6, marginTop:6, maxWidth:'60ch'}}>
              Real on-chain testnet transactions demonstrating delivery-vs-payment: Testnet escrow locked → Drunix transfer → escrow released. Sepolia test ETH has no monetary value — production path is mainnet USDC/INR + Chainlink oracle, same escrow logic, applicable to UPI/NPCI.
            </p>
            <div style={{display:'flex', gap:8, marginTop:12, flexWrap:'wrap'}}>
              <span style={{fontSize:10, background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:20}}>PaymentEscrow.sol</span>
              <span style={{fontSize:10, background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:20}}>Chain 0xaa36a7</span>
              <span style={{fontSize:10, background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.15)', padding:'4px 8px', borderRadius:20}}>Etherscan verifiable</span>
            </div>
          </div>
          <div style={{background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:12, padding:14}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:11, color:'#94A3B8'}}><span>Escrow Initiated</span><span>→ Locked</span><span>→ Drunix Transfer</span><span>→ Released</span></div>
            <div style={{height:4, background:'rgba(255,255,255,0.1)', borderRadius:10, marginTop:8, display:'flex', gap:4}}>
              <div style={{flex:1, background:'#38BDF8', borderRadius:10}}></div>
              <div style={{flex:1, background:'#38BDF8', borderRadius:10}}></div>
              <div style={{flex:1, background:'#38BDF8', borderRadius:10}}></div>
              <div style={{flex:1, background:'#22C55E', borderRadius:10}}></div>
            </div>
            <div style={{fontSize:10, color:'#64748B', marginTop:8}}>Faucet: sepoliafaucet.com — 0.5 SepoliaETH = 100+ tx</div>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div style={{maxWidth:1120, margin:'0 auto', padding:'32px 24px', textAlign:'center'}}>
        <h2 style={{fontFamily:'Fraunces', fontSize:24, fontWeight:700}}>Ready to explore?</h2>
        <p style={{fontSize:13, color:'#64748B', marginTop:6}}>Sign in from top-right corner — one easy auth for all. No email code friction.</p>
        <div style={{marginTop:16, display:'flex', justifyContent:'center', gap:12}}>
          {user ? (
            <Link to="/marketplace" className="btn btn-primary" style={{padding:'12px 20px', textDecoration:'none'}}>Go to Marketplace</Link>
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
      </div>
    </div>
  )
}
