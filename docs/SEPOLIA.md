# Taking the EVM connector live on Sepolia

The cross-ledger gateway (`docs/INTEROP.md`) ships with its EVM connector
unconfigured, and says so everywhere it is shown. This is the runbook that
moves that boundary from simulated to live. It is configuration plus a
contract deployment: no code changes, which is the point of putting the
connector behind an interface in the first place.

Nothing in this document has been run against Sepolia. It is written from the
code that would do it, and the fact that it is untried is exactly why the
trust page still says the connector is not configured.

## What you need, and what you do not

Read and write have very different requirements here, and the first version
of this document ran them together. They are separate:

**To verify cross-ledger commits (the interop connector), you need only an RPC
URL.** The check is `eth_call` against `verifyDigest`, which is a read. No
account, no private key, no Sepolia ETH. Any public Sepolia endpoint works.

**To write document anchors (the mirror in `evm_mirror.go`), you need more,
and the current code cannot do it through a hosted provider.** It calls
`eth_sendTransaction`, which asks the node to sign. Infura, Alchemy and the
endpoint behind MetaMask hold no keys for you, so they reject it. Writing
needs either a node that holds an unlocked account (anvil, geth, a local
signer in front of the provider) or local signing in the mirror, which is not
written yet.

So for the interop work the sequence is: deploy the registry once from a
wallet you already control, then give the rail a read-only RPC URL and the
contract address. Deployment is the only step that spends gas.

## 1. Deploy the registry

`contracts/DocumentRegistry.sol` is the contract the connector talks to. It
stores an anchor per document: the CID key, the SHA-256 digest, the asset id,
a type and a validity window, with a registrar allowlist for writes and
`verifyDigest(bytes32)` open to everyone for reads.

`contracts/deploy.js` and `contracts/deploy-local.mjs` are the existing
deployment paths. Deploy to Sepolia, then note the address.

Give the sending account the registrar role:

```solidity
setRegistrar(<sender address>, true)
```

Without it every anchor reverts, while reads keep working, so a missing
registrar role looks like "writes silently fail and verification always says
no".

## 2. Point the rail at it

On the rail host (Render), set:

```
EVM_RPC_URL=https://sepolia.<your provider>/<key>
EVM_REGISTRY_ADDRESS=0x<deployed address>
# only for anchor writes, and only against a node that holds this account:
# EVM_SENDER_ADDRESS=0x<account with the registrar role>
```

Restart. Two things change on their own:

- `GET /umi/interop` reports the EVM connector as `configured: true` and the
  status line becomes the RPC URL and contract address.
- A commit carrying a digest is now checked against Sepolia. If the chain has
  no record of it the commit is **refused** rather than recorded, and the
  transfer stays LOCKED so the holder can still abort and get their tokens
  back.

The same variables also switch on the existing document mirror
(`evm_mirror.go`). Against a hosted provider its writes will fail, for the
signing reason above, and that failure is contained: anchoring to the local
chain is unaffected and no settlement can fail because of it. KYC evidence is
excluded from the mirror by design and stays excluded.

## 3. Confirm it rather than assume it

```bash
# the connector should now say configured
curl -s https://<rail-host>/umi/interop | python3 -m json.tool | head -20

# a digest the chain has never seen must be refused, not recorded
curl -s -X POST https://<rail-host>/umi/interop/XCHAIN-000001/commit \
  -H 'Content-Type: application/json' -H 'X-Identity-Role: Regulator' -H 'X-Identity-Id: regulator1' \
  -d '{"remoteTxRef":"0x0","digest":"'"$(printf 'nothing' | sha256sum | cut -d" " -f1)"'"}'
# want: ERR_UMI_INTEROP_STATE, "evm has no record of that digest"
```

The refusal is the test that matters. A connector that accepts anything is
worse than no connector, because it turns an attestation into something that
reads like a confirmation. Both directions are covered by
`TestConfiguredConnectorVerifiesTheRemoteLeg` and
`TestConfiguredConnectorRefusesAnUnbackedCommit`, which run against a stub
JSON-RPC node that speaks the same `eth_call` the real contract answers.

## 4. Update the trust page

`/trust` reads `EVM_RPC_URL` and `EVM_REGISTRY_ADDRESS` for the public chain
mirror row, so that one flips on its own. The cross-ledger row is written as
simulated in prose and has to be edited by hand once a transfer has actually
been verified against Sepolia. Do not edit it before that: the row is about
what has happened, not what is configured.

## What this still would not be

A verified commit proves the remote chain holds the digest. It does not mint
anything on Sepolia, and there is no ERC-20 or ERC-721 representing the
asset over there. The locked tokens are immobilised here against evidence
recorded there, which is an anchor, not a bridge. Issuing a real token on the
remote side, and burning it to release the lock, is the next piece of work
and is not written.
