# Private data collections

Settlement needs two things that pull in opposite directions. Everyone on the
network has to agree on what happened, and some of what happened is nobody
else's business. A participant's identity evidence and the price a bilateral
trade was struck at are both facts the ledger has to be able to prove, and
neither is a fact the rest of the network is entitled to read.

Hyperledger Fabric answers this with private data collections, and that is the
pattern implemented here.

## How it works

A collection is a named side database with a membership policy. Members hold
the value. Every peer, member or not, holds the hash of the key and the hash
of the value on the public ledger. So the network can prove a record exists,
prove it has not changed since it was committed, and order it against every
other transaction, while the contents stay with the organisations entitled to
them.

On this rail:

- Collection definitions are public, served at `GET /umi/private/collections`.
  Fabric puts the collection config on the public ledger for the same reason:
  a policy nobody can read is not a policy anyone can check.
- A write commits a `UMI_PDC_WRITE` block carrying the collection name, the
  key hash, the value hash and the member roles. Nothing derived from the
  value except its hash. The key is hashed too, because here the key is a
  participant id, which is personal data in its own right.
- A read by a member returns the value. A read by anyone else returns `403`
  **and the proof**. That is the mechanism working, not a leak: refusing the
  value while publishing the hash is the entire point.
- Anyone can verify a value they already hold:
  `POST /umi/private/{collection}/{key}/verify`. The hash is the SHA-256 of
  the value serialised as JSON with sorted keys, so a counterparty can compute
  it themselves without this code.
- `blockToLive` purges the value and keeps the proof, which is how an
  append-only ledger lives with a retention limit.

## The collections

| Collection | Members | Also readable by | Retention |
|---|---|---|---|
| `kycEvidence` | registrar, regulator, admin | the subject of the record | kept |
| `settlementTerms` | regulator, admin | the named counterparties | purged after 500 blocks |

Writing is always a member act. Being the person a KYC record is about does
not make you the registrar who attests it, so a subject can read their own
record and cannot write it.

## What this generalises

The rail already had one instance of this idea: KYC evidence anchored by
digest only in the document register, where the bytes are never stored and no
code path can serve them. That works, but it is a single hard-coded case
expressed as scattered checks on a document type. A collection states the same
rule as data, applies it to anything, and makes the policy inspectable over
HTTP.

## What is real and what is not

Real: the policy, the hashes on the chain, the refusal path, independent
verification, the `blockToLive` purge and the ledger evidence for both the
write and the purge.

Not real: the distribution. Fabric gossips private data only between
authorised peers, so a value never reaches a non-member's disk at all. This
rail is a single process, so membership is enforced in code rather than by the
value never arriving. Nothing here should be read as a claim that an operator
with the process memory cannot see a value. Running the rail as real Fabric
peers, one per organisation, with these collections declared in the chaincode
collection config, is what would close that gap.

## Restart behaviour

A restart replays the `UMI_PDC_WRITE` blocks, so the proofs come back and
verification keeps working. The values do not come back, because they were
never on the chain. A recovered record reports `valueAvailable: false` with a
note saying why, rather than looking like an empty record. That is the
mechanism being honest about itself: if a restart could restore the values
from the chain, the values would have been on the chain.

## Try it

```bash
# the policy, public
curl -s localhost:21100/umi/private/collections

# as the subject: the value
curl -s -H 'X-Identity-Id: investor1' -H 'X-Identity-Role: Investor' \
  localhost:21100/umi/private/kycEvidence/investor1

# as anybody else: refused, with the proof
curl -s -H 'X-Identity-Id: investor2' -H 'X-Identity-Role: Investor' \
  localhost:21100/umi/private/kycEvidence/investor1

# verify a copy you hold, no membership needed
curl -s -X POST localhost:21100/umi/private/kycEvidence/investor1/verify \
  -d '{"value":{"documentType":"AADHAAR","holderName":"Asha Kulkarni","idLastFour":"4417","verifiedBy":"registrar1","simulated":true}}'

# and confirm the data is not in the ledger
curl -s 'localhost:21100/drunix/chain?limit=500' | grep -c 'Asha Kulkarni'
```
