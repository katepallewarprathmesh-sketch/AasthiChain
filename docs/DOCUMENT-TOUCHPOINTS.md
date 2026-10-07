# Every step in AasthiChain where a document exists

An audit, not a plan. Each row is a point in the system where a real document,
certificate or instrument is involved — either one that arrives from outside,
or one AasthiChain produces — with what happens to it now.

Rule applied throughout: **the fingerprint is always anchored; the bytes are
stored only when storing them is safe.**

| # | Step | Document | Where | Status |
|---|------|----------|-------|--------|
| 1 | `POST /api/properties` | Title deed | `mock-api-server.js` → rail | **Anchored automatically** by digest. CID derived from the `documentHash` already on the Fabric chain, so nothing is re-uploaded |
| 2 | `POST /api/properties/:id/validate` | **Title validation certificate** | Node → rail | **Generated and anchored.** Public: a buyer reads it with no login. States decision, validator, MSP, independence, block |
| 3 | `POST /api/properties/:id/mint` | **Tokenisation certificate** | Node → rail | **Generated and anchored.** Public. Issued supply, valuation, deed digest, validating registrar |
| 4 | `POST /umi/dvp` (settlement) | **Contract note** | `drunix-gateway/certificates.go` | **Generated and anchored.** Restricted to both counterparties. Deterministic |
| 5 | `POST /umi/servicing` (coupon / rent) | **Income advice** — the bondholder's tax document | `certificates.go` | **Generated and anchored**, one per holder. Restricted to holder + payer |
| 6 | NPCI escrow release / PayU settle | **Payment receipt** | `mock-api-server.js` | **Generated and anchored.** Restricted. UTR, RRN, tokens, transfer id |
| 7 | `POST /api/credit/repay` | **Loan discharge certificate** | `mock-api-server.js` | **Generated and anchored.** Restricted. Collateral release evidence |
| 8 | DigiLocker callback (Vercel) | Aadhaar / PAN verification | `frontend/api/index.js` | **Digest anchored, document never transmitted.** Forced `digestOnly` |
| 9 | DigiLocker provider (Go service) | Aadhaar / PAN verification | `payment-gateway/kyc_anchor.go` | **Digest anchored** in the background. No-op unless `UMI_GATEWAY_URL` is set |
| 10 | `POST /api/properties/:id/verify-document` | Buyer's copy of the deed | Node | Unchanged, still works. Now also answerable by CID or by file |
| 11 | `GET /api/properties/:id/verify` | The verification report | Node | **Cites the register**: how many documents are active, revoked, superseded |
| 12 | Ad-hoc uploads (EC, plan, NOC, IM, trust deed) | Any supporting document | `POST /umi/documents` | **Stored and anchored**, with visibility and a validity window |
| 13 | Property page | Buyer checking their copy | `PropertyDocuments.jsx` | **Hashed in the browser.** Only the digest is sent |
| 14 | Chaincode `RegisterProperty` | Title deed | `chaincode/property.go` | Unchanged. Its `hash~` uniqueness index still applies and is now mirrored by the register's duplicate rule |
| 15 | Public-chain mirror | Any anchored document | `contracts/DocumentRegistry.sol` + `drunix-gateway/evm_mirror.go` | **Deployed and live.** Every public/restricted anchor is written to an EVM chain in the background. `tests/evmmirror.test.mjs` audits it by reading the contract directly, never through our API |

## Deliberately not anchored

- **Bhoomi / Dharani land-record comparisons.** The state API response is not
  ours to republish, and its contents change between calls, so a digest of it
  would be evidence of nothing. The *outcome* of the check is already a
  verification check.
- **Document contents on the public chain.** Permanent, expensive, and an
  irreversible privacy breach. The EVM contract takes a `bytes32` digest and a
  CID string; there is a test asserting no function anywhere accepts file bytes.
- **Anything derived from PII.** KYC anchors hash a canonical summary with a
  masked id, never the document.

## Visibility rules, in one place

| Visibility | Who can read the bytes | Used for |
|------------|------------------------|----------|
| `public` | Anyone | Validation certificate, tokenisation certificate, brochures, approved plans |
| `restricted` | Submitter, named parties, registrar, regulator | Contract notes, income advices, payment receipts, sale agreements |
| `digestOnly` | **Nobody — never stored** | KYC evidence, legacy deeds anchored from a hash |

Default when unspecified is `restricted`. A document nobody classified should
not be world-readable.


## The public-chain mirror

Until now the Solidity contract compiled but nothing ever called it. It does now.

`drunix-gateway/evm_mirror.go` writes each anchor to a deployed
`DocumentRegistry.sol`, over plain JSON-RPC with hand-rolled ABI encoding — no
EVM client library in the Go build. It is opt-in and fails safe:

| Setting | Meaning |
|---------|---------|
| `EVM_RPC_URL` | JSON-RPC endpoint. **Unset ⇒ the mirror is nil and nothing changes.** |
| `EVM_REGISTRY_ADDRESS` | Deployed contract |
| `EVM_SENDER_ADDRESS` | Account holding the registrar role (defaults to `eth_accounts[0]`) |

Rules it follows:

- **The Drunix block is the system of record.** Mirroring happens in a
  goroutine after the lock is released. A dead EVM node can never stop a
  property being registered — it logs the first failure and then every tenth.
- **Digest-only records are never mirrored.** KYC evidence must not gain a
  permanent public footprint that outlives our own retention rules. Asserted
  by test.
- **The asset id is hashed, not sent.** The chain is queryable by anyone who
  knows the id and readable by nobody who does not.
- **Only the CID, the digest, the type and the timestamps go on chain.** Never
  file contents.

Run it locally — one command brings up the rail, the app, a chain, and the
deployed contract:

```bash
bash scripts/dev-stack.sh           # prints the exact audit command to run
bash scripts/dev-stack.sh --no-evm  # default build, mirror off
bash scripts/dev-stack.sh --stop
```

It degrades rather than failing: no `npx`, no `solc`, or a chain that will not
start just means the mirror stays off and everything else still comes up.

The test is the point: all 16 assertions read the contract over JSON-RPC and
never ask AasthiChain whether a document is genuine. A counterparty holding
only the contract address can run it against us.


## Is any of this actually IPFS?

A CID we compute ourselves and never check is just a hash with a fancy name.
Two claims had to be proven rather than asserted:

**1. Our CIDs are real IPFS CIDs.** `tests/cidconformance.test.mjs` anchors
bytes through the production path and compares the result with
`ipfs-only-hash`, the reference JS implementation, at the sizes that actually
break implementations:

| Case | Result |
|------|--------|
| 1 byte, short text, non-ASCII (`₹`, em dash) | matches |
| 262143 B — one under the chunk boundary | matches, raw block |
| 262144 B — exactly the boundary | matches, raw block |
| 262145 B — one over | matches, **switches to dag-pb** |
| 529288 B — three chunks | matches |

The boundary cases are the point: below it a file is one raw block
(`bafkrei…`), above it the root becomes a dag-pb node (`bafybei…`) whose link
table must be laid out byte-exactly. Get it wrong and you produce a
respectable-looking CID that resolves to nothing on every gateway on earth.

**2. The anchor exists somewhere we do not control.** Covered by the EVM
mirror above, and surfaced to the person doing the checking: `POST
/umi/documents/verify` returns an `onChain` block alongside its own verdict,
naming the contract so they can repeat the query themselves. `/verify` renders
it as a "second opinion from a public blockchain".

If the chain is unreachable the block reports `checked: false` — **unproven,
never a negative**. An outage at our end must not make a genuine document
look forged. Verified by pulling the chain down mid-session: the verdict stayed
`anchored and current` and only the second opinion degraded.

Together these are what "verifiable without trusting our servers" means in
practice: the name is computed by a published algorithm anyone can rerun, and
the claim that we published it at a given time is recorded on a chain we
cannot edit.

### Still outstanding

Pinning to a live Kubo node is implemented (`IPFS_API_URL`, with the node's
own hash compared against ours and the pin refused on mismatch) but has not
been exercised against a real daemon — `dist.ipfs.tech` is unreachable from
this environment. The CID maths it depends on is now verified independently,
so the remaining risk is operational rather than cryptographic.
