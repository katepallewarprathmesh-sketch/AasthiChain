.PHONY: help counts dev stop test test-fresh test-go test-all smoke secret-scan build umi frontend api chaincode-test umi-test network clean demo

# Default target: say what is available rather than doing something surprising.
help:
	@echo "AasthiChain"
	@echo
	@echo "  make dev          install, build and start the whole stack (app :8080, rail :21100)"
	@echo "  make stop         stop whatever 'make dev' started"
	@echo "  make test         integration sweep against a running stack (regression.sh)"
	@echo "  make test-fresh   restart the stack first, then the sweep (use for a repeat run)"
	@echo "  make test-go      every Go module: gofmt, vet, race tests"
	@echo "  make test-all     dev, then both of the above"
	@echo "  make smoke        build the frontend and render every route"
	@echo "  make secret-scan  refuse tracked files that look like live credentials"
	@echo "  make counts       report (and with FIX=1 repair) the published test census"
	@echo
	@echo "  make umi          run the settlement rail alone, in the foreground"
	@echo "  make frontend     run Vite with hot reload on :5173"
	@echo "  make build        build the frontend bundle and the rail binary"
	@echo
	@echo "Prerequisites: Go 1.25+, Node 20+, python3. Docker is needed only for"
	@echo "'make network', the optional Hyperledger Fabric sandbox."

# ---------------------------------------------------------------------------
# The one path a new contributor should need.
# ---------------------------------------------------------------------------

dev:
	bash scripts/devup.sh
	bash scripts/dev-stack.sh --no-evm

stop:
	bash scripts/dev-stack.sh --stop

# ---------------------------------------------------------------------------
# Verification. Each target says exactly what it covers, because a target
# called "test" that quietly runs a quarter of the tests is worse than none.
# ---------------------------------------------------------------------------

# Needs a running stack: start it with `make dev` first.
test:
	bash regression.sh

# The suite is not idempotent across runs on one stack, and that is the fraud
# engine doing its job: the demo payer's earlier payments are real history and
# a repeat burst inside ten minutes is blocked. Restarting the processes is not
# enough, because the dev store is the file-backed one under /tmp, so the
# payments outlive the server. This clears that store too, which is the reset
# procedure the docs describe, in one command.
test-fresh:
	bash scripts/dev-stack.sh --stop
	rm -f /tmp/aasthi_*.json
	bash scripts/devup.sh
	bash scripts/dev-stack.sh --no-evm
	bash regression.sh

test-go:
	bash scripts/go-tests.sh

test-all: dev test test-go

smoke:
	cd frontend && npm run smoke

secret-scan:
	bash scripts/secret-scan.sh

# The suite and Go file counts are counted from the repository. The total
# check count is the result of a run, so it is only changed when you pass one:
#   make counts                     report drift
#   make counts FIX=1               repair the counted figures
#   make counts FIX=1 CHECKS=148    also publish a check total you just measured
counts:
	node scripts/doc-counts.mjs $(if $(FIX),--fix) $(if $(CHECKS),--checks $(CHECKS))

# ---------------------------------------------------------------------------
# Individual pieces
# ---------------------------------------------------------------------------

build:
	cd frontend && npm install && npm run build
	cd drunix-gateway && go build ./...

umi:
	cd drunix-gateway && UMI_ENABLED=true UMI_SEED_DEMO=true DRUNIX_MODE=mock go run ./cmd/gateway

frontend:
	cd frontend && npm install && npm run dev

api:
	cd api-gateway && go mod tidy && go run main.go

chaincode-test:
	cd chaincode && go test -v ./...

umi-test:
	cd drunix-gateway && go vet ./... && go test -race -count=1 ./...

# ---------------------------------------------------------------------------
# Optional Hyperledger Fabric sandbox. Requires Docker and the Fabric
# binaries, and is not needed for the demo or for any test above.
# ---------------------------------------------------------------------------

network:
	cd network && docker compose up -d
	@echo "Network started. Waiting for postgres health..."
	sleep 5
	cd network && ./scripts/create-channel.sh
	cd network && ./scripts/deploy-chaincode.sh

# Destructive: removes the Fabric volumes and generated crypto material.
# It does not touch demo data used by the Node stack.
clean:
	cd network && docker compose down -v
	rm -rf network/crypto-config network/channel-artifacts

demo:
	@echo "=== AasthiChain demo ==="
	@echo "App       : http://localhost:8080"
	@echo "Rail      : http://localhost:21100/health"
	@echo "Vite dev  : http://localhost:5173  (make frontend)"
	@echo "Identities: originator1, registrar1, investor1, investor2, regulator1"
	@echo "Walkthrough: docs/DEMO.md"
