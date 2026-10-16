# Plan: verifiable credentials for title validation

## Why this and not the other ideas

Four themes came out of the public writing of the people most likely to review this
project: tokenisation as horizontal infrastructure rather than a vertical, self-sovereign
identity, outcome-based programmable settlement, and agentic actors. Ranked by what this
repository can honestly build:

| Idea | Decision |
|---|---|
| Verifiable credentials for registrar attestation | **Build now.** Closes the weakest real gap. |
| Outcome-based framing of the work desk | **Do now, documentation only.** The behaviour already exists. |
| Platform framing rather than real estate framing | **Do now, documentation only.** The code is already asset-class agnostic. |
| Agent identity with bounded authority | Not now. Large, and easy to overclaim. |
| Deeper Cacti interop | Not now. A shallow version is worse than the honest simulation already shipped. |
| Conditional settlement release | After credentials. It composes with them. |

## The gap being closed

Today a property page says title was validated by a registrar. The evidence for that is a
row in our database and a role check in our code. A reader has to trust the operator.

With a credential, the registrar signs a statement about a property, and anyone can check
that signature without trusting us, including after the platform is gone. That is the
difference between "our server says so" and "here is a signed statement you can verify".

## Design

**Where it lives.** The Go settlement core, next to the ledger. The credential is anchored
on the chain and verification reads the chain, so it belongs beside it. The Node edge gets
a pure proxy with no logic, per the standing rule.

**Format.** A W3C Verifiable Credential shaped document: `@context`, `type`, `issuer`,
`credentialSubject`, `issuanceDate`, plus a `proof` object carrying an Ed25519 signature
over the canonical bytes of the unsigned credential.

**Keys.** One Ed25519 issuer key per issuing participant, generated on first use and
persisted with the rest of the rail's durable state. The public key is served from the
rail so a verifier never needs our database for anything but the key, and the key's
fingerprint is written into the anchoring block, so a swapped key is detectable.

**Canonical bytes.** The credential is serialised with sorted keys and no wall-clock
field beyond `issuanceDate`, which is taken from the block the anchor lands in rather
than from the local clock. Re-serialising a stored credential must reproduce the same
bytes, or the signature check is meaningless.

**Anchoring.** Issuing commits `UMI_CREDENTIAL_ISSUED` with the credential id, subject,
issuer, key fingerprint and the SHA-256 of the signed credential. The credential body
itself is not written to the chain: it may name a person, and the chain is append-only
and public. Revocation commits `UMI_CREDENTIAL_REVOKED`.

**Verification** answers four separate questions and never collapses them into one
boolean:

1. Does the signature verify against the issuer's public key?
2. Does the hash of the presented credential match the hash anchored on the chain?
3. Is the credential revoked?
4. Was the issuer authorised to make this statement at issue time?

A credential can be cryptographically valid and still revoked, and a verifier must be able
to see which.

**Authorisation.** Only a Registrar or a supervisor may issue a title credential. Only the
issuer or a supervisor may revoke. Reads are public, because the point of a credential is
that a stranger can check it.

## What this does not claim

The issuer is a demo registrar identity, not a state land-records authority. The
*mechanism* is real cryptography and a real anchor; the *authority* behind the statement is
simulated, exactly like every other regulated surface here. `/trust` and the API response
both say so, and the credential itself carries the disclaimer in its subject.

## Acceptance

- Issue, fetch, verify and revoke over HTTP, with authorisation enforced.
- Tampering with any field of a stored credential fails verification.
- A credential survives a restart, rebuilt from the chain.
- Verification of a revoked credential reports valid signature and revoked status.
- Go tests covering each of the above, plus an integration suite through the proxy.
- No new money rule in JavaScript.
