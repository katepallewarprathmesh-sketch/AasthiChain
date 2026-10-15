package main

import (
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Chaincode runs once per endorsing peer and every peer must produce the same
// write set, byte for byte, or the client is told:
//
//	ProposalResponsePayloads do not match
//
// and the transaction never reaches the orderer. Two things in this contract
// broke that rule: identifiers from uuid.New(), which is random per peer, and
// timestamps from time.Now(), which differs by milliseconds between machines.
// Single-peer tests cannot see either one. A two org network sees both
// immediately, and did.
//
// The helpers below are the only sanctioned sources of a timestamp or a
// generated identifier in this chaincode. Both derive from the proposal, so
// every endorser computes the same value.

// txTime is the transaction's own timestamp, set by the client and carried in
// the proposal, so it is identical on every endorser. There is no fallback to
// the local clock: a missing timestamp is an error, because guessing one
// reintroduces exactly the divergence this exists to prevent.
func txTime(ctx contractapi.TransactionContextInterface) (time.Time, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return time.Time{}, fmt.Errorf("transaction timestamp unavailable: %w", err)
	}
	if ts == nil {
		return time.Time{}, fmt.Errorf("transaction timestamp unavailable")
	}
	return time.Unix(ts.Seconds, int64(ts.Nanos)).UTC(), nil
}

// txID builds an identifier from the transaction id, which the client derives
// from its nonce and identity before endorsement and which every peer
// therefore sees as the same string. The suffix separates several identifiers
// created within one transaction, which would otherwise collide.
//
// The transaction id is already unique across the channel, so this inherits
// that property rather than relying on randomness for it.
func txID(ctx contractapi.TransactionContextInterface, prefix string, suffix ...string) string {
	id := prefix + ctx.GetStub().GetTxID()
	for _, s := range suffix {
		id += "-" + s
	}
	return id
}
