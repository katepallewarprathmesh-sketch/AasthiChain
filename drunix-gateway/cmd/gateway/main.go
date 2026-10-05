// AasthiChain Drunix Gateway — Golang service exposing NPCI Drunix
// transaction lifecycle + AI fraud screening for the hackathon demo.
//
// Run (default deterministic mock network, FAQ 19 local dev):
//
//	go run .            # :21100
//	DRUNIX_PORT=9000 go run .
//
// Build with the real Fabric adapter:
//
//	go build -tags real .
package main

import (
	"log"
	"net/http"
	"os"

	drunix "github.com/katepallewarprathmesh-sketch/AasthiChain/drunix-gateway"
)

func main() {
	var ledger drunix.DrunixClient = drunix.NewMockLedger()
	mode := os.Getenv("DRUNIX_MODE")
	if mode == "real" {
		if g, err := newRealGateway(envOr("DRUNIX_MSP_ID", "InvestorMSP")); err == nil {
			ledger = g
			log.Printf("Drunix mode: REAL (Fabric Gateway adapter, MSP %s)", envOr("DRUNIX_MSP_ID", "InvestorMSP"))
		} else {
			log.Printf("Drunix real init failed (%v) — using deterministic mock network", err)
		}
	} else {
		log.Printf("Drunix mode: mock — deterministic Fabric-fork simulator (set DRUNIX_MODE=real + build tag for live network)")
	}

	srv := drunix.NewServer(ledger)

	// Embedded Drunix pipeline: LP → Orderer(RAFT) → VS(VSCC) → CP(MVCC+commit)
	state := drunix.NewStateDB()
	transient := drunix.NewTransientStore()
	// The block chain is durable when DATABASE_URL is set: blocks are appended
	// to umi_block (append-only — no UPDATE, no DELETE) and replayed at boot,
	// re-verified before the node will extend them. Without a database the
	// chain is in-memory, exactly as before.
	blockStore := drunix.OpenUMIStoreFromEnv()
	var chain *drunix.DrunixChain
	var chainV drunix.ChainVerification
	if blockStore != nil {
		chain, chainV = drunix.NewChainWithStore(blockStore)
	} else {
		chain, chainV = drunix.NewChain(), drunix.ChainVerification{Valid: true}
	}
	if !chainV.Valid {
		log.Printf("WARNING: stored chain failed verification at block %d (%s) — serving read-only", chainV.BrokenAt, chainV.Reason)
	}
	srv.Pipeline = drunix.NewPipeline(state, transient, chain)
	if blockStore != nil {
		defer blockStore.Close()
	}
	// UMI rail — RBI Unified Market Interface pattern (atomic DvP in wholesale
	// CBDC) mounted on the same service. Disable with UMI_ENABLED=false.
	if os.Getenv("UMI_ENABLED") != "false" {
		sec := drunix.NewMemorySecurities()
		srv.UMI = drunix.NewUMIRail(sec, chain)
		// Durable mirror: DATABASE_URL (the project's Neon Postgres) makes rail
		// state survive restarts and free-instance sleeps. Absent/unreachable =>
		// in-memory, exactly as before. UMI_PERSIST=false forces in-memory.
		if blockStore != nil {
			srv.UMI = srv.UMI.WithStore(blockStore)
		}
		// Request-level idempotency for the money-moving POSTs. Durable when
		// a database is present, so a retry after a restart still replays the
		// original response instead of settling twice. Callers that send no
		// Idempotency-Key are unaffected.
		srv.Idem = drunix.NewIdemStore()
		if blockStore != nil {
			srv.Idem = srv.Idem.WithPersister(blockStore)
		}
		log.Printf("UMI idempotency: %s — send Idempotency-Key on POST /umi/dvp to make retries safe", srv.Idem.Mode())
		log.Printf("UMI rail mounted at /umi/* — SEBI Demat 2.0 pattern: Drunix securities leg + e₹-W wholesale CBDC cash leg, atomic DvP (simulation)")
		// Hosted deployments start empty, which makes the demo page look broken.
		// Seed the same positions/wallets the local demo uses (UMI_SEED_DEMO=false to skip).
		// Seeding is skipped when state was restored from the database, so a
		// restart never re-credits wallets (that would break conservation).
		if os.Getenv("UMI_SEED_DEMO") != "false" && srv.UMI.IsEmpty() {
			// via the rail so the seeded position is mirrored to the store too
			_, _ = srv.UMI.SeedPosition(envOr("UMI_SEED_ASSET", "PROP-GREEN-VALLEY-PUNE-001"), envOr("UMI_SEED_OWNER", "originator1"), 15000)
			_, _, _ = srv.UMI.FundWallet("investor1", 100000)
			_, _, _ = srv.UMI.FundWallet("investor2", 50000)
			log.Printf("UMI demo state seeded: 15000 tokens to %s, e₹-W wallets investor1 ₹1,00,000 / investor2 ₹50,000",
				envOr("UMI_SEED_OWNER", "originator1"))
		}
	}
	log.Printf("Drunix pipeline wired: LitePeer + Orderer(3, RAFT sim) + ValidationService + CommittingPeer on hash-chained ledger")
	// PaaS hosts (Render, Railway, Cloud Run, Fly) inject $PORT — honour it,
	// falling back to DRUNIX_PORT and then the local default.
	port := envOr("DRUNIX_PORT", os.Getenv("PORT"))
	addr := ":" + envOr2(port, "21100")
	log.Printf("AasthiChain Drunix Gateway (Golang) listening on %s — channel %s, chaincode %s",
		addr, drunix.Channel, drunix.ChaincodeName)
	log.Fatal(http.ListenAndServe(addr, srv.Router()))
}

// envOr2 returns v, or def when v is empty.
func envOr2(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
