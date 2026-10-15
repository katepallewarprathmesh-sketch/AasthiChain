//go:build real

package drunix

// Real Drunix network adapter. Compiled only with `go build -tags real`.
//
// Drunix is NPCI's enterprise fork of Hyperledger Fabric, and it speaks the
// Fabric Gateway protocol, so this connects with the standard Fabric Gateway
// client SDK: an X.509 enrolment signs proposals, a gRPC connection carries
// them to a peer, and the chaincode in chaincode/ is what runs on the other
// side.
//
// WHAT CHANGED AND WHY IT MATTERS
//
// The previous version of this file was a stub. With `-tags real` it reported
// mode "real", then served every call from the in-process simulator and
// labelled the ledger as real with a simulated fall back. Anyone reading the
// startup log would have believed the node was on a network it had never
// dialled.
// That is the one kind of defect this project cannot afford, so the adapter
// now either holds a live connection or refuses to be created.
//
// Configuration, all from the environment:
//
//	DRUNIX_PEER_ENDPOINT   host:port of the peer's gateway (required)
//	DRUNIX_MSP_ID          MSP the signing identity belongs to
//	DRUNIX_CERT_FILE       PEM X.509 certificate for that identity
//	DRUNIX_KEY_FILE        PEM private key, or a keystore directory
//	DRUNIX_TLS_CERT        PEM TLS CA certificate of the peer. Omit only for
//	                       a plaintext local network, which must be opted into
//	                       with DRUNIX_TLS_INSECURE=true.
//	DRUNIX_TLS_SERVER_NAME TLS server-name override, when the endpoint is
//	                       reached under a different name than its certificate
//	DRUNIX_CHANNEL         channel name (default "property-channel")
//	DRUNIX_CHAINCODE       chaincode name (default "aasthichain")
//
// There is no fallback to the simulator here. A node told to be real and
// unable to be real is a configuration error, and the caller decides what to
// do about it.

import (
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-gateway/pkg/identity"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// FabricGateway is a DrunixClient backed by a real Drunix/Fabric network.
type FabricGateway struct {
	mspID     string
	channel   string
	chaincode string
	endpoint  string

	conn     *grpc.ClientConn
	gw       *client.Gateway
	contract *client.Contract

	mu   sync.RWMutex
	seen map[string]*TxRecord // tx id -> what we submitted, for GetTransaction
}

// evaluateOnly names the chaincode functions that must never be submitted as
// transactions. Submitting a query wastes a block and, worse, makes a read
// look like a state change in the ledger history.
var evaluateOnly = map[string]bool{
	"GetPropertyDetails": true,
	"GetAllProperties":   true,
	"GetBalance":         true,
	"GetTransferHistory": true,
	"GetWallet":          true,
	"GetKYCStatus":       true,
}

// NewFabricGateway dials the configured Drunix peer and opens the channel and
// contract. It returns an error rather than a degraded object: every failure
// path here means "this node is not on the network it was told to join".
func NewFabricGateway(mspID string) (*FabricGateway, error) {
	if v := envOrEmpty("DRUNIX_MSP_ID"); v != "" {
		mspID = v
	}
	if mspID == "" {
		return nil, errors.New("drunix: DRUNIX_MSP_ID is required in real mode")
	}

	endpoint := envOrEmpty("DRUNIX_PEER_ENDPOINT")
	if endpoint == "" {
		// Older configuration split this in two. Accept both rather than
		// break an existing deployment.
		host, port := envOrEmpty("DRUNIX_API_HOST"), envOrEmpty("DRUNIX_API_PORT")
		if host != "" && port != "" {
			endpoint = host + ":" + port
		}
	}
	if endpoint == "" {
		return nil, errors.New("drunix: DRUNIX_PEER_ENDPOINT is required in real mode (host:port of the peer gateway)")
	}

	signingID, sign, err := loadIdentity(mspID)
	if err != nil {
		return nil, err
	}

	transport, err := transportCredentials()
	if err != nil {
		return nil, err
	}

	conn, err := grpc.NewClient(endpoint, grpc.WithTransportCredentials(transport))
	if err != nil {
		return nil, fmt.Errorf("drunix: dialling %s: %w", endpoint, err)
	}

	gw, err := client.Connect(
		signingID,
		client.WithSign(sign),
		client.WithClientConnection(conn),
		client.WithEvaluateTimeout(10*time.Second),
		client.WithEndorseTimeout(20*time.Second),
		client.WithSubmitTimeout(10*time.Second),
		client.WithCommitStatusTimeout(2*time.Minute),
	)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("drunix: opening gateway at %s: %w", endpoint, err)
	}

	channel := envOr("DRUNIX_CHANNEL", "property-channel")
	chaincode := envOr("DRUNIX_CHAINCODE", "aasthichain")
	contract := gw.GetNetwork(channel).GetContract(chaincode)

	return &FabricGateway{
		mspID: mspID, channel: channel, chaincode: chaincode, endpoint: endpoint,
		conn: conn, gw: gw, contract: contract,
		seen: make(map[string]*TxRecord),
	}, nil
}

// loadIdentity builds the signing identity from the enrolment on disk. The key
// path may be a file or an MSP keystore directory, because Fabric tooling
// produces the second and humans produce the first.
func loadIdentity(mspID string) (*identity.X509Identity, identity.Sign, error) {
	certPath := envOrEmpty("DRUNIX_CERT_FILE")
	keyPath := envOrEmpty("DRUNIX_KEY_FILE")
	if certPath == "" || keyPath == "" {
		return nil, nil, errors.New("drunix: DRUNIX_CERT_FILE and DRUNIX_KEY_FILE are required in real mode")
	}

	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, nil, fmt.Errorf("drunix: reading certificate %s: %w", certPath, err)
	}
	cert, err := identity.CertificateFromPEM(certPEM)
	if err != nil {
		return nil, nil, fmt.Errorf("drunix: parsing certificate %s: %w", certPath, err)
	}

	keyPEM, err := readKey(keyPath)
	if err != nil {
		return nil, nil, err
	}
	privateKey, err := identity.PrivateKeyFromPEM(keyPEM)
	if err != nil {
		return nil, nil, fmt.Errorf("drunix: parsing private key: %w", err)
	}

	id, err := identity.NewX509Identity(mspID, cert)
	if err != nil {
		return nil, nil, fmt.Errorf("drunix: building identity for MSP %s: %w", mspID, err)
	}
	sign, err := identity.NewPrivateKeySign(privateKey)
	if err != nil {
		return nil, nil, fmt.Errorf("drunix: building signer: %w", err)
	}
	return id, sign, nil
}

// readKey accepts either a PEM file or a keystore directory holding exactly
// one. A directory with several keys is ambiguous and is refused rather than
// guessed at, because signing with the wrong key fails at endorsement with an
// error that tells you nothing.
func readKey(keyPath string) ([]byte, error) {
	info, err := os.Stat(keyPath)
	if err != nil {
		return nil, fmt.Errorf("drunix: reading private key %s: %w", keyPath, err)
	}
	if !info.IsDir() {
		return os.ReadFile(keyPath)
	}
	entries, err := os.ReadDir(keyPath)
	if err != nil {
		return nil, fmt.Errorf("drunix: reading keystore %s: %w", keyPath, err)
	}
	var keys []string
	for _, e := range entries {
		if !e.IsDir() {
			keys = append(keys, e.Name())
		}
	}
	sort.Strings(keys)
	switch len(keys) {
	case 0:
		return nil, fmt.Errorf("drunix: keystore %s is empty", keyPath)
	case 1:
		return os.ReadFile(filepath.Join(keyPath, keys[0]))
	default:
		return nil, fmt.Errorf("drunix: keystore %s holds %d keys (%s); point DRUNIX_KEY_FILE at one of them",
			keyPath, len(keys), strings.Join(keys, ", "))
	}
}

// transportCredentials refuses to fall back to plaintext silently. A network
// carrying settlement instructions should be on TLS, and an operator who
// genuinely wants otherwise has to say so.
func transportCredentials() (credentials.TransportCredentials, error) {
	tlsCertPath := envOrEmpty("DRUNIX_TLS_CERT")
	if tlsCertPath == "" {
		if envOrEmpty("DRUNIX_TLS_INSECURE") == "true" {
			return insecure.NewCredentials(), nil
		}
		return nil, errors.New("drunix: DRUNIX_TLS_CERT is required, or set DRUNIX_TLS_INSECURE=true for a plaintext local network")
	}
	pem, err := os.ReadFile(tlsCertPath)
	if err != nil {
		return nil, fmt.Errorf("drunix: reading TLS certificate %s: %w", tlsCertPath, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("drunix: %s contains no usable certificate", tlsCertPath)
	}
	return credentials.NewClientTLSFromCert(pool, envOrEmpty("DRUNIX_TLS_SERVER_NAME")), nil
}

// SubmitTransaction endorses, orders and commits through the real network.
func (f *FabricGateway) SubmitTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error) {
	if evaluateOnly[fn] {
		return f.EvaluateTransaction(chaincode, fn, args, creatorMSP)
	}
	contract := f.contractFor(chaincode)

	proposal, err := contract.NewProposal(fn, client.WithArguments(args...))
	if err != nil {
		return f.failed(fn, args, creatorMSP, err), err
	}
	transaction, err := proposal.Endorse()
	if err != nil {
		return f.failed(fn, args, creatorMSP, err), fmt.Errorf("drunix: endorsement failed for %s: %w", fn, err)
	}
	commit, err := transaction.Submit()
	if err != nil {
		return f.failed(fn, args, creatorMSP, err), fmt.Errorf("drunix: submit failed for %s: %w", fn, err)
	}
	status, err := commit.Status()
	if err != nil {
		// The transaction reached the orderer: only the stream that reports
		// the outcome broke. Calling that FAILED would be a lie, because it
		// may well be committed. Report the id and say the status is unknown
		// so the caller can look it up on the ledger.
		unknown := &TxRecord{
			TxID:       commit.TransactionID(),
			Chaincode:  nameOr(chaincode, f.chaincode),
			Function:   fn,
			Args:       args,
			CreatorMSP: nameOr(creatorMSP, f.mspID),
			Channel:    f.channel,
			Status:     "UNKNOWN",
			Timestamp:  time.Now(),
			Event:      resultEvent("error", []byte(err.Error())),
		}
		f.remember(unknown)
		return unknown, fmt.Errorf("drunix: submitted %s as %s but the commit status stream failed, so the outcome is unknown: %w",
			fn, unknown.TxID, err)
	}
	if !status.Successful {
		err := fmt.Errorf("drunix: transaction %s rejected with validation code %d", status.TransactionID, int32(status.Code))
		return f.failed(fn, args, creatorMSP, err), err
	}

	rec := &TxRecord{
		TxID:        status.TransactionID,
		Chaincode:   nameOr(chaincode, f.chaincode),
		Function:    fn,
		Args:        args,
		CreatorMSP:  nameOr(creatorMSP, f.mspID),
		Channel:     f.channel,
		Status:      "COMMITTED",
		BlockNumber: status.BlockNumber,
		Timestamp:   time.Now(),
	}
	f.remember(rec)
	return rec, nil
}

// EvaluateTransaction queries an endorsing peer. No block, no state change.
func (f *FabricGateway) EvaluateTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error) {
	contract := f.contractFor(chaincode)
	result, err := contract.EvaluateTransaction(fn, args...)
	if err != nil {
		return f.failed(fn, args, creatorMSP, err), fmt.Errorf("drunix: query %s failed: %w", fn, err)
	}
	return &TxRecord{
		TxID:       "QUERY-" + fn,
		Chaincode:  nameOr(chaincode, f.chaincode),
		Function:   fn,
		Args:       args,
		CreatorMSP: nameOr(creatorMSP, f.mspID),
		Channel:    f.channel,
		Status:     "EVALUATED",
		Timestamp:  time.Now(),
		Event:      resultEvent(fn, result),
		Result:     string(result),
	}, nil
}

// GetTransaction returns what this process submitted under that id. The
// network is the authority on history, but reading an arbitrary transaction
// back requires the qscc system chaincode, which a Drunix channel policy may
// not grant us, so this does not pretend to be a full ledger query.
func (f *FabricGateway) GetTransaction(txID string) (*TxRecord, error) {
	f.mu.RLock()
	rec, ok := f.seen[txID]
	f.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("drunix: transaction %s was not submitted by this node", txID)
	}
	return rec, nil
}

// LedgerStatus reports the channel this node is actually joined to. It says
// "real" only because every call above goes to the network: there is no
// fallback path left in this file that could make that word untrue.
func (f *FabricGateway) LedgerStatus() (*LedgerStatus, error) {
	f.mu.RLock()
	submitted := len(f.seen)
	f.mu.RUnlock()
	return &LedgerStatus{
		Mode:    "real",
		Channel: f.channel,
		Network: "NPCI Drunix (Hyperledger Fabric fork), peer " + f.endpoint,
		Height:  uint64(submitted),
		TxCount: uint64(submitted),
		Time:    time.Now(),
	}, nil
}

// Close releases the gRPC connection.
func (f *FabricGateway) Close() error {
	if f.gw != nil {
		f.gw.Close()
	}
	if f.conn != nil {
		return f.conn.Close()
	}
	return nil
}

func (f *FabricGateway) contractFor(chaincode string) *client.Contract {
	if chaincode == "" || chaincode == f.chaincode {
		return f.contract
	}
	return f.gw.GetNetwork(f.channel).GetContract(chaincode)
}

func (f *FabricGateway) remember(rec *TxRecord) {
	f.mu.Lock()
	f.seen[rec.TxID] = rec
	f.mu.Unlock()
}

func (f *FabricGateway) failed(fn string, args []string, creatorMSP string, cause error) *TxRecord {
	return &TxRecord{
		TxID:       "FAILED-" + fn,
		Chaincode:  f.chaincode,
		Function:   fn,
		Args:       args,
		CreatorMSP: nameOr(creatorMSP, f.mspID),
		Channel:    f.channel,
		Status:     "FAILED",
		Timestamp:  time.Now(),
		Event:      resultEvent("error", []byte(cause.Error())),
	}
}

func nameOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func envOrEmpty(k string) string { return strings.TrimSpace(os.Getenv(k)) }

func envOr(k, fallback string) string {
	if v := envOrEmpty(k); v != "" {
		return v
	}
	return fallback
}

// resultEvent carries the chaincode's own bytes back to the caller without
// inventing a field: TxRecord has no payload, and a ChaincodeEvent is the
// shape the rest of the system already reads.
func resultEvent(name string, payload []byte) *ChaincodeEvent {
	if len(payload) == 0 {
		return nil
	}
	return &ChaincodeEvent{Name: name, Payload: string(payload)}
}

var _ = json.Marshal
