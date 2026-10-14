//go:build real

package drunix

// What can be tested without a Drunix network, and what cannot.
//
// Everything here exercises the parts that decide whether this node will be
// on a real network at all: configuration, enrolment loading, TLS policy and
// the query/submit split. None of it dials anything, so it runs in CI.
//
// What these tests deliberately do NOT claim: that the adapter works against
// a real Drunix peer. That needs an endpoint and an enrolment from the
// network operator, and it is verified by running against one, not here.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func clearDrunixEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"DRUNIX_MSP_ID", "DRUNIX_PEER_ENDPOINT", "DRUNIX_API_HOST", "DRUNIX_API_PORT",
		"DRUNIX_CERT_FILE", "DRUNIX_KEY_FILE", "DRUNIX_TLS_CERT", "DRUNIX_TLS_INSECURE",
		"DRUNIX_TLS_SERVER_NAME", "DRUNIX_CHANNEL", "DRUNIX_CHAINCODE",
	} {
		t.Setenv(k, "")
	}
}

// A node told to be real with nothing configured must refuse, not degrade.
func TestRealModeRefusesWithoutEndpoint(t *testing.T) {
	clearDrunixEnv(t)
	t.Setenv("DRUNIX_MSP_ID", "OriginatorMSP")

	gw, err := NewFabricGateway("OriginatorMSP")
	if err == nil {
		t.Fatalf("expected a refusal with no endpoint configured, got a gateway: %+v", gw)
	}
	if !strings.Contains(err.Error(), "DRUNIX_PEER_ENDPOINT") {
		t.Fatalf("the error should name the missing setting, got: %v", err)
	}
}

func TestRealModeRefusesWithoutEnrolment(t *testing.T) {
	clearDrunixEnv(t)
	t.Setenv("DRUNIX_MSP_ID", "OriginatorMSP")
	t.Setenv("DRUNIX_PEER_ENDPOINT", "peer0.example:7051")

	_, err := NewFabricGateway("OriginatorMSP")
	if err == nil {
		t.Fatal("expected a refusal with no certificate or key")
	}
	if !strings.Contains(err.Error(), "DRUNIX_CERT_FILE") {
		t.Fatalf("the error should name the missing enrolment files, got: %v", err)
	}
}

// The old adapter reported mode "real" while serving simulated answers. This
// is the regression test for that: there is no fallback inside the adapter.
func TestRealAdapterHasNoSimulatorFallback(t *testing.T) {
	src, err := os.ReadFile("fabric_real.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	for _, forbidden := range []string{"MockLedger", "mock-fallback", "fallback *"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("the real adapter must not reach for the simulator, found %q", forbidden)
		}
	}
}

// TLS is the default. Plaintext has to be asked for by name.
func TestTransportRefusesPlaintextByDefault(t *testing.T) {
	clearDrunixEnv(t)
	if _, err := transportCredentials(); err == nil {
		t.Fatal("expected plaintext to be refused without DRUNIX_TLS_INSECURE")
	}

	t.Setenv("DRUNIX_TLS_INSECURE", "true")
	creds, err := transportCredentials()
	if err != nil || creds == nil {
		t.Fatalf("explicit opt-in should be allowed, got %v", err)
	}
}

func TestTransportRejectsUnusableCertificate(t *testing.T) {
	clearDrunixEnv(t)
	dir := t.TempDir()
	bad := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(bad, []byte("this is not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DRUNIX_TLS_CERT", bad)

	if _, err := transportCredentials(); err == nil {
		t.Fatal("a file with no certificate in it must not be accepted as a trust root")
	}
}

// Fabric tooling writes the signing key into a keystore directory; humans
// point at a file. Both work, and an ambiguous keystore is refused rather
// than guessed, because signing with the wrong key fails at endorsement with
// an error that explains nothing.
func TestReadKeyAcceptsFileAndSingleKeystore(t *testing.T) {
	dir := t.TempDir()

	file := filepath.Join(dir, "key.pem")
	if err := os.WriteFile(file, []byte("KEY-A"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readKey(file)
	if err != nil || string(got) != "KEY-A" {
		t.Fatalf("reading a key file: %q, %v", got, err)
	}

	store := filepath.Join(dir, "keystore")
	if err := os.Mkdir(store, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store, "a_sk"), []byte("KEY-B"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = readKey(store)
	if err != nil || string(got) != "KEY-B" {
		t.Fatalf("reading a single-key keystore: %q, %v", got, err)
	}

	if err := os.WriteFile(filepath.Join(store, "b_sk"), []byte("KEY-C"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readKey(store); err == nil {
		t.Fatal("a keystore with two keys is ambiguous and must be refused")
	}
}

func TestReadKeyReportsEmptyKeystore(t *testing.T) {
	store := filepath.Join(t.TempDir(), "keystore")
	if err := os.Mkdir(store, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := readKey(store); err == nil {
		t.Fatal("an empty keystore must be an error, not an empty key")
	}
}

// A query must never be submitted as a transaction: it would consume a block
// and make a read look like a state change in the ledger history.
func TestQueriesAreNeverSubmitted(t *testing.T) {
	for _, fn := range []string{
		"GetPropertyDetails", "GetAllProperties", "GetBalance",
		"GetTransferHistory", "GetWallet", "GetKYCStatus",
	} {
		if !evaluateOnly[fn] {
			t.Errorf("%s is a read and must be evaluate-only", fn)
		}
	}
	for _, fn := range []string{
		"RegisterProperty", "ValidateProperty", "MintPropertyTokens",
		"TransferTokens", "RecordSettlement", "UpdateKYCStatus", "FreezeAsset",
	} {
		if evaluateOnly[fn] {
			t.Errorf("%s changes state and must be submitted, not evaluated", fn)
		}
	}
}

// Older deployments configured host and port separately. Accepting both keeps
// a working configuration working.
func TestLegacyHostAndPortAreStillAccepted(t *testing.T) {
	clearDrunixEnv(t)
	t.Setenv("DRUNIX_MSP_ID", "OriginatorMSP")
	t.Setenv("DRUNIX_API_HOST", "peer0.example")
	t.Setenv("DRUNIX_API_PORT", "7051")

	_, err := NewFabricGateway("OriginatorMSP")
	if err == nil {
		t.Fatal("expected to get past the endpoint check and fail on the enrolment")
	}
	if strings.Contains(err.Error(), "DRUNIX_PEER_ENDPOINT") {
		t.Fatalf("host and port should have satisfied the endpoint requirement, got: %v", err)
	}
}
