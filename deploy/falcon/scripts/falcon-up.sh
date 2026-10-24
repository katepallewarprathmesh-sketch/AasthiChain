#!/usr/bin/env bash
# Stand up the AasthiChain network on Kubernetes with NPCI Falcon.
#
#   FALCON=/path/to/npci/falcon SECRETS=deploy/falcon/secrets.env \
#     ./deploy/falcon/scripts/falcon-up.sh
#
# Falcon is a set of Helm charts, so every step below is a plain `helm upgrade
# --install` you can run by hand, in this order. Nothing here is specific to
# AasthiChain except the values files, which is the point: the same sequence
# stands up any DRUNIX network.
#
# Prerequisites, from Falcon's own documentation: Kubernetes 1.23+, kubectl
# 1.25+, Helm 3.10+, an ingress with SNI routing and ssl-passthrough enabled, a
# wildcard DNS record for the HLF domain, and a StorageClass with dynamic
# provisioning.
#
# Secrets are never committed. Every identity secret in the values files is a
# ${PLACEHOLDER} rendered at deploy time from SECRETS (see secrets.env.example).
set -euo pipefail

FALCON="${FALCON:?set FALCON to a checkout of github.com/npci/falcon}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="${SECRETS:-$HERE/secrets.env}"
V="$HERE/values"
ORGS=(originator registrar investor regulator)
DOMAIN=aasthichain.net

[ -f "$SECRETS" ] || { echo "no secrets file at $SECRETS (copy secrets.env.example)" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$SECRETS"; set +a

RENDER="$(mktemp -d)"
trap 'rm -rf "$RENDER"' EXIT
render() { # render <values-file> -> path to a file with secrets substituted
  local out="$RENDER/$(echo "${1#"$V/"}" | tr '/' '_')"
  mkdir -p "$(dirname "$out")"
  envsubst < "$1" > "$out"
  echo "$out"
}
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "1/9 Filestore: the shared artefact store every organisation reads from"
helm upgrade --install filestore -n filestore "$FALCON/helm-charts/filestore" \
  -f "$(render "$V/filestore/values.yaml")" --create-namespace

step "2/9 Root CA and TLS CA"
kubectl create ns orderer --dry-run=client -o yaml | kubectl apply -f -
kubectl -n orderer create secret generic rca-secret \
  --from-literal=user=rca-admin --from-literal=password="${RCA_PASSWORD:?}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n orderer create secret generic tlsca-secret \
  --from-literal=user=tls-admin --from-literal=password="${TLSCA_PASSWORD:?}" \
  --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install root-ca -n orderer "$FALCON/helm-charts/fabric-ca" -f "$(render "$V/fabric-ca/root-ca.yaml")"
helm upgrade --install tls-ca  -n orderer "$FALCON/helm-charts/fabric-ca" -f "$(render "$V/fabric-ca/tls-ca.yaml")"
helm upgrade --install rootca-ops -n orderer "$FALCON/helm-charts/fabric-ops" \
  -f "$(render "$V/fabric-ops/rootca/rootca-identities.yaml")"
helm upgrade --install tlsca-ops  -n orderer "$FALCON/helm-charts/fabric-ops" \
  -f "$(render "$V/fabric-ops/tlsca/tlsca-identities.yaml")"

step "3/9 An intermediate CA per organisation: nobody mints another member's identities"
for org in orderer "${ORGS[@]}"; do
  kubectl create ns "$org" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "$org" create secret generic "$org-ca-secret" \
    --from-literal=user="$org-ca-admin" --from-literal=password="$(eval echo "\${${org^^}_CA_PASSWORD:?}")" \
    --dry-run=client -o yaml | kubectl apply -f -
  helm upgrade --install "ica-$org" -n "$org" "$FALCON/helm-charts/fabric-ca" \
    -f "$(render "$V/fabric-ca/ica-$org.yaml")"
done

step "4/9 Identity registration"
helm upgrade --install orderer-identities -n orderer "$FALCON/helm-charts/fabric-ops" \
  -f "$(render "$V/fabric-ops/orderer/orderer-identities.yaml")"
for org in "${ORGS[@]}"; do
  helm upgrade --install "$org-identities" -n "$org" "$FALCON/helm-charts/fabric-ops" \
    -f "$(render "$V/fabric-ops/$org/identities.yaml")"
done

step "5/9 Ordering service: three Raft nodes, one per zone"
helm upgrade --install orderers -n orderer "$FALCON/helm-charts/fabric-orderer" \
  -f "$(render "$V/fabric-orderer/orderer.yaml")"

step "6/9 Per organisation: transient store, state database, and the three DRUNIX peer roles"
helm repo add yugabytedb https://charts.yugabyte.com >/dev/null 2>&1 || true
helm upgrade --install yugabyte -n yugabyte yugabytedb/yugabyte \
  -f "$(render "$V/drunix/yugabyte.yaml")" --create-namespace
for org in "${ORGS[@]}"; do
  helm repo add enapter https://enapter.github.io/charts >/dev/null 2>&1 || true
  helm upgrade --install "keydb-$org" -n "$org" enapter/keydb \
    -f "$(render "$V/drunix/keydb-$org.yaml")"
  # Lite Peers: endorsement and queries, no ledger.
  helm upgrade --install "$org-lp" -n "$org" "$FALCON/helm-charts/fabric-peer" \
    -f "$(render "$V/fabric-peer/$org/lite-peers.yaml")"
  # Committing Peers: MVCC validation, commit, state.
  helm upgrade --install "$org-cp" -n "$org" "$FALCON/helm-charts/fabric-peer" \
    -f "$(render "$V/fabric-peer/$org/committing-peers.yaml")"
  # Validation Services: stateless, autoscaled (chart lives in this repo).
  helm upgrade --install "$org-vs" -n "$org" "$HERE/charts/drunix-validation" \
    -f "$(render "$V/drunix/validation-$org.yaml")"
done

step "7/9 Channel: create, join, anchor peers"
helm upgrade --install channel-create -n registrar "$FALCON/helm-charts/fabric-ops" \
  -f "$(render "$V/fabric-ops/registrar/channel-create.yaml")"
for org in "${ORGS[@]}"; do
  helm upgrade --install "$org-anchor" -n "$org" "$FALCON/helm-charts/fabric-ops" \
    -f "$(render "$V/fabric-ops/$org/update-anchor-peer.yaml")"
done

step "8/9 Chaincode lifecycle: install, approve by every member, commit once"
# Falcon verifies the collection config against the hash in the values files,
# so every organisation provably approves the same privacy policy.
curl -fsS -T "$HERE/files/collection-config.json" \
  "http://filestore.$DOMAIN:30001/collection-config.json"
for org in "${ORGS[@]}"; do
  helm upgrade --install "$org-cc-install" -n "$org" "$FALCON/helm-charts/fabric-ops" \
    -f "$(render "$V/fabric-ops/$org/install-chaincode.yaml")"
done
: "${CC_PACKAGE_ID:?set CC_PACKAGE_ID from the install job output before approving}"
for org in "${ORGS[@]}"; do
  helm upgrade --install "$org-cc-approve" -n "$org" "$FALCON/helm-charts/fabric-ops" \
    -f "$(render "$V/fabric-ops/$org/approve-chaincode.yaml")"
done
helm upgrade --install cc-commit -n registrar "$FALCON/helm-charts/fabric-ops" \
  -f "$(render "$V/fabric-ops/registrar/commit-chaincode.yaml")"

step "9/9 Verify"
kubectl get pods -A -l app.kubernetes.io/part-of=aasthichain

cat <<'DONE'

Network up. Point the settlement gateway at it:

  DRUNIX_MODE=real \
  FABRIC_CHANNEL=property-channel \
  FABRIC_CHAINCODE=aasthichain \
  FABRIC_GATEWAY_ENDPOINT=lp1-investor.aasthichain.net:30000

Adding a member later (the next state's registrar, a custodian bank, an
auditor) is one block in deploy/falcon/generate.py and a channel update. No
rebuild, no downtime for the existing members.
DONE
