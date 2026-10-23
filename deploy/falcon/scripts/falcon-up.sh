#!/usr/bin/env bash
# Stand up the AasthiChain network with NPCI Falcon.
#
#   FALCON=/path/to/npci/falcon ./deploy/falcon/scripts/falcon-up.sh
#
# Falcon is a set of Helm charts, so every step below is a plain `helm install`
# you can run by hand. Nothing here is specific to our application: the same
# sequence stands up any DRUNIX network, which is the point of using it.
#
# Prerequisites, per Falcon's own documentation:
#   Kubernetes 1.23+, kubectl 1.25+, Helm 3.10+, an ingress with SNI routing and
#   ssl-passthrough enabled, a wildcard DNS entry for the HLF domain, and a
#   StorageClass with dynamic provisioning.
set -euo pipefail

FALCON="${FALCON:?set FALCON to a checkout of github.com/npci/falcon}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V="$HERE/values"
ORGS=(originator registrar investor regulator)

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "1/8 Filestore (shared artefacts: block files, chaincode packages, collections)"
helm upgrade --install filestore -n filestore "$FALCON/helm-charts/filestore" \
  -f "$V/filestore.yaml" --create-namespace

step "2/8 Certificate authorities"
kubectl create ns orderer --dry-run=client -o yaml | kubectl apply -f -
# Credentials stay out of the values files on purpose.
kubectl -n orderer create secret generic rca-secret \
  --from-literal=user=rca-admin --from-literal=password="${RCA_PASSWORD:?}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n orderer create secret generic tlsca-secret \
  --from-literal=user=tls-admin --from-literal=password="${TLSCA_PASSWORD:?}" \
  --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install root-ca -n orderer "$FALCON/helm-charts/fabric-ca" -f "$V/root-ca.yaml"
helm upgrade --install tls-ca  -n orderer "$FALCON/helm-charts/fabric-ca" -f "$V/tls-ca.yaml"

step "3/8 Identities, one registration job per organisation"
for org in "${ORGS[@]}"; do
  kubectl create ns "$org" --dry-run=client -o yaml | kubectl apply -f -
  helm upgrade --install "$org-identities" -n "$org" "$FALCON/helm-charts/fabric-ops" \
    -f "$V/identities-$org.yaml"
done

step "4/8 Ordering service (3 nodes, Raft, one per zone)"
helm upgrade --install orderers -n orderer "$FALCON/helm-charts/fabric-orderer" \
  -f "$V/global.yaml" -f "$V/orderers.yaml"

step "5/8 DRUNIX peer roles per organisation (KeyDB, YugabyteDB, CP, LP, VS)"
for org in "${ORGS[@]}"; do
  helm upgrade --install "$org-peers" -n "$org" "$FALCON/helm-charts/fabric-peer" \
    -f "$V/global.yaml" -f "$V/peers-$org.yaml"
done

step "6/8 Channel creation, joins and anchor peers"
helm upgrade --install property-channel -n orderer "$FALCON/helm-charts/fabric-ops" \
  -f "$V/global.yaml" -f "$V/channel-property.yaml"

step "7/8 Chaincode lifecycle: package, install, approve, commit"
helm upgrade --install chaincode-aasthichain -n orderer "$FALCON/helm-charts/fabric-ops" \
  -f "$V/global.yaml" -f "$V/chaincode-aasthichain.yaml" \
  --set-file collections="$V/collections.json"

step "8/8 Verify"
echo "Expected: 3 orderers, and per organisation 1-2 committing peers, 2-4 lite peers,"
echo "2-4 validation services, one KeyDB and one YugabyteDB connection."
kubectl get pods -A -l app.kubernetes.io/part-of=aasthichain

cat <<'DONE'

Network up. Point the settlement gateway at it:

  DRUNIX_MODE=real \
  FABRIC_CHANNEL=property-channel \
  FABRIC_CHAINCODE=aasthichain \
  FABRIC_GATEWAY_ENDPOINT=lp1.investor.aasthichain.net:443

Adding a member later (a second state registrar, a custodian bank, an auditor)
is one identities file, one peers file and a channel update. No rebuild.
DONE
