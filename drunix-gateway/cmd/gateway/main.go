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
	addr := ":" + envOr("DRUNIX_PORT", "21100")
	log.Printf("AasthiChain Drunix Gateway (Golang) listening on %s — channel %s, chaincode %s",
		addr, drunix.Channel, drunix.ChaincodeName)
	log.Fatal(http.ListenAndServe(addr, srv.Router()))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
