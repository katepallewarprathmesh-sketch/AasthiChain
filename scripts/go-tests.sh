#!/usr/bin/env bash
# Every Go module in the repository, one after another.
#
# There is no single module graph here: chaincode, api-gateway,
# drunix-gateway and payment-gateway are four independent modules, so
# `go test ./...` from the root cannot work and never did. CI runs them as a
# matrix; this is the same thing locally, in one command.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

MODULES=(chaincode api-gateway drunix-gateway payment-gateway)
FAILED=()

for m in "${MODULES[@]}"; do
  echo "== $m"
  unformatted="$(cd "$m" && gofmt -l .)"
  if [[ -n "$unformatted" ]]; then
    echo "   gofmt would change:"
    echo "$unformatted" | sed 's/^/     /'
    FAILED+=("$m (gofmt)")
  fi
  if ! (cd "$m" && go vet ./... && go test -race -count=1 ./...); then
    FAILED+=("$m (test)")
  fi
done

echo
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED: ${FAILED[*]}"
  exit 1
fi
echo "All Go modules formatted, vetted and passing."
