#!/usr/bin/env bash
# Rename the Drunix test network's sample MSPs to the ones this chaincode's
# authorisation model uses.
#
#   bash scripts/drunix-business-msps.sh              # apply
#   bash scripts/drunix-business-msps.sh --revert     # put the samples back
#
# Why this exists. The chaincode decides what a caller may do from the MSP ID
# on their signing certificate: RegisterProperty is OriginatorMSP only,
# ValidateProperty and MintPropertyTokens also accept RegistrarMSP, token
# movements accept InvestorMSP. The Drunix test network ships Fabric's sample
# orgs, Org1MSP and Org2MSP, so a write from a correctly configured gateway is
# refused by the chaincode during endorsement:
#
#   chaincode response 500, ERR_UNAUTHORIZED:
#   MSP Org1MSP not authorized, requires one of [OriginatorMSP]
#
# That refusal is the control working. The fix belongs in the network, not in
# requireMSP: this renames org1 to OriginatorMSP and org2 to RegistrarMSP so a
# real identity can perform a real write. Nothing in this repository changes.
#
# The MSP ID is pure configuration, not cryptography, so no certificate is
# reissued. Hostnames, directories and ports stay as they are: only the
# identifier each org presents changes.
#
# Run this with the network DOWN, before `network.sh up`. The channel's
# genesis block carries the MSP IDs, so renaming under a live channel strands
# every peer.

set -euo pipefail

NET="${DRUNIX_NETWORK_DIR:-$HOME/drunix-lab/drunix/drunix-network}"
TN="$NET/test-network"
ORG1_MSP="${DRUNIX_ORG1_MSP:-OriginatorMSP}"
ORG2_MSP="${DRUNIX_ORG2_MSP:-RegistrarMSP}"
REVERT=false
[ "${1:-}" = "--revert" ] && REVERT=true

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$TN" ] || die "no test network at $TN. Run scripts/drunix-testnet.sh first, or set DRUNIX_NETWORK_DIR."

# A rename under a running channel is unrecoverable, so refuse rather than
# explain afterwards.
if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q -f name='^lp1.org1$' 2>/dev/null)" ]; then
  die "the network is running. The MSP IDs are baked into the channel genesis block, so tear it down first:
   cd $TN && ./network.sh down"
fi

# Every file in the network that names an MSP. deployCC.sh is in the list
# because it greps the commit readiness output for the literal string, so a
# rename that misses it makes a working deploy look like a failure.
FILES=(
  "$TN/configtx/configtx.yaml"
  "$TN/compose/compose-test-net.yaml"
  "$TN/scripts/envVar.sh"
  "$TN/scripts/deployCC.sh"
  "$TN/scripts/deployCCAAS.sh"
  "$TN/setOrgEnv.sh"
  "$TN/organizations/ccp-generate.sh"
  "$TN/scripts/ccutils.sh"
)

if $REVERT; then
  say "Restoring the sample MSP names"
  n=0
  for f in "${FILES[@]}"; do
    if [ -f "$f.sample-msp" ]; then
      mv "$f.sample-msp" "$f"; echo "    restored $(basename "$f")"; n=$((n + 1))
    fi
  done
  [ "$n" -gt 0 ] || echo "    nothing to restore"
  echo
  echo "Bring the network back up to pick this up:  cd $TN && ./network.sh up"
  exit 0
fi

say "Renaming Org1MSP to $ORG1_MSP and Org2MSP to $ORG2_MSP"
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "    skipped $(basename "$f") (not in this version)"; continue; }
  # One backup only. A second run must not overwrite the pristine copy with an
  # already-renamed one, or --revert would restore the wrong thing.
  [ -f "$f.sample-msp" ] || cp "$f" "$f.sample-msp"
  before=$(grep -co 'Org[12]MSP' "$f" || true)
  sed -i "s/Org1MSP/$ORG1_MSP/g; s/Org2MSP/$ORG2_MSP/g" "$f"
  echo "    $(basename "$f"): $before reference(s)"
done

# checkCommitReadiness in ccutils.sh reads ORG from $1 and PEER from $2 and
# then shifts by one, so PEER stays in "$@" and is grepped for alongside the
# real expectations. With the sample names that stray pattern is "1", which
# matches "Org1MSP" in the output by accident and hides the bug. Rename the
# orgs and the digit disappears, so every readiness check fails and a correct
# deploy reports INVALID after every retry. Shift by two instead.
CCU="$TN/scripts/ccutils.sh"
if [ -f "$CCU" ] && grep -q "^  shift 1$" "$CCU"; then
  [ -f "$CCU.sample-msp" ] || cp "$CCU" "$CCU.sample-msp"
  sed -i "0,/^  shift 1$/{s/^  shift 1$/  shift 2/}" "$CCU"
  echo "    ccutils.sh: checkCommitReadiness no longer greps for the peer number"
fi

# The connection profiles are generated during `network.sh up` from a shared
# template that interpolates the org number, so they cannot be renamed ahead of
# time. Fix them where they are written instead. This repository's gateway does
# not read them, but anything built on the samples does.
CCP="$TN/organizations/ccp-generate.sh"
if [ -f "$CCP" ] && ! grep -q "business MSP rename" "$CCP"; then
  cat >> "$CCP" <<EOF

# business MSP rename, added by scripts/drunix-business-msps.sh
sed -i 's/Org1MSP/$ORG1_MSP/g' organizations/peerOrganizations/org1.example.com/connection-org1.json \\
                               organizations/peerOrganizations/org1.example.com/connection-org1.yaml 2>/dev/null || true
sed -i 's/Org2MSP/$ORG2_MSP/g' organizations/peerOrganizations/org2.example.com/connection-org2.json \\
                               organizations/peerOrganizations/org2.example.com/connection-org2.yaml 2>/dev/null || true
EOF
  echo "    ccp-generate.sh: connection profiles will be rewritten on generation"
fi

cat <<DONE

Done. Nothing is live yet: the names take effect when the channel is created.

  cd $TN
  ./network.sh down
  ./network.sh up
  ./network.sh createChannel -c mychannel
  ./network.sh deployCC -c mychannel -ccn aasthichain -ccp \$HOME/AasthiChain/chaincode -ccl go

Then point the rail at org1, which is now $ORG1_MSP:

  DRUNIX_MSP_ID=$ORG1_MSP

A write that was refused before should now be endorsed. The identity, the
certificate and the peer are unchanged: only the name the org presents is
different, which is exactly what the chaincode was checking.

Put the samples back with:  bash scripts/drunix-business-msps.sh --revert
DONE
