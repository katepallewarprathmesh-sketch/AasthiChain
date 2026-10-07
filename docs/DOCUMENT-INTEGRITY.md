# Tamper-proof documents: IPFS content addressing + on-chain anchoring

Design note, written before the code. It answers one question: **everywhere
AasthiChain touches a real document, how do we make that document impossible to
alter unnoticed, and fast to verify?**

---

## 1. Where real documents actually enter the system today

I went through the repo rather than guessing. Documents appear in five places.

| # | Where | What the document is | What happens to it today |
|---|-------|----------------------|--------------------------|
| 1 | `POST /api/properties` → chaincode `RegisterProperty` | Title deed / sale deed | A single `documentHash` (SHA-256, 64 hex) is stored on the asset and indexed as `hash~<hash>~<assetID>`, which makes the same deed un-tokenisable twice |
| 2 | `POST /api/properties/:id/verify-document` | Same deed, re-hashed by a sceptic | Compares the supplied hash with the stored one, returns `{match, registeredHash, suppliedHash}` |
| 3 | `/api/properties/:id/verify` | The five-check verification report | Reports whether a hash is present and well-formed |
| 4 | DigiLocker KYC (`payment-gateway/digilocker.go`) | Aadhaar / PAN / Voter ID pulled from the government wallet | Issuer response is held in memory; nothing is anchored |
| 5 | Property data verification (Bhoomi / Dharani / e-Property) | State land record | Compared in-flight; the comparison itself leaves no evidence |
| 6 | Settlement (`POST /umi/dvp`) | **Contract note** — the trade confirmation a broker must issue | Did not exist; a trade left no document at all |
| 7 | Asset servicing (`POST /umi/servicing`) | **Coupon / rent advice** — what a bondholder files with their tax return | Did not exist; a holder was told an amount and given nothing |

Touchpoints 6 and 7 are the ones nobody notices are missing, because there is
nothing there to inspect. They are also the ones that matter most for a BOND:
a coupon payment with no advice behind it is not an instrument anybody can
account for.

### What is genuinely good already

The deed hash is on a hash-chained ledger and is **unique-indexed**, so the same
document cannot back two tokenised properties. That is the single most valuable
property of the current design and nothing here weakens it.

### The six real gaps

1. **One document per property.** A real transaction is a folder, not a file:
   title deed, encumbrance certificate, mother deed, approved plan, occupancy
   certificate, property tax receipt, society NOC, and for a debt instrument the
   information memorandum, debenture trust deed and coupon payment advice. The
   schema has room for exactly one of them.
2. **No document is stored.** A hash proves integrity *only to someone who
   already has the file*. An investor who has never seen the deed gains nothing
   from a hash — they cannot fetch it, so they cannot verify it. This is the
   gap that makes verification slow: today it needs an out-of-band email.
3. **No document type, issuer, or validity window.** An encumbrance certificate
   is valid as of a date. A tax receipt covers a year. The system cannot
   express "this was true in March and is stale now".
4. **No lifecycle.** A deed cannot be superseded by a rectification deed, and a
   forged or withdrawn document cannot be revoked. Hashes are permanent but
   their *status* is not modelled at all.
5. **Adding a document commits no block.** Every settlement commits a `UMI_*`
   block, but the evidence that underpins the asset does not. The audit trail
   covers the money and not the paperwork.
6. **DigiLocker verification evaporates.** A successful government ID pull is
   the strongest evidence in the system and it is kept in a map that dies with
   the process.

---

## 2. The design

Three layers, each doing one job.

```
   file bytes
       │
       ├─► [1] CONTENT ADDRESS  — IPFS CIDv1 computed locally (sha2-256)
       │         the name IS the hash: fetching by CID is self-verifying
       │
       ├─► [2] ANCHOR           — UMI_DOC_ANCHORED block on the Drunix chain
       │         who, what type, when, which asset, at what block height
       │
       └─► [3] MIRROR           — DocumentRegistry.sol, same semantics on EVM
                 for the deployment where the counterparty is a public chain
```

### Layer 1 — IPFS content addressing

A CID is not a pointer to a file, it **is** the hash of the file in a
self-describing envelope. Two consequences, and they are exactly the two things
asked for:

- **Tamper-proof.** Change one byte of the PDF and the CID changes completely.
  There is no way to serve different bytes under the same CID, so a storage
  provider cannot lie, and nor can we.
- **Fast verification.** The verifier does not need our server to be honest or
  even online. `ipfs cat <cid>` from any node, or any public gateway, returns
  bytes that the verifier hashes themselves. Verification becomes a local
  computation rather than a trust decision.

**Decision: compute the CID ourselves, in Go, with no IPFS daemon and no new
dependency.** A CID is a defined byte format — `<version><codec><multihash>`,
base32-encoded with a `b` prefix — and nothing about computing one requires a
network. The rail therefore always knows the correct CID for a document even in
an air-gapped demo, and pinning to a real node (or Pinata/web3.storage) becomes
an optional, swappable step rather than a hard dependency. The CID we produce is
the same string `ipfs add --cid-version=1 --raw-leaves` produces, so it is
verifiable against the real network rather than a lookalike.

Large files are chunked at 256 KiB into a UnixFS DAG exactly as IPFS does, so
the root CID matches for a 40-page scanned deed, not just a small file.

**Storage is deliberately pluggable.** The interface is `Pin(cid, bytes)` /
`Fetch(cid)`. The default implementation keeps bytes in the rail's own store so
the demo is self-contained; a real deployment points it at an IPFS node or a
pinning service without touching any of the verification logic.

### Layer 2 — Anchoring to the Drunix chain

Content addressing proves a file has not changed. It does **not** prove *when it
existed* or *who submitted it*. That is what the ledger is for, and the ledger
is already append-only and tamper-evident.

Two new block types, consistent with the existing `UMI_*` family:

- `UMI_DOC_ANCHORED` — a document was attached to an asset: CID, SHA-256,
  document type, issuer, submitter, size, validity window.
- `UMI_DOC_STATUS` — a document was superseded or revoked, with a reason and a
  pointer to the replacement.

Because a block cannot be erased, **revocation is additive**. The original
anchor stays visible forever; the revocation sits on top of it. A verifier can
see both that a document was once relied upon and that it was later withdrawn —
which is strictly more honest than deleting it, and is how a real registry
behaves.

### Layer 3 — The Solidity mirror

The repo already has `contracts/PaymentEscrow.sol`, so an EVM path is an
established pattern here rather than a new one. `DocumentRegistry.sol` mirrors
the same semantics for deployments where the counterparty wants a public chain:
`anchor(assetId, cid, sha256, docType)`, `supersede`, `revoke`, and a view
`verify(cid)`. It stores the digest and the CID — **never the document** —
because putting a scanned deed on a public chain is both ruinously expensive and
a permanent privacy breach.

The contract enforces the same rule the chaincode already enforces for deeds:
**one CID can be anchored once**. A second attempt to anchor the same bytes
reverts with the asset that already claims them.

---

## 3. Privacy: the rule that constrains everything

A property deed contains names, addresses and signatures. An Aadhaar XML
contains far more. IPFS content addressing has a property people routinely
forget: **the CID is derived from the content, so anyone holding a copy of the
document can compute the CID and check whether we anchored it.** That is a
feature for verification and a hazard for privacy — it makes the CID a
confirmation oracle.

Three rules follow, and the implementation obeys them without an opt-out:

1. **KYC documents are anchored by digest only — never stored, never pinned,
   never fetchable.** The evidence that `investor1` passed an Aadhaar check is a
   hash and a timestamp. The Aadhaar itself does not enter the system.
2. **Property documents are pinned, but visibility is explicit.** A document is
   marked `public` (investors may fetch it — brochure, approved plan, EC) or
   `restricted` (hash and metadata are public, bytes are served only to the
   owner, the registrar or a regulator). The *proof* is always public; the
   *content* is not.
3. **No personal field is ever a metric label or a block field.** Blocks carry
   the digest, the type and the participant id that the rest of the rail already
   uses — not names, not ID numbers.

---

## 4. What this gives each party

| Who | Question they ask | How it is answered now |
|-----|-------------------|------------------------|
| Investor | "Is this deed real and current?" | Fetch by CID from any IPFS gateway, hash it themselves, see the anchoring block height and whether it was ever superseded |
| Registrar | "Has this document been used before?" | CID uniqueness — a duplicate anchor is rejected and names the asset that already claims it |
| Regulator | "What evidence existed on the day of settlement?" | Block height ordering: anchors and settlements are on one chain, so "was the EC on file before the trade" is a comparison of two integers |
| Auditor | "Was anything quietly swapped?" | Impossible by construction: a different file is a different CID, and the old CID is still in the chain |
| Us | "Can we be the weak link?" | No. Verification requires nothing from our servers |

---

## 5. Implementation plan

Additive throughout. No existing route changes behaviour; the single
`documentHash` field keeps working exactly as it does today and becomes the
first entry in the new registry when an asset is migrated.

| Step | File | Content |
|------|------|---------|
| 1 | `drunix-gateway/cid.go` | CIDv1 computation — multihash, multibase base32, UnixFS chunking for large files. No dependencies |
| 2 | `drunix-gateway/documents.go` | Registry: anchor, supersede, revoke, verify, per-asset listing, duplicate detection, pluggable pin store |
| 3 | `drunix-gateway/documents_server.go` | `/umi/documents*` routes |
| 4 | `contracts/DocumentRegistry.sol` | EVM mirror of the same semantics |
| 5 | `drunix-gateway/certificates.go` | Documents the rail GENERATES: contract notes and coupon advices, deterministic so they can be rebuilt and re-verified |
| 6 | `drunix-gateway/ipfs_store.go` | Real pinning to a Kubo node via `IPFS_API_URL`, with the node's CID cross-checked against ours |
| 7 | tests | CID correctness against published vectors, tamper detection, duplicate rejection, privacy rules, lifecycle, contract compilation |

### Generated certificates: why determinism is the whole trick

A contract note is a pure function of facts already on the ledger — instruction
id, parties, quantity, consideration in paise, block height. It carries no
"generated at" stamp and no sequence number, so rendering it today and
rendering it in five years produce identical bytes and therefore an identical
CID.

That is what makes the certificate verifiable rather than merely stored:
a counterparty does not have to trust the copy they were handed. They rebuild
it from the ledger facts, hash it, and see whether it matches what was
anchored at settlement time. A forged contract note cannot survive that, and
no signing key is involved.

Both certificate types are `restricted` and carry a `parties` list, because a
contract note names both sides and a consideration, and an income advice shows
one holder's earnings. Both counterparties can read their own; another investor
cannot read theirs.

### Routes

```
POST /umi/documents                 anchor {assetId, docType, content|contentBase64, issuer?, validFrom?, validTo?, visibility?}
GET  /umi/documents/{assetId}       every document for an asset, newest first
GET  /umi/documents/cid/{cid}       metadata for one CID + its anchoring block
GET  /umi/documents/fetch/{cid}     the bytes, subject to visibility
POST /umi/documents/verify          {cid?|sha256?|contentBase64?} → anchored, status, block, match
POST /umi/documents/{cid}/supersede {replacementCid, reason}
POST /umi/documents/{cid}/revoke    {reason}
```

### Rules the tests must enforce

- A one-byte change produces a different CID and verification fails.
- The same bytes cannot be anchored twice; the rejection names the first asset.
- A revoked document still appears in history, with its revocation.
- A KYC anchor has no retrievable bytes, under any route.
- Our CID matches what IPFS itself would produce — checked against published
  test vectors, not against our own implementation.
