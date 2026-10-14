package main

import (
	"errors"
	"strings"
)

// Minimal stand-in for the stub, for the handful of things these tests use.
//
// fabric-chaincode-go v2 dropped shimtest, and Drunix's own samples are on v2,
// so the choice was staying on a v1 API that Drunix does not use or replacing
// the mock. The tests here only ever needed composite keys, a creator and
// transaction boundaries, so this is the whole dependency, written out.
//
// CreateCompositeKey and SplitCompositeKey follow Fabric's wire format exactly
// (U+0000 namespace, U+0000 between attributes), because the chaincode's key
// layout has to match what a real peer produces.
const compositeKeyNamespace = "\x00"

type testStub struct {
	Creator []byte
	txID    string
}

func newTestStub() *testStub { return &testStub{} }

func (s *testStub) MockTransactionStart(txID string) { s.txID = txID }
func (s *testStub) MockTransactionEnd(string)        { s.txID = "" }
func (s *testStub) GetTxID() string                  { return s.txID }

func (s *testStub) CreateCompositeKey(objectType string, attributes []string) (string, error) {
	if objectType == "" {
		return "", errors.New("object type cannot be an empty string")
	}
	key := compositeKeyNamespace + objectType + string(rune(0))
	for _, a := range attributes {
		if strings.ContainsRune(a, 0) {
			return "", errors.New("attribute must not contain a null character")
		}
		key += a + string(rune(0))
	}
	return key, nil
}

func (s *testStub) SplitCompositeKey(compositeKey string) (string, []string, error) {
	if !strings.HasPrefix(compositeKey, compositeKeyNamespace) {
		return "", nil, errors.New("not a composite key")
	}
	parts := strings.Split(compositeKey[1:], string(rune(0)))
	if len(parts) < 2 {
		return "", nil, errors.New("not a composite key")
	}
	return parts[0], parts[1 : len(parts)-1], nil
}
