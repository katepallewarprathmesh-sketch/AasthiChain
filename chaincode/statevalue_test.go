package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestIndexValueIsValidJSON(t *testing.T) {
	for _, target := range []string{
		"PROP-7e371bbb9095c74b96f63db5ce39f0e2010c1f8ac3c8127fcb1d0dbddcd86e8f",
		"TX-1",
		"",
		`weird"quoted`,
	} {
		encoded := indexValue(target)
		if !json.Valid(encoded) {
			t.Errorf("indexValue(%q) produced %q, which is not valid JSON", target, encoded)
		}
		if got := indexRef(encoded); got != target && target != `weird"quoted` {
			t.Errorf("indexRef(indexValue(%q)) = %q", target, got)
		}
	}
}

// Index entries written before this encoding existed are bare strings.
func TestIndexRefReadsBareStrings(t *testing.T) {
	if got := indexRef([]byte("PROP-abc")); got != "PROP-abc" {
		t.Errorf("indexRef on a bare string returned %q", got)
	}
	if got := indexRef(nil); got != "" {
		t.Errorf("indexRef(nil) returned %q", got)
	}
}

// Regression test for a crash seen on the real Drunix network.
//
// RegisterProperty wrote its hash index entry as PutState(key, []byte(assetID)),
// which is Fabric's usual convention and is fine on LevelDB. Drunix keeps
// world state in a SQL database with a JSON column, so a bare string made the
// committing peer panic while writing the block:
//
//	invalid input syntax for type json (SQLSTATE 22P02)
//	panic: error during commit to txmgr
//
// The block was already ordered, so the peer crashed again on every restart
// as it replayed it, and the network had to be rebuilt. A single bare-string
// index entry is enough to do that, so none are allowed.
func TestNoRawByteStateValues(t *testing.T) {
	// PutState(anything, []byte(...)) with a conversion rather than marshalled
	// JSON. Byte slices that came out of json.Marshal are named, so they do
	// not match.
	raw := regexp.MustCompile(`PutState\([^,]+,\s*\[\]byte\(`)

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading package directory: %v", err)
	}
	checked := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || filepath.Ext(name) != ".go" ||
			name == "statevalue.go" || strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		checked++
		for n, line := range strings.Split(string(body), "\n") {
			code := line
			if i := strings.Index(code, "//"); i >= 0 {
				code = code[:i]
			}
			if raw.MatchString(code) {
				t.Errorf("%s:%d writes a raw byte state value, which is not valid JSON on a SQL state database. Use indexValue.\n    %s",
					name, n+1, strings.TrimSpace(line))
			}
		}
	}
	if checked == 0 {
		t.Fatal("no chaincode source files were scanned, the test is not doing anything")
	}
}
