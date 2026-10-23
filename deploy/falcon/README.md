# Falcon deployment layer

[Falcon](https://github.com/npci/falcon) is NPCI's Hyperledger Fabric deployment helper for
Kubernetes: templatised Helm charts that stand up certificate authorities, peers, orderers,
channels and the chaincode lifecycle, with SNI-based ingress routing and multi-zone support.
DRUNIX is the runtime; Falcon is how that runtime is deployed and operated.

This directory is the AasthiChain network expressed as Falcon values. It is the production
topology: four member organisations, a three-node Raft ordering service, DRUNIX peer roles split
into Lite Peers, Validation Services and Committing Peers, KeyDB as the transient store and
YugabyteDB as the SQL state database.

## Why we deploy with Falcon rather than hand-rolled manifests

1. **A new member joins without a network rebuild.** Adding a state registrar, a custodian bank or
   an auditor is a values file and a `helm install`, not a redesign. Our growth model is exactly
   this: one state, then the next, then banks and portals as members.
2. **Certificate authority management is the hard part of a real consortium.** Falcon handles Root
   CA, TLS CA and intermediate CAs, identity registration and certificate renewal. For a rail
   where a registrar's signing identity is legally meaningful, CA lifecycle is a product
   requirement, not an operational nicety.
3. **Chaincode lifecycle is governed, not manual.** Install, approve, commit and upgrade run as
   Helm-driven jobs per organisation, so a settlement-logic change requires the approvals the
   endorsement policy demands and leaves an artefact trail.
4. **It is NPCI's own operational tooling.** A rail intended to be run by or alongside NPCI and
   its member banks should be deployable by the tooling those teams already run in production.

## Topology

| Organisation | MSP | Role on the rail | Peers |
| --- | --- | --- | --- |
| OriginatorOrg | OriginatorMSP | Property owners and developers who list and tokenise | 2 Lite, 1 Committing, 2 Validation |
| RegistrarOrg | RegistrarMSP | Title validation, credential issuance, revocation | 2 Lite, 1 Committing, 2 Validation |
| InvestorOrg | InvestorMSP | Custodian for retail and institutional holders | 4 Lite, 2 Committing, 4 Validation |
| RegulatorOrg | RegulatorMSP | Read-heavy supervisory access, no issuance rights | 2 Lite, 1 Committing, 2 Validation |
| OrdererOrg | OrdererMSP | Three-node Raft ordering service | n/a |

Lite Peers scale with read and endorsement load; Committing Peers are the small accountable set
that owns MVCC validation, the YugabyteDB state store and the block store. InvestorOrg carries the
largest Lite Peer count because retail traffic (portfolio reads, order book, settlement
instructions) lands there.

Channel: `property-channel`. Chaincode: `aasthichain` (Go), carrying the property, token, KYC,
DvP, conditional-settlement, credential and mandate contracts.

## Endorsement policies

| Operation | Policy | Why |
| --- | --- | --- |
| Property registration | `OriginatorMSP.peer` | The owner asserts their own listing. |
| Title validation / credential issue | `RegistrarMSP.peer` | Only a registrar may attest title. |
| Token issuance (mint) | `AND('OriginatorMSP.peer','RegistrarMSP.peer')` | Fractions cannot exist without a validated title. |
| DvP settlement, conditional release | `AND('InvestorMSP.peer','OriginatorMSP.peer')` | Both sides of the trade must execute the same result. |
| Supervisory queries | `RegulatorMSP.peer` (read) | Visibility is a role in the network, not a backdoor in the app. |

## Deployment order

`scripts/falcon-up.sh` runs these in sequence; each step is a plain `helm install` against the
Falcon charts, so any step can be run by hand.

1. Filestore (shared artefact store for block files, chaincode packages, collection config)
2. Root CA and TLS CA, with admin credentials supplied as Kubernetes secrets
3. Identity registration jobs for the orderer organisation and each member organisation
4. Orderers (3, Raft)
5. Per organisation: KeyDB transient store, YugabyteDB state store, Committing Peers, Lite Peers,
   Validation Services
6. Channel creation and joins, anchor peers
7. Chaincode lifecycle: package, install on Lite Peers, approve per organisation, commit
8. Private data collection config for the sensitive collections (`consideration`, `valuation`,
   `kycEvidence`)

## Files

| Path | Contents |
| --- | --- |
| `values/filestore.yaml` | Shared artefact store |
| `values/root-ca.yaml`, `values/tls-ca.yaml` | Certificate authorities |
| `values/identities-<org>.yaml` | Identity registration per organisation |
| `values/orderers.yaml` | Three-node Raft ordering service |
| `values/peers-<org>.yaml` | DRUNIX peer roles, KeyDB and YugabyteDB per organisation |
| `values/channel-property.yaml` | `property-channel` creation, joins and anchor peers |
| `values/chaincode-aasthichain.yaml` | Chaincode lifecycle and endorsement policies |
| `values/collections.json` | Private data collections and their member policies |
| `scripts/falcon-up.sh` | The ordered deployment, one command |

Image coordinates and the DRUNIX chart overrides live in `values/global.yaml`; everything else
inherits from it, so moving between a state deployment, a disaster-recovery region and a partner
bank's cluster is one file.
