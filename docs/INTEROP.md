# Cross-ledger transfer

A tokenised asset that can only exist on one permissioned ledger is a
database row with extra steps. The interesting question is what happens when
a holder wants their position represented somewhere else: a public chain
where they can prove ownership to someone who has never heard of this rail,
or another institution's ledger entirely.

Most answers to that question either hand-wave or quietly create the asset
twice. This one follows the Hyperledger Cacti shape.

## The shape

Cacti splits the problem in two, and the code keeps the split visible.

**Connectors**, one per ledger, each knowing how to talk to its own chain and
nothing else. There are two: the Drunix fork (this process) and an EVM chain
over JSON-RPC. A connector reports whether it is actually configured, so an
unconfigured one cannot be mistaken for a live integration.

**A business logic plugin**, `InteropGateway`, which sequences a transfer
across connectors and owns the failure handling.

## The sequence

```
PROPOSED -> LOCKED -> COMMITTED
                 \-> ABORTED
```

Lock and claim, which is the standard asset transfer shape (SATP formalises
it) and the only one where a crash cannot leave the asset in both places.

- **LOCK** moves the tokens into the `interop-custody` account in the
  securities ledger. They leave the holder's position, so they cannot be
  settled here while they are represented elsewhere. This is a real ledger
  movement with a block behind it, not a status flag, which means "how much
  of this asset is immobilised" is answered by reading a position.
- **COMMIT** records the counterpart leg. The tokens stay in custody: that
  custody balance **is** the amount represented on the other ledger, which is
  what stops the same square metre existing twice.
- **ABORT** returns the tokens. The holder or a supervisor may do it before
  expiry; after expiry anyone may, because a lock only its beneficiary can
  release is a way to strand someone's asset.

A transfer closes exactly once. Aborting a committed transfer is refused,
which is the bug that has drained real bridges: the holder gets their tokens
back while the remote chain still represents them.

## Verified against attested

This is the part worth reading carefully.

With `EVM_RPC_URL` and `EVM_REGISTRY_ADDRESS` set, a commit carrying a digest
is checked against the remote chain by the connector. If the chain has no
record of it, the commit is **refused**. If it does, the transfer is marked
`remoteLegVerified: true`.

With no connector configured, which is the current state, a commit records a
reference **attested** by a supervisor. The record says so in words, the flag
stays false, and the statistics count `committedVerified` and
`committedAttestedOnly` separately. Adding them together would be the
dishonest number, so the code never does.

## What is real and what is not

Real: the lock, the custody movement, the abort, the expiry rule, the state
machine, the refusals, and the blocks behind every step. These all run on
this rail and the tests cover them, including an attempt to settle a locked
position, which fails.

Not real: anything on a public chain. Nothing here has been bridged to
Sepolia or anywhere else. Pointing the EVM connector at a testnet is a
configuration change rather than new code, but until that is done, a
committed transfer is a claim about another ledger, recorded under the name
of the person who claimed it.

## Routes

```
GET  /umi/interop                      connectors, stats, the caveat
GET  /umi/interop/transfers?limit=50
POST /umi/interop/lock                 {assetId, holder, tokens, remoteLedger, remoteAccount, expiresInSec}
GET  /umi/interop/{id}
POST /umi/interop/{id}/commit          {remoteTxRef, digest}   supervisor
POST /umi/interop/{id}/abort           {reason}
```

Locking moves someone's asset, so it is the holder's act or a supervisor's.
Committing asserts something about another chain under the caller's name, so
it is supervisor only.

## Try it

```bash
H='-H Content-Type:application/json -H X-Identity-Id:originator1 -H X-Identity-Role:Originator'
R='-H Content-Type:application/json -H X-Identity-Id:regulator1 -H X-Identity-Role:Regulator'

# who is connected
curl -s localhost:21100/umi/interop

# lock 10 tokens
curl -s -X POST localhost:21100/umi/interop/lock $H \
  -d '{"assetId":"PROP-GREEN-VALLEY-PUNE-001","holder":"originator1","tokens":10,"remoteLedger":"evm","remoteAccount":"0xabc","expiresInSec":600}'

# the locked tokens are now in custody, and a settlement of them fails
curl -s localhost:21100/umi/reconciliation | grep -o 'interop-custody'

# close it, or give it back
curl -s -X POST localhost:21100/umi/interop/XCHAIN-000001/commit $R -d '{"remoteTxRef":"0xdeadbeef"}'
curl -s -X POST localhost:21100/umi/interop/XCHAIN-000001/abort  $H -d '{"reason":"no counterpart"}'
```
