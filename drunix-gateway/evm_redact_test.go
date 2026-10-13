package drunix

import (
	"os"
	"strings"
	"testing"
)

// A hosted JSON-RPC provider carries its API key inside the URL, and the
// connector description is served publicly by GET /umi/interop. The key must
// never appear there, nor in an error raised when the node is unreachable.
func TestRPCKeyNeverLeavesTheProcess(t *testing.T) {
	const key = "BLEsecretkey123__notreal"
	raw := "https://eth-sepolia.g.alchemy.com/v2/" + key

	os.Setenv("EVM_RPC_URL", raw)
	os.Setenv("EVM_REGISTRY_ADDRESS", "0x1a304c671307d322e7b24cd1004f436b20dece9f")
	defer os.Unsetenv("EVM_RPC_URL")
	defer os.Unsetenv("EVM_REGISTRY_ADDRESS")

	m := OpenEVMMirrorFromEnv()
	if m == nil {
		t.Fatal("mirror should be configured")
	}
	if got := m.SafeEndpoint(); got != "https://eth-sepolia.g.alchemy.com" {
		t.Fatalf("SafeEndpoint = %q", got)
	}
	if d := m.Describe(); strings.Contains(d, key) {
		t.Fatalf("Describe leaks the api key: %s", d)
	}
	conn := &evmConnector{mirror: m, name: "evm"}
	if d := conn.Describe(); strings.Contains(d, key) {
		t.Fatalf("connector Describe leaks the api key: %s", d)
	}
	if got := m.redactRPC("Post \"" + raw + "\": dial tcp: timeout"); strings.Contains(got, key) {
		t.Fatalf("redactRPC leaks the api key: %s", got)
	}
}
