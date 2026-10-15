package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Regression test for a failure found by running on a real two org network.
//
// RegisterProperty built its asset id with uuid.New() and stamped records with
// time.Now(). Both differ per peer, so the two endorsers returned different
// write sets and the gateway reported:
//
//	ProposalResponsePayloads do not match
//
// The transaction never reached the orderer. Nothing caught it here, because a
// single-peer test executes the chaincode once and any value looks consistent
// with itself.
//
// Non-determinism cannot be detected by running this chaincode once, so this
// test reads the source instead and refuses the constructs that cause it.
// txTime and txID in determinism.go are the sanctioned replacements: both
// derive from the proposal, so every endorser computes the same value.
func TestChaincodeHasNoNonDeterministicSources(t *testing.T) {
	banned := map[string]string{
		"uuid.New()":  "random per peer, use txID(ctx, prefix)",
		"time.Now()":  "local clock, use txTime(ctx)",
		"rand.Int":    "random per peer",
		"rand.Read":   "random per peer",
		"rand.Float":  "random per peer",
		"time.Since(": "local clock",
	}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading package directory: %v", err)
	}

	checked := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || filepath.Ext(name) != ".go" {
			continue
		}
		// The helper file names these constructs in its own documentation,
		// and test files do not run on a peer.
		if name == "determinism.go" || strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		checked++
		for _, line := range strings.Split(string(body), "\n") {
			code := line
			if i := strings.Index(code, "//"); i >= 0 {
				code = code[:i]
			}
			for pattern, why := range banned {
				if strings.Contains(code, pattern) {
					t.Errorf("%s: %s is not deterministic across endorsers (%s)\n    %s",
						name, pattern, why, strings.TrimSpace(line))
				}
			}
		}
	}

	if checked == 0 {
		t.Fatal("no chaincode source files were scanned, the test is not doing anything")
	}
}

// txTime must not silently fall back to the local clock when the proposal
// carries no timestamp. An earlier version did, which made the determinism
// guarantee conditional on something the chaincode cannot see.
func TestTxTimeHasNoLocalClockFallback(t *testing.T) {
	body, err := os.ReadFile("determinism.go")
	if err != nil {
		t.Fatalf("reading determinism.go: %v", err)
	}
	fn := string(body)
	start := strings.Index(fn, "func txTime(")
	if start < 0 {
		t.Fatal("txTime is missing from determinism.go")
	}
	end := strings.Index(fn[start:], "\n}\n")
	if end < 0 {
		t.Fatal("could not find the end of txTime")
	}
	if strings.Contains(fn[start:start+end], "time.Now()") {
		t.Error("txTime falls back to the local clock, which reintroduces divergence")
	}
}
