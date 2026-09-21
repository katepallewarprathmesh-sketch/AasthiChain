# Final Verification v2.1 — Priority Fixes + Live E2E

**Date:** 2026-09-21
**Live URL:** https://aasthi-chain.vercel.app — 200 OK + /api/health OK — version 2.1-npci-fixed
**Correct Domain:** aasthi-chain.vercel.app (with hyphen) — aasthichain.vercel.app (no hyphen) returns 404, documented as such

## Priority 1 — Remove Real-Looking VPA 80105301033@axl — DONE

**Risk:** 10-digit Indian mobile pattern @axl looked like real PII in public repo/live demo/judge materials.

**Fix:**
- Replaced everywhere (excluding dist) with obviously fictitious handles:
  - `80105301033@axl` → `demo.investor@aasthichain`
  - `80105301033@okaxis` → `demo.investor@fakebank`
  - `80105301033@okhdfcbank` → `demo.owner@fakebank`
- Files updated:
  - `frontend/api/index.js` npciBalances only fictitious
  - `frontend/src/components/NPCIPayment.jsx` default payerVpa demo.investor@aasthichain
  - `payment-gateway/gateway.go` MockBalanceProvider GetBalance returns 10L for fictitious
  - `payment-gateway/gateway_test.go`, `gateway.test.js` balances map updated
- Grep verification:
  - `grep -r 80105301033` → zero hits outside dist
  - `grep -rn [0-9]{10}@` → zero hits outside dist
  - `grep -rn @axl` → zero hits outside dist
- Git history note: commits 0b21923 feat change default UPI VPA to 80105301033@axl and 006c159 fix ERR_ASSET_NOT_FOUND still contain old VPA — will remain in history unless squash/force-push before public sharing (rebase -i). For hackathon, current HEAD clean, but history should be cleaned if repo made fully public.
- Comment updated to "fictitious test handle, NOT real mobile number — e.g., demo.investor@aasthichain"
- Local DvP test with fictitious VPA: Collect PENDING → Approve CONFIRMED → Transfer originator1→investor1 COMPLETED → Release RELEASED UTR IMPS418... — success, no ERR_ASSET_NOT_FOUND

## Priority 2 — Lock Down Pay to Field to Match Collect P2M Security — DONE

**Issue:** Editable Pay to broke Collect P2M pitch — buyer could redirect payment, contradicts seller-initiated security model.

**Fix in NPCIPayment.jsx:**
- Default visitor UI: Pay to shows disabled locked div with payeeVpa (originator@aasthichain) + label "Verified owner — Collect P2M locked" + green check "Locked — seller-initiated Collect, buyer cannot redirect (P2M security)"
- Explanation: "🔒 Collect P2M: seller requests, buyer approves — payee fixed to verified property owner, cannot be changed — why Collect chosen over Intent"
- Developer toggle showDev=true: reveals editable input for internal testing only + warning "⚠️ Dev mode: editable for testing — in production Collect P2M payee is fixed, buyer cannot redirect payment"
- Matches Collect P2M semantics: seller initiates Collect request, buyer approves in UPI app, cannot redirect to arbitrary VPA — merchant collect security vs Intent push where buyer could typo redirect.
- Build 405KB gz 109KB success, 6x "Collect P2M" in bundle, 0x old VPA

## Remaining Items — Team/Bio + Budget + Consistency + Live E2E — DONE

### 4. Team Name/Bio + Budget ₹175k

**Team Name:** AasthiChain — Fractional Real Estate on Drunix

**Members:**
- Prathmesh Katepallewar — Full-stack & Blockchain Lead — Drunix Fabric chaincode (9 funcs, 216+ tests), payment-gateway UPI Collect module, React frontend, Vercel deploy — solo builder for hackathon slice

**Budget Breakdown ₹175,000:**
| Category | Amount | % | Details |
|---|---|---|---|
| Drunix Infra & Hosting | ₹60,000 | 34% | Docker 4 orgs + Raft 3 orderers + Postgres SQL state, Vercel Pro hosting, domain, read-replica |
| Payments & Compliance | ₹40,000 | 23% | UPI AutoCollect API integration, webhook + UTR reconciliation, KYC DigiLocker API, payment-gateway hardening paise int64, idempotency, RRN/UTR |
| Security & Audit | ₹35,000 | 20% | HSM-backed signing, endorsement hardening AND(Registrar, TitleInsurance), private data collections, threat model, pen test |
| Legal & SPV Setup | ₹20,000 | 11% | SPV per property per Registration Act 1908 + Asset Tokenisation Bill 2026, legal opinion, IFSCA/SEBI sandbox |
| Dev Tooling & Contingency | ₹20,000 | 11% | Alchemy/Infura RPC, Clerk Pro, monitoring, faucet contingency, docs & deck, chaos testing |
| Total | ₹175,000 | 100% | Hackathon slice already done v2.1, budget for Phase2 production hardening |

Updated in CHL-7007_PROPOSAL.md + docs/CHL-7007_PROPOSAL.md

### 5. Final Consistency Grep

- Old URL aasthichain.vercel.app (no hyphen): only appears in explanatory "not aasthichain.vercel.app 404" notes — no bare hyperlink to old domain — acceptable, correct is aasthi-chain.vercel.app
- Old valuation ₹50L/10k tokens: fixed in docs/DEMO_SCRIPT.md (was 10000 tokens for ₹50L → now 15000 tokens for ₹75L Green Valley Villas Pune PROP-GREEN-VALLEY-PUNE-001), PITCH_DECK.html already 75L, README fixed
- Old VPA regex without digits ^[a-z0-9._-]{2,64}@[a-z]{2,64}$: zero hits — current is ^[a-z0-9._-]{2,64}@[a-z0-9]{2,64}$ allows digits in domain (okaxis etc) — fixed

### 6. Full Live End-to-End Test — PASSED

**Live:** https://aasthi-chain.vercel.app

**Steps:**
1. Landing → 200 OK
2. /api/health → {"status":"ok","service":"aasthichain-api-gateway","version":"2.1-npci-fixed","paymentRails":{"primary":"NPCI UPI Collect (simulation, INR, P2M)","secondary":"Sepolia PaymentEscrow.sol"}}
3. /api/properties → Green Valley Villas - Pune PROP-GREEN-VALLEY-PUNE-001 valuationINR 7500000 totalTokens 15000 status TOKENIZED
4. POST /api/npci/collect assetId PROP-GREEN-VALLEY-PUNE-001 tokenAmount 100 amountINR 50000 payerVpa demo.investor@aasthichain payeeVpa originator@aasthichain → PENDING NPCI-C1BC2F64E534 RRN 418924225000 UTR IMPS4189242250008201 isSimulation true
5. POST /api/npci/payments/{id}/approve payerId investor1 → CONFIRMED
6. POST /api/transfers fromId originator1 toId investor1 amount 100 assetId PROP-GREEN-VALLEY-PUNE-001 → COMPLETED TXN-0817b12a-805a-4b25-bbb8-f9cc0ba5f569
7. POST /api/npci/payments/{id}/release drunixTransferId TXN-... → RELEASED UTR IMPS4189242250008201 callbackReceived true
8. GET /api/balances/wallet/investor1 → balance 2100 (2000 seed +100 bought) valueINR 1050000 totalPortfolioValue 1050000
9. GET /api/transfers/history?assetId=PROP-GREEN-VALLEY-PUNE-001 → shows transfer COMPLETED
10. GET /api/npci/payments → list shows payment RELEASED with fictitious VPA, no leaked PII

**Wallet → Regulator audit log:** No leaked PII, only fictitious demo.investor@aasthichain

**Build:** dist 405KB gz 109KB, 0x 80105301033, 4x demo.investor@aasthichain, 6x Collect P2M

Ready to push to Vercel — already live with v2.1-npci-fixed.

## Next Steps for Final Submission

- [x] Push frontend build to Vercel (auto via git push) — already live
- [x] Verify live site again after push
- [ ] Squash git history to remove 80105301033 from commits 0b21923, 006c159 if repo made fully public (optional, current HEAD clean)
- [ ] Upload PITCH_DECK.html to Drive and paste URL in proposal portal
- [ ] Submit CHL-7007_PROPOSAL.md content to hackathon portal with team/budget sections
