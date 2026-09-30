package fabric

import (
	"fmt"
	"os"
)

// NewFabricClient factory — toggles via FABRIC_MODE env var per Track A1
// FABRIC_MODE=live -> tries real Fabric Gateway connection, falls back to mock if fails
// FABRIC_MODE=mock (default) -> mock client with seed data

func NewFabricClient() FabricClient {
	mode := os.Getenv("FABRIC_MODE")
	if mode == "" {
		mode = "mock"
	}

	fmt.Printf("AasthiChain Fabric Mode: %s\n", mode)

	switch mode {
	case "live":
		live, err := NewLiveFabricClient()
		if err != nil {
			fmt.Printf("Live client failed to init: %v — falling back to mock (demo resilience)\n", err)
			fmt.Printf("To run live: ensure crypto-config exists and peer is reachable at %s\n", getEnv("FABRIC_PEER_ENDPOINT", "localhost:7051"))
			return NewMockFabricClient()
		}
		fmt.Printf("Live Fabric client connected to channel %s, chaincode %s\n", live.channelName, live.chaincode)
		return live
	case "mock":
		fallthrough
	default:
		fmt.Printf("Using MockFabricClient with seed data — set FABRIC_MODE=live for real network\n")
		return NewMockFabricClient()
	}
}
