# Anchoring the ledger on a public blockchain

This is the part of the system that is not a simulation. The RPC calls are live, the transaction
format is the real one, and the only reason writing is off by default is that it costs a fee.

## The problem it solves

The settlement ledger is permissioned and this process controls it. Replaying it from genesis
proves the history is internally consistent: every hash links, every merkle root recomputes. It
does not prove that this is the history that existed yesterday, because whoever runs the node
could have rebuilt the whole chain this morning and the replay would still pass.

The standard answer is to publish the head somewhere nobody involved controls. After that,
rewriting history means rewriting a record on a public network, which is not a thing the operator
of this ledger can do.

## What is published, and what is not

One memo, six fields, pipe separated:

```
aasthi|v1|<chain id>|<block height>|<block hash>|<transaction merkle root>
```

That is the whole payload. No participant, no asset, no amount, no counterparty. A digest and the
position it sits at. The transactions themselves never leave this process, which matters because
a public chain is permanent and personal data on one cannot be withdrawn.

An anchor proves a digest existed at a point in time. It does not prove the contents behind the
digest are true. Nothing can do that from the outside, and claiming otherwise would be the same
mistake the rest of this repository avoids.

## How it works

Solana, because the fee is a fraction of a cent, confirmation is seconds, and the memo program
exists for exactly this. There is no SDK underneath it. `drunix-gateway/solana.go` implements:

- base58, Bitcoin alphabet, for addresses and signatures,
- the compact-u16 (shortvec) length prefix Solana uses in its wire format,
- the legacy message layout: header, account list, recent blockhash, one memo instruction,
- ed25519 signing from the standard library, and the transaction envelope,
- JSON-RPC against the cluster: `getSlot`, `getBalance`, `getLatestBlockhash`, `sendTransaction`,
  `getSignatureStatuses`, `getTransaction`.

Writing it by hand rather than pulling a dependency has one practical benefit beyond the obvious:
the encodings are unit tested against known vectors with no network and no key, so a wire-format
regression is caught by `go test` rather than by a cluster silently rejecting a transaction.

## Verifying an anchor, as an outsider

```bash
curl -s localhost:21100/umi/anchors            # live cluster status and published anchors
curl -s localhost:21100/umi/anchors/<signature>  # read it back and compare
```

Verification reads the transaction off the cluster, pulls the memo out of the logs, finds the block
this ledger holds at that height, and compares the hashes. If they differ it says so: that is the
entire point of the mechanism, so the mismatch path is a reported result and not an error to be
swallowed.

Reads need no account, no key and no funds. Any public RPC endpoint works.

## Turning writing on

```bash
node scripts/anchor-key.mjs     # prints an address to fund and the secret to export
# fund the address with devnet SOL at https://faucet.solana.com
export SOLANA_SECRET_B58=<secret>
make dev
curl -s -X POST localhost:21100/umi/anchors \
  -H 'X-Fabric-Identity: regulator1' -H 'X-Identity-Role: Regulator'
```

Environment: `SOLANA_RPC_URL` (default the public devnet endpoint), `SOLANA_CLUSTER` (default
`devnet`), `SOLANA_SECRET_B58` (no default, and no key means no writing).

### On a hosted rail

The same variable, set wherever the Go rail runs (for this project that is the Render service, not
the Vercel frontend): Dashboard, the service, Environment, Add Environment Variable, key
`SOLANA_SECRET_B58`, then redeploy so the process restarts with it.

`SOLANA_SECRET_B58` is a server secret and belongs only to the process that signs. It must never be
set as a `VITE_`-prefixed variable or added to the frontend project, because anything Vite can read
is compiled into the bundle and served to every visitor. The browser never needs it: the frontend
reads anchors through the rail.

### Checking it took

`GET /umi/anchors` answers in one of three ways, and the distinction is the useful part:

| `writeDisabledBecause` | What it means |
| --- | --- |
| "No signing key is configured..." | the variable is absent or did not reach the process |
| "The anchor account holds no SOL..." | the key is loaded and valid, funding is the only thing left |
| absent, with `writeEnabled` true | ready to publish |

The second line is the good news case on a fresh key: it proves the secret parsed, the address
derived from it, and the cluster is reachable. The address in that message is the one to fund, and
it is derived from the secret rather than configured separately, so the two cannot drift apart.

Publishing is restricted to a supervisor because it spends a fee and cannot be undone. A successful
anchor commits a `UMI_CHAIN_ANCHORED` block locally carrying the signature and the explorer link, so
the local ledger records its own publication.

## Current status

Writing is **off** in every environment of this project right now: no funded key is configured. The
status endpoint says so in those words rather than implying an anchor exists. Reads and verification
against the public cluster are live today, which is why the integration checks can run against the
real network without a wallet.

Devnet, not mainnet. Devnet SOL has no value, which is the right risk profile for a demonstration.
Moving to mainnet is a change of two environment variables and a funded key; the code does not
change, and neither does anything written above.
