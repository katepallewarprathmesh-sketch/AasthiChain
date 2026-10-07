package drunix

// Build identity and a capability list for the running binary.
//
// Why this exists: the deployed rail and the repo drifted apart silently. The
// only way to tell which commit was live was to probe routes one by one and
// infer the answer from which ones 404'd. That is a slow, error-prone guess.
//
// So the binary reports who it is. Commit is injected at build time (-ldflags)
// or picked up from the host's git environment variable, and `features` lists
// the route families this build actually serves. An operator can now diff what
// is deployed against what is expected in a single request, and the same facts
// are exported to /metrics so a dashboard can alarm on a stale deploy.

import (
	"os"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
)

// BuildCommit is overridable at link time:
//
//	go build -ldflags "-X github.com/.../drunix-gateway.BuildCommit=$(git rev-parse --short HEAD)"
//
// Left empty, the value is recovered from the host environment or the Go build
// info, so an un-flagged build still reports something useful.
var BuildCommit = ""

var (
	buildOnce sync.Once
	buildID   buildInfo
)

type buildInfo struct {
	Commit   string   `json:"commit"`
	Source   string   `json:"commitSource"`
	Go       string   `json:"go"`
	Features []string `json:"features"`
}

// hostCommitEnv lists the environment variables PaaS hosts set to the deployed
// commit. Render and Vercel both provide one; GIT_COMMIT is the generic escape
// hatch for Docker builds and CI.
var hostCommitEnv = []string{"RENDER_GIT_COMMIT", "GIT_COMMIT", "SOURCE_COMMIT", "VERCEL_GIT_COMMIT_SHA"}

// railFeatures names the capabilities this build serves. Each entry maps to a
// route family that either exists or does not — no version arithmetic needed on
// the client side. Keep it short: these are deploy-visible capabilities, not an
// endpoint directory (that is what / is for).
func railFeatures() []string {
	return []string{
		"dvp",           // atomic delivery-versus-payment settlement
		"wallets",       // e₹-W wholesale CBDC wallets and funding
		"isin",          // pilot ISIN assignment
		"servicing",     // coupon/rental distribution
		"baskets",       // multi-asset basket subscribe/redeem
		"ownership",     // ownership history and time-weighted share
		"income",        // per-investor income
		"idempotency",   // Idempotency-Key replay protection
		"events",        // server-sent live block stream
		"offers",        // secondary market order book
		"notifications", // per-participant notification feed
		"metrics",       // Prometheus exposition
		"analytics",     // derived performance and risk
		"documents",     // IPFS-addressed, chain-anchored document register
	}
}

// shortCommit trims a full 40-character SHA to the usual display length,
// leaving anything shorter (or a tag name) untouched.
func shortCommit(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

// currentBuild resolves build identity once and caches it.
func currentBuild() buildInfo {
	buildOnce.Do(func() {
		commit, source := BuildCommit, "ldflags"
		if commit == "" {
			for _, k := range hostCommitEnv {
				if v := os.Getenv(k); strings.TrimSpace(v) != "" {
					commit, source = v, k
					break
				}
			}
		}
		if commit == "" {
			// Set when the module is built from a checkout with VCS info.
			if bi, ok := debug.ReadBuildInfo(); ok {
				for _, s := range bi.Settings {
					if s.Key == "vcs.revision" && s.Value != "" {
						commit, source = s.Value, "buildinfo"
						break
					}
				}
			}
		}
		if commit == "" {
			commit, source = "unknown", "none"
		}
		buildID = buildInfo{
			Commit:   shortCommit(commit),
			Source:   source,
			Go:       runtime.Version(),
			Features: railFeatures(),
		}
	})
	return buildID
}
