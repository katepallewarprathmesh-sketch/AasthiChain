//go:build !real

package main

import (
	"errors"

	drunix "github.com/katepallewarprathmesh-sketch/AasthiChain/drunix-gateway"
)

// newRealGateway in default builds: real-network adapter is compile-time gated.
func newRealGateway(mspID string) (drunix.DrunixClient, error) {
	return nil, errors.New("real mode requires build tag: go build -tags real")
}
