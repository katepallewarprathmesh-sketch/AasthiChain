# Signing keys, and what happens when one goes bad

On 17 October 2026 a researcher reported that the private keys of eight
eMudhra intermediate certificate authorities could be recovered from their
own public certificates. The keys had not been stolen. They had been
generated with too little randomness, and the private values turned out to
be small integers: 4, 56, 66, 115, 155, 156, 230 and 237. Anyone could
compute them in under a second and then issue a certificate for any website
that browsers would accept. They had been published since April 2025.

Three separate failures stack up in that story, and only the first is about
randomness:

1. a key of catastrophically low quality entered service,
2. nothing checked it again for about eighteen months,
3. withdrawing it meant persuading every browser vendor on earth to ship a
   block list, and a root removal that breaks legitimate sites along the way.

## Could it happen here

Honestly: parts of it could, and one part already describes us.

This rail signs credentials, agent passports and attestations with Ed25519.
Before the key register existed, there was no screening of a key before use,
nothing that re-examined it later, and no way to revoke a key at all. A
compromised issuer key would have meant revoking every credential it had
ever signed, one at a time, assuming anybody noticed.

The demo issuer key is derived from a seed published in this repository.
That is the eMudhra situation exactly, with one difference that matters: it
is declared. `GET /umi/keys/posture` says so, credential verification
reports it, and the summary states that such a credential proves integrity
and not authority. A public key presented as if it were secret is the
dangerous case; a public key labelled public is a demo.

## What the register does

`GET /umi/keys`, and the routes beneath it.

**Screens a key before it enters service.** The screen derives the public
keys of every private value a broken generator is likely to emit and refuses
a match: small integers in both byte orders up to 8,192, single repeated
bytes, low-order points, short guessable seeds, and structural degeneracy.
All eight eMudhra values are caught, and they are the fixture the test suite
uses.

**Will not claim more than it can prove.** There is no general test for "was
this generated with enough entropy". A key derived from a passphrase nobody
has guessed yet is indistinguishable from a strong one. Every screening
verdict carries that limitation in writing.

**Requires proof of possession.** Registering a public key means signing a
server-issued nonce with the private half. Without it, anyone could copy a
public key out of the register and claim it.

**Refuses a key already registered to somebody else.** Two holders with one
key is either a copy or a generator repeating itself, and both are the same
failure wearing a different hat.

**Writes everything to the chain,** including refusals and audit runs. A
register that records only its successes cannot be audited. This is the
Certificate Transparency idea, and transparency is the only reason an
outsider could check eMudhra at all.

**Revokes in one act,** effective on the next verification: no block list to
ship, no vendor to wait for. The reason is part of the act, because the
reason decides what happens to past signatures:

| Reason | Effect on signatures already made |
|---|---|
| `KEY_COMPROMISE` | Void. If the private key could be computed, nothing it signed proves who signed it. Credentials must be reissued under a new key. |
| `SUPERSEDED` | Stand. An orderly rotation is not an incident. |
| `RETIRED` | Stand. Withdrawn without suspicion. |

**Re-screens keys already in service,** on demand, with the result written to
the chain whether it finds anything or not. This is the part that addresses
the eighteen months: a weakness class added to the screen tomorrow is applied
to keys registered today by running one audit, rather than by waiting for an
outsider to report it.

## What is still missing

- The screen runs at registration and on audit, not on every verification.
  A scheduled audit is not wired; it is a call somebody has to make.
- Key rotation is modelled as revoke plus register. There is no single
  rotate operation that carries the link between the old key and the new one.
- Hardware-backed keys are not supported. eMudhra's keys were generated on
  certified hardware modules and were still weak, so this would raise the
  floor rather than settle the question.
- The rail's own issuer key is not in the register yet: it is reported by
  `GET /umi/keys/posture` but registering it would need the key ceremony that
  a production deployment has and a demo does not.

## Where to look

- `drunix-gateway/keyregistry.go`: the screen, the register, revocation, audit.
- `drunix-gateway/keyregistry_test.go`: the eight real eMudhra values as a fixture.
- `tests/keyregistry.test.mjs`: the same story end to end over HTTP.
- `GET /umi/keys`, `GET /umi/keys/posture`.
