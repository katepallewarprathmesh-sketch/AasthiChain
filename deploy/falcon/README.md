# Deploying AasthiChain with NPCI Falcon

This directory is the production deployment definition of the AasthiChain
network: four organisations, a three-node ordering service, and the three
DRUNIX peer roles, expressed as values for the Helm charts NPCI publishes at
[`github.com/npci/falcon`](https://github.com/npci/falcon).

Falcon and DRUNIX answer different questions, and it is worth being precise
about which is which:

| | what it is | where it shows up here |
|---|---|---|
| **DRUNIX** | the ledger runtime: the Lite Peer / Committing Peer / Validation Service split that lets endorsement and validation scale independently | the images and the `CORE_PEER_*` environment in every values file |
| **Falcon** | the orchestration layer: Helm charts that register identities, raise CAs, create the channel and drive the chaincode lifecycle on Kubernetes | every chart named in `scripts/falcon-up.sh` |

The gateway in `drunix-gateway/` speaks to the network this directory builds.
Nothing in the application changes between a local run and this deployment;
only the endpoints do.

## What gets deployed

Four organisations, each a separate Kubernetes namespace with its own
intermediate CA, so no member can mint another member's identities:

| organisation | MSP | role in the market | LP / CP / VS |
|---|---|---|---|
| `originator` | `OriginatorMSP` | the property owner who brings the asset | 2 / 1 / 2 |
| `registrar` | `RegistrarMSP` | title validation; consortium administrator | 2 / 1 / 2 |
| `investor` | `InvestorMSP` | the fractional holders, and the heaviest read path | 4 / 2 / 4 |
| `regulator` | `RegulatorMSP` | supervisory visibility, no trading position | 2 / 1 / 2 |

Plus an `orderer` namespace holding the root CA, the TLS CA, its own
intermediate CA and three Raft orderers spread across zones with
`podAntiAffinity`, and a `data` namespace holding YugabyteDB.

Why the registrar administers the channel: it is the only member with a
statutory role and no economic position in any listing, so giving it the
consortium seat does not hand a trading party control of membership.

### The three DRUNIX roles

- **Lite peers** (`lp<N>-<org>`, port 7051) endorse. They are stateless, hold
  no ledger, and forward commit status to a named committing peer.
- **Committing peers** (`cp<N>-<org>`, port 7061) run MVCC and commit, and
  delegate validation out of process to the validation service.
- **Validation services** (`vs<N>-<org>`, port 7071) validate. They hold no
  state, so they are the part that autoscales, to 3× on 70% CPU.

Each organisation gets one KeyDB (`hlf-keydb-<org>`) as the transient store for
private data, and a dedicated database and user on YugabyteDB
(`<org>_state` / `<org>_peer`, `sslmode=verify-full`). Private data never
leaves the organisation that is entitled to it, and no organisation can read
another's transient store even by accident, because the address is not
reachable from its namespace.

Falcon publishes a `fabric-peer` chart but no chart for the validation service,
because that role is particular to DRUNIX. `charts/drunix-validation/` is ours:
a deployment, a service, an HPA and a pod disruption budget. The budget matters
more than it looks: validation sits directly on the commit path, so a rolling
node drain that took every replica at once would stall commits network-wide.

## Layout

```
generate.py                 the single source of truth: one ORGS list -> 47 values files
values/
  filestore/                the shared artefact store every member reads from
  fabric-ca/                root CA, TLS CA, and one intermediate CA per organisation
  fabric-ops/<org>/         identities, channel, anchor peers, chaincode lifecycle
  fabric-orderer/           three Raft orderers, 500ms batch timeout
  fabric-peer/<org>/        lite peers and committing peers
  drunix/                   KeyDB per organisation, validation services, YugabyteDB
files/collection-config.json   the three private data collections
charts/drunix-validation/   our chart for the role Falcon does not ship
scripts/falcon-up.sh        the nine steps, in order
secrets.env.example         every credential the tree expects, with no values
```

### The values are generated, not written

Forty-seven values files that repeat the same domain, the same channel name and
the same image tags are forty-seven chances for one of them to drift. So none
of them are hand-edited:

```sh
python3 deploy/falcon/generate.py
```

Change `ORGS` or a constant at the top of that file, re-run it, and every
affected file is rewritten consistently. The script also hashes
`files/collection-config.json` and substitutes that hash into all five values
files that reference it (see below). Every generated file carries a header
saying so, and the test suite asserts that header is present, an edit by hand
would be silently reverted on the next run, so the check is there to stop one
happening.

### Privacy, and the hash that enforces it

Three private data collections:

| collection | who can read | endorsed by |
|---|---|---|
| `consideration` | originator, investor, regulator | originator **and** investor |
| `valuation` | originator, registrar, regulator | registrar |
| `kycEvidence` | investor, regulator | investor |

All three are `memberOnlyRead` and `memberOnlyWrite`, and `blockToLive: 0`, so
nothing expires out from under an audit. The price a buyer paid is visible to
the two parties and the supervisor, and to nobody else on the channel; KYC
evidence is not visible to the seller at all.

Fabric enforces this with a hash. Every organisation's
`approve-chaincode.yaml` carries `collection_config_file_hash`, and the commit
only succeeds if every member approved the *same* bytes:

```
810adef85e4b3ecdaeb2103ca4d20e801e368b200373d1517c3faf348424747f
```

That is a sha256 of the committed `files/collection-config.json`, and
`tests/falcon.test.mjs` recomputes it. A member who quietly widened a
collection in their own copy would fail to commit, and the test fails before
anyone gets that far.

## Chaincode

`aasthichain` v1.0, sequence 1, on channel `property-channel`, endorsed by:

```
AND('OriginatorMSP.peer','RegistrarMSP.peer')
```

That is the business rule stated as a policy: fractions of a property cannot
exist unless both the owner and the registrar sign, so an owner cannot issue
tokens against a title the registrar has not validated.

## Running it

Prerequisites, from Falcon's own documentation: Kubernetes 1.23+, kubectl
1.25+, Helm 3.10+, an ingress controller with SNI routing and ssl-passthrough,
a wildcard DNS record for the HLF domain (`aasthichain.net`, NodePort 30000 for
CA/peer/orderer traffic and 30001 for the filestore), and a StorageClass with
dynamic provisioning.

```sh
cp deploy/falcon/secrets.env.example deploy/falcon/secrets.env
# fill in every value, e.g. with: openssl rand -base64 24
FALCON=/path/to/npci/falcon ./deploy/falcon/scripts/falcon-up.sh
```

The script is nine `helm upgrade --install` steps and nothing else, in the only
order that works: filestore, root and TLS CAs, an intermediate CA per
organisation, identity registration, the ordering service, the data layer and
the peers, channel creation and anchor peers, chaincode install and approval,
and finally the commit. Run them by hand if you prefer; the script exists to
record the order, not to hide it.

**No secret is committed to this repository.** Every `identity_secret` in the
values tree is a `${PLACEHOLDER}` substituted at deploy time by `envsubst`,
from a `secrets.env` that git ignores. The test suite fails the build if a
literal ever appears, and if a placeholder exists that `secrets.env.example`
does not declare. An undocumented credential is how a deployment gets stuck at
step four.

## Verifying it without a cluster

```sh
node tests/falcon.test.mjs
```

A deployment definition fails quietly: an anchor peer pointing at a host that
was renamed, chaincode installed on a peer that does not endorse, one
organisation approving a different privacy policy from the others. None of that
surfaces until a cluster exists. The suite reads the committed files and checks
the claims that must hold first: that every identity a chart uses was
registered with a CA, that every anchor peer names a peer that is actually
deployed, that all five lifecycle files agree on name, version, sequence,
endorsement policy and collection hash, that lite peers are not configured as
committing peers, that every values file the script installs exists and every
file in the tree is installed by it, and that nothing secret is in git.
