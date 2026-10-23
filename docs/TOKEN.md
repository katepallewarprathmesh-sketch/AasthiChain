# The property token on a public chain

`contracts/PropertyToken.sol`, written to by `drunix-gateway/tokenmirror.go`,
signed by `drunix-gateway/evmsign.go`, shown at `/token`.

## What changed, and why it mattered

The contract has existed since 22 October 2026 and passed 66 checks against a
deployed copy on a local chain. Nothing called it. A reviewer could read the
Solidity and read the rail and find no connection between them, which made the
contract a well-tested artefact sitting beside the system rather than part of
it. That is what the AMA sheet meant by "the rail does not write to it
automatically".

Closing it needed one thing that did not exist: the rail could only write
through `eth_sendTransaction`, which asks the node to sign from an account it
has unlocked. No public chain holds your keys. Sepolia, and every provider in
front of it, accepts `eth_sendRawTransaction` only. So the rail had to be able
to build and sign a transaction itself.

## The signer

`evmsign.go` implements secp256k1 scalar multiplication, ECDSA with RFC 6979
deterministic nonces, the low-s normalisation EIP-2 requires, recovery-id
computation, minimal RLP and EIP-155 legacy transaction encoding. No new
dependency: go-ethereum is a very large tree for four operations.

It is pinned to the specification's published example. `TestSignTxMatchesEIP155Vector`
asserts the raw bytes and the transaction hash are identical to the vector in
EIP-155 itself. A signature this code merely accepts would prove nothing; a
byte-identical match with the specification proves the whole encoding.

Two properties are tested because getting them wrong is how keys are lost:

- **Deterministic nonces.** The same transaction signed twice produces the
  same bytes. A repeated random nonce across two different messages gives up
  the private key by subtraction.
- **Low s.** Every signature falls in the lower half of the curve order, which
  is what EIP-2 demands and what removes signature malleability.

It is not constant time, and does not pretend to be. It is for a testnet key.
A production deployment signs in an HSM and replaces this file.

## The two operations

**LINK** registers a holder's Ethereum address in the on-chain
`IdentityRegistry` with their KYC tier and a **hash** of their DID. The
identity itself never reaches the chain. Until an address is registered the
token contract refuses to let it hold anything, which is the point: the
eligibility rule lives in the contract, not in our interface.

**MIRROR** brings the wallet's on-chain balance up to the holder's rail
position by minting the shortfall, and nothing more.

## The invariant

	an on-chain balance never exceeds the holder's rail position

A mirror that can exceed the register is not a mirror; it is a second issuance
of the same property, and it is the failure that makes people distrust
tokenised real assets. So:

| Situation | What happens |
| --- | --- |
| Chain behind the rail | mint exactly the shortfall |
| Chain level with the rail | refused, `ERR_TOKEN_ALREADY_CURRENT` |
| Chain **ahead** of the rail | refused, `ERR_TOKEN_EXCEEDS_RAIL_POSITION`, and the arithmetic is shown |
| Holder not KYC verified | refused before anything is signed |
| Wallet not registered | refused before gas is spent |
| Signer cannot cover gas | refused before the nonce is consumed |
| The contract would revert | refused, with the revert decoded |

Every one of those refusals is written to our own ledger as
`UMI_TOKEN_REFUSED`. A decision that leaves no trace cannot be audited.

## A bug this found, which is the reason for the preflight

The first live mirror against a local chain was reported as a success. It
returned a transaction hash, the node accepted it, and the on-chain balance
never moved. The transaction had mined as a **revert**: the offering's
compliance contract capped a holder at 1,000 tokens and the mint was for
15,000.

A write path that cannot tell a mined transaction from a mined revert produces
confident wrong answers, which is worse than having no write path. Two things
were added:

1. **Preflight.** Every write is simulated with `eth_call` first. If the
   contract would reject it, the rail refuses and names the rule, without
   spending gas to be told something it could have learned for free.
2. **Receipt confirmation.** After submission the receipt is polled, and a
   status of `0x0` is reported as a failure rather than as a hash.

Solidity custom errors are cheaper than revert strings and completely opaque
without a lookup table, which is why `execution reverted` is such a common
dead end. `decodeRevert` unpacks `Error(string)` and matches the four-byte
selector of every error declared in `PropertyToken.sol`, so
`ERC7943CannotTransact` reads as "the address is not registered in the
on-chain identity registry, or is frozen".

## Walked end to end on 23 October 2026

Against ganache at chain id 1337, with the contracts deployed by
`contracts/deploy-token.mjs` and the rail holding the issuing agent's key:

| Step | Result |
| --- | --- |
| `POST /umi/token/link` for an unverified holder | refused, `ERR_UMI_TOKEN_HOLDER_NOT_VERIFIED`, nothing signed |
| KYC completed, then `link` | transaction `0x0ec6e786…`, receipt status 1, 116,527 gas; `isVerified` on chain became true at tier 1 |
| `mirror` of a 15,000 position against a 1,000 cap | refused by the preflight, `ERR_UMI_TOKEN_CONTRACT_REFUSED` |
| `mirror` of a 500 position | minted; `balanceOf` on chain became 500 |
| `compare` | `agrees: true`, 500 on chain against 500 on the rail |
| `mirror` again | refused, `ERR_UMI_TOKEN_ALREADY_CURRENT` |

## What this does not claim

**The chain is not the register.** Title to Indian immovable property is not
transferable by a public blockchain. The contract mirrors a position the rail
already records; settlement, the cash leg and the register stay on the rail.

**It is one way.** A transfer made directly between two linked wallets on the
public chain is not written back. That is deliberate, not an oversight: a
public chain must not be able to reassign property. The consequence is that
the two can drift, so `GET /umi/token/compare` reports drift per wallet, in
both directions, and names which side is ahead.

**A public testnet has not been used yet.** Everything above ran against a
local chain, because that needs no funded key. Point `EVM_RPC_URL`,
`EVM_CHAIN_ID=11155111` and a funded `EVM_SIGNER_KEY` at Sepolia and the same
code path writes there; the records carry an Etherscan link when it does.

## Configuration

	EVM_RPC_URL                    JSON-RPC endpoint
	EVM_TOKEN_ADDRESS              deployed PropertyToken
	EVM_IDENTITY_REGISTRY_ADDRESS  deployed IdentityRegistry
	EVM_CHAIN_ID                   11155111 for Sepolia, 1337 for ganache
	EVM_SIGNER_KEY                 32-byte hex key, or EVM_SIGNER_KEY_FILE

With none of these set the routes still mount and `GET /umi/token` lists
exactly which variables are missing. "Not configured" on its own sends a
reader to the source code.

## Routes

| Route | What it does |
| --- | --- |
| `GET /umi/token` | configuration, gas balance, and every write made |
| `GET /umi/token/compare?assetId=` | each linked wallet against its rail position |
| `POST /umi/token/link` | register a holder's address on chain |
| `POST /umi/token/mirror` | mint the shortfall so the chain matches the rail |

Reads are public. The claim is that an outsider can check our tokens against a
public chain, and a status page they need a key to see would undercut it.
