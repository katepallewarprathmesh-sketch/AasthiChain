# Chain support today, and a plan for integrating with real platforms

This answers two questions: **which chains does AasthiChain actually support right now**, and **what has to be true for it to drop onto NPCI's real Drunix — or any other platform — without a rewrite.**

Everything below about `npci/drunix` was read from the repository on 30 Sep 2026, not recalled.

---

## Part 1 — What is actually supported today

Short answer: **one and a half chains.** Not Solana. Not really Ethereum.

| Chain | What exists | Honest status |
|---|---|---|
| **Drunix / Hyperledger Fabric** | `drunix-gateway/` simulates the whole pipeline; `chaincode/` is **real** Fabric chaincode | **Simulated at runtime, real at the contract layer** |
| **Ethereum (Sepolia)** | `contracts/PaymentEscrow.sol`, `ethers` installed, `TestnetPayment.jsx` wired to MetaMask | **Not connected. Fabricates transaction hashes.** See below |
| **Solana** | Nothing. Zero references in the codebase | **Not supported** |
| **Polygon / Besu / Corda / Quorum** | Nothing | **Not supported** |

### The one genuinely valuable asset: the chaincode is real

`chaincode/go.mod` depends on the actual Hyperledger libraries:

```
github.com/hyperledger/fabric-contract-api-go v1.2.2
github.com/hyperledger/fabric-chaincode-go
```

`main.go` registers three contracts through `contractapi.NewChaincode(...)` exactly as a production Fabric chaincode does. **This is deployable to a real network as-is.** It is the single strongest integration asset in the repo, and it is worth protecting.

`drunix-gateway/` is a different thing: an in-process *simulation* of the peer pipeline. Valuable as a fast test harness and as an executable model of the protocol, but it is not a client to anything.

### The Sepolia leg is fabricating on-chain proofs — fix this first

This is the most serious thing I found, and it should be dealt with before any new chain work.

`TestnetPayment.jsx` has a function called `initiateRealPayment`, commented *"REAL Sepolia flow actual faucet ETH, real MetaMask signing, real Etherscan-verifiable tx"*. The actual contract call is commented out. What runs instead is:

```js
const simulatedRealHash = '0x' + Array.from({length:64}, ()=>Math.floor(Math.random()*16).toString(16)).join('')
setTxHash(simulatedRealHash)
// ...
body: JSON.stringify({ ..., isSimulated: false, realTx: true })
```

A random hex string, flagged **`isSimulated: false`**. The backend then builds a live explorer link from it:

```js
sepoliaExplorer: isSimulated ? '' : `https://sepolia.etherscan.io/tx/${finalTxHash}`
```

And the UI tells the user, in four separate places, that the result is *"Etherscan-verifiable"*. It is not. The link 404s. `escrowContract` is the zero address, so `PaymentEscrow.sol` was never deployed.

There is even a code comment claiming fabricated hashes were removed — but it only covers *simulated* mode. The mode that fabricates is the one labelled real.

This breaks two of your own standing rules: no invented production integrations, and payment behaviour must be honestly labelled. A made-up hash presented as verifiable proof is worse than an obvious mock, because a reviewer who clicks it concludes the whole project is dishonest. **Phase 0 below fixes it.**

---

## Part 2 — What I found in `npci/drunix`

You were right that it has test infrastructure, and it changes the plan substantially.

**The repo** — 69 stars, 28 forks, 11 commits, v1.0.0 tagged Jun 2026, Apache-2.0, maintained (last merge Jun 2026, a fix to the *nwo integration test*).

**The decisive line in their README:**

> Backwards compatible with HLF v2.5.x

That single sentence means integration is mostly a **configuration and deployment exercise, not a rewrite**. The standard `fabric-gateway` SDK, standard chaincode lifecycle, and standard endorsement-policy syntax all apply. Our chaincode is already written against exactly those APIs.

**Their stated architecture changes:**
- Segregated responsibility for peers
- SQL database for on-chain storage
- Reduced network calls for private data sharing
- Stateless transaction validation service

**Their test network** (`drunix-network/test-network/README.md`) is the "inbuilt test" you were thinking of. Two peer orgs, and per org:

> one committing peer, one lite peer and one vssc server each, and a single node raft ordering service

Compare that with what `drunix-gateway/peer.go` already models: **Lite Peer → Orderer (raft-ish) → Validation Service → Committing Peer.** The simulation independently arrived at the real topology, including the lite/committing split and the separate validation service. Their `envVar.sh` even indexes peers as `0 = Lite Peer, 1 = Committing Peer`.

That match is the plan's biggest asset: our mental model is already correct, so the work is wiring, not redesign.

**Operational surface worth noting:**
- `./network.sh up createChannel`, `./network.sh deployCC -ccl go`, `cc invoke`, `cc query`
- Default state database is **yugabyte** (SQL), not LevelDB/CouchDB — their headline change
- Private data collections use the familiar `collections_config.json` with signature policies
- Prereqs: Linux, Docker, Go, jq, bash v4

---

## Part 3 — The plan

### Phase 0 — Stop fabricating proofs (blocking, small)

Non-negotiable before anything else ships.

1. Delete the fake-hash branch in `initiateRealPayment`. If the contract is not deployed, the honest outcome is a disabled button that says so.
2. Never emit `isSimulated: false` unless a real receipt came back from a node.
3. Only build an explorer URL from a hash the chain returned.
4. Rewrite the four "Etherscan-verifiable" strings to describe what actually happens.
5. Add a test asserting no response carries `isSimulated: false` without a verifiable hash.

Either deploy `PaymentEscrow.sol` to Sepolia and wire the real `ethers` call, or drop the claim. Both are fine; the current middle ground is not.

### Phase 1 — Prove the chaincode on real Drunix

The highest-value, lowest-risk step, and it is mostly `docker compose`.

1. Stand up their test network: `./network.sh up createChannel -c aasthichain`
2. Deploy our existing chaincode unmodified:
   `./network.sh deployCC -ccn aasthi -ccp ../../chaincode -ccl go`
3. Drive the same `PropertyContract` / `TokenContract` / `KYCContract` functions through `cc invoke`.
4. Record what breaks. Expected friction: Go version (`chaincode/go.mod` says 1.21), the yugabyte state DB's behaviour on rich queries, and endorsement-policy syntax for our two-MSP DvP rule.

**Deliverable:** `docs/DRUNIX_TESTNET_RESULTS.md` — commands run, what passed, what did not. If our chaincode runs unmodified on NPCI's own network, that is a far stronger claim than any amount of simulation, and it is *checkable by a third party*.

This cannot run in this sandbox (needs Docker and several GB), so it is a local/CI-runner task.

### Phase 2 — Harden the seam that already exists

`drunix-gateway/client.go` already defines the right abstraction:

```go
type DrunixClient interface {
    SubmitTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error)
    EvaluateTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error)
    GetTransaction(txID string) (*TxRecord, error)
    LedgerStatus() (*LedgerStatus, error)
}
```

Two implementations exist: `MockLedger`, and `FabricGateway` behind `-tags real`. But `FabricGateway` is a stub — it delegates straight back to the mock. So the seam is real and the far side is empty.

The work:
1. **Actually implement `FabricGateway`** against `github.com/hyperledger/fabric-gateway`, reading the env vars its doc comment already names (`DRUNIX_API_HOST`, `DRUNIX_MSP_ID`, `DRUNIX_CERT_FILE`, …).
2. **Delete the silent fallback.** Today, if the network is unreachable it quietly returns mock data. A settlement system must fail loudly; a degraded mode that looks identical to success is how fake settlements reach production.
3. **Write one conformance suite, run it against both implementations.** Same assertions, mock and real. That is what makes the swap trustworthy, and it is the pattern `payment-gateway/settlement/` already uses.
4. Keep the build tag, but make `real` the CI-tested path too.

### Phase 3 — Generalise to other platforms

Only after Phase 2. The current interface leaks Fabric vocabulary (`chaincode`, `creatorMSP`), which is *correct* for a Fabric-family target and wrong for anything else. Rather than bending it into a lowest-common-denominator shape that serves no chain well, introduce a narrower port for what the product actually needs:

```go
// What AasthiChain needs from any ledger, in its own vocabulary.
type SettlementLedger interface {
    RecordTransfer(ctx, TransferIntent) (Receipt, error)
    SettleDvP(ctx, DvPIntent) (Receipt, error)   // must be atomic or return ErrNotAtomic
    BalanceOf(ctx, AssetID, PartyID) (uint64, error)
    Verify(ctx, Receipt) (Proof, error)
}
```

Then adapters: `fabricfamily/` (Drunix, Fabric, Besu-in-IBFT), `evm/`, and — only if ever justified — `solana/`.

The critical rule: **`SettleDvP` must either be genuinely atomic on the target or return `ErrNotAtomic`.** No adapter is allowed to emulate atomicity with two sequential writes and call it DvP. That is precisely the bug fixed in `docs/DRUNIX_CASH_LEG.md`, and a multi-chain layer is the easiest place to reintroduce it.

### Phase 4 — The cash leg

`docs/UMI_ALIGNMENT_PLAN.md` covers this. Note the direction of travel: Demat 2.0 settles the funds leg in **wholesale CBDC over RBI's UMI**, not in a token on the securities ledger. So the long-term shape is *securities on a Drunix-family ledger, cash on UMI*, with atomicity coordinated across the two. Our current single-ledger `SettleDvP` is the simpler case and the right place to start, but it is not the end state.

---

## Part 4 — On Solana and public L1s

You asked about Solana specifically. My recommendation: **do not put the register of ownership on it, and do not plan to.**

Not a performance objection — a legal one. These tokens represent SM REIT units, which are **securities** under SEBI (REIT) (Amendment) Regulations 2024, Chapter VIB. That brings requirements a permissionless L1 cannot satisfy:

- **KYC before transfer.** Fabric enforces this at endorsement via MSP identity. On Solana anyone with a keypair can receive a transfer; you would be reimplementing the allowlist in program logic and hoping no path bypasses it.
- **Regulator visibility and intervention.** Freeze, forced transfer on court order, beneficial-owner disclosure. Awkward-to-impossible to do credibly on a public chain without a privileged key that undermines the point of using one.
- **Where the market is going.** Demat 2.0 issues native tokens on a **private permissioned DLT owned by NSDL/CDSL**, with depositories holding investor keys. That is the regulated path, and it is Fabric-family — which is exactly where our chaincode already runs.
- **Finality and settlement law.** Probabilistic finality is a poor fit for a legal transfer of title.

Where a public chain *could* earn its place is **notarisation**: periodically anchor a Merkle root of the Drunix chain to a public network so anyone can prove the register was not retroactively edited. That is a genuinely useful independence property, it needs no securities to move on the public chain, and it costs almost nothing.

We already compute the right value — `drunixTxnsRoot` and the SHA-512 `prevHash` chain behind `/api/chain/verify`. Anchoring that root is a small, self-contained project, and it is the honest version of "we support a public chain".

If a public-chain integration is wanted for demo reach rather than regulatory fit, say so explicitly and we will build it labelled as such — but it should be the **Sepolia escrow done properly** (Phase 0), not a third chain layered on top of an unfinished second one.

---

## Recommended order

1. **Phase 0** — remove fabricated hashes. Small, urgent, protects credibility.
2. **Phase 1** — run our chaincode on the real Drunix test network. Highest proof-per-hour in the whole plan.
3. **Phase 2** — implement `FabricGateway` for real; kill the silent fallback; dual-run the conformance suite.
4. **Phase 3** — introduce `SettlementLedger` only when a second real target exists. An abstraction with one implementation is a guess.
5. **Phase 4 / anchoring** — as UMI access and priorities allow.

Phases 0 and 2 are doable here. Phase 1 needs Docker and should run on a real machine or a CI runner.

---

*Status: plan only. Nothing in this document is implemented, and no claim here should appear in product copy until the corresponding phase is done and verified.*
