package drunix

// A PinStore backed by a real IPFS node.
//
// The in-process store is enough for the demo, but it has the property that
// makes a demo a demo: the bytes die with the process. This talks to a Kubo
// node's HTTP API (or any service that speaks it — Pinata and web3.storage
// both expose a compatible /api/v0/add), so documents survive a restart and
// become fetchable from the public network by anyone holding the CID.
//
// Enabled by setting IPFS_API_URL. Absent, nothing changes.
//
// Two decisions worth stating:
//
//  1. THE NODE IS NOT TRUSTED. Whatever a remote node reports as the CID is
//     ignored; we compute the CID ourselves and compare. If a node returns a
//     different hash than the bytes imply, the pin is treated as failed
//     rather than silently recorded under a name the document does not have.
//     This is also a correctness check on our own CID implementation, run
//     against a real node every time a document is pinned.
//
//  2. A PIN FAILURE IS NOT A DOCUMENT FAILURE. The anchor — the CID, the
//     digest, the ledger block — is what proves the document. Storage is a
//     convenience on top. If IPFS is down, the register still records the
//     evidence and simply reports that the bytes are not retrievable here.
//     Losing the proof because a storage daemon restarted would be the worse
//     failure by a wide margin.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"time"
)

// ipfsPinStore pins to a node speaking the Kubo HTTP API.
type ipfsPinStore struct {
	apiURL   string
	gateway  string
	client   *http.Client
	fallback PinStore // keeps the demo working when the node is unreachable
}

// NewIPFSPinStore builds a pin store for a Kubo-compatible endpoint, e.g.
// http://127.0.0.1:5001. fallback may be nil.
func NewIPFSPinStore(apiURL, gateway string, fallback PinStore) PinStore {
	if fallback == nil {
		fallback = NewMemoryPinStore()
	}
	return &ipfsPinStore{
		apiURL:   strings.TrimSuffix(strings.TrimSpace(apiURL), "/"),
		gateway:  strings.TrimSuffix(strings.TrimSpace(gateway), "/"),
		client:   &http.Client{Timeout: 15 * time.Second},
		fallback: fallback,
	}
}

// OpenPinStoreFromEnv returns an IPFS-backed store when IPFS_API_URL is set,
// and the in-process store otherwise. Mirrors how the rail already treats
// DATABASE_URL: opt in, degrade quietly, never fail to start.
func OpenPinStoreFromEnv() PinStore {
	api := strings.TrimSpace(os.Getenv("IPFS_API_URL"))
	mem := NewMemoryPinStore()
	if api == "" {
		log.Printf("Document storage: in-process — set IPFS_API_URL to pin documents to an IPFS node")
		return mem
	}
	gw := strings.TrimSpace(os.Getenv("IPFS_GATEWAY_URL"))
	log.Printf("Document storage: IPFS node at %s (in-process fallback if unreachable)", api)
	return NewIPFSPinStore(api, gw, mem)
}

func (p *ipfsPinStore) Name() string {
	return "IPFS node " + p.apiURL + " (with in-process fallback)"
}

// addResponse is the subset of Kubo's /api/v0/add reply we read.
type addResponse struct {
	Name string `json:"Name"`
	Hash string `json:"Hash"`
	Size string `json:"Size"`
}

// Pin uploads the bytes and verifies the node agrees about the name.
func (p *ipfsPinStore) Pin(cid string, content []byte) error {
	// Always keep a local copy first: the fallback is what makes a node
	// outage invisible to a reader.
	_ = p.fallback.Pin(cid, content)

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", cid)
	if err != nil {
		return err
	}
	if _, err := part.Write(content); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}

	// cid-version=1 and raw-leaves=true are not optional: they are the
	// settings our CID computation matches. Any other setting would produce a
	// different name for the same bytes.
	url := p.apiURL + "/api/v0/add?cid-version=1&raw-leaves=true&pin=true"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("ipfs add: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ipfs add returned %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	// Kubo streams newline-delimited JSON; the last object is the root.
	var last addResponse
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var r addResponse
		if json.Unmarshal([]byte(line), &r) == nil && r.Hash != "" {
			last = r
		}
	}
	if last.Hash == "" {
		return fmt.Errorf("ipfs add returned no hash")
	}
	// The node's answer must match ours. A mismatch means one of us is wrong
	// about what these bytes are called, and storing it anyway would file the
	// document under a name that does not verify.
	if !strings.EqualFold(last.Hash, cid) {
		return fmt.Errorf("ipfs returned CID %s but the content hashes to %s — refusing to record a mismatch", last.Hash, cid)
	}
	return nil
}

// Fetch reads from the node, falling back to the local copy. The registry
// re-verifies whatever comes back, so a wrong answer from either source is
// caught before it reaches a caller.
func (p *ipfsPinStore) Fetch(cid string) ([]byte, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.apiURL+"/api/v0/cat?arg="+cid, nil)
	if err == nil {
		if resp, err := p.client.Do(req); err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				if b, err := io.ReadAll(io.LimitReader(resp.Body, maxDocBytes)); err == nil && len(b) > 0 {
					return b, true
				}
			}
		}
	}
	return p.fallback.Fetch(cid)
}
