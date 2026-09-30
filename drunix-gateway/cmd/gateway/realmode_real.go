//go:build real

package main

import (
	drunix "github.com/katepallewarprathmesh-sketch/AasthiChain/drunix-gateway"
)

// newRealGateway is available only in `-tags real` builds.
func newRealGateway(mspID string) (drunix.DrunixClient, error) {
	return drunix.NewFabricGateway(mspID)
}
