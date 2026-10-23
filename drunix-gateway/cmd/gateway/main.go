// AasthiChain Drunix Gateway — Golang service exposing NPCI Drunix
// transaction lifecycle + AI fraud screening for the hackathon demo.
//
// Run (default deterministic mock network, FAQ 19 local dev):
//
//	go run .            # :21100
//	DRUNIX_PORT=9000 go run .
//
// Build with the real Fabric adapter:
//
//	go build -tags real .
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"

	drunix "github.com/katepallewarprathmesh-sketch/AasthiChain/drunix-gateway"
)

func main() {
	var ledger drunix.DrunixClient = drunix.NewMockLedger()
	mode := os.Getenv("DRUNIX_MODE")
	if mode == "real" {
		g, err := newRealGateway(envOr("DRUNIX_MSP_ID", "InvestorMSP"))
		switch {
		case err == nil:
			ledger = g
			log.Printf("Drunix mode: REAL, connected to %s as MSP %s",
				envOr("DRUNIX_PEER_ENDPOINT", envOr("DRUNIX_API_HOST", "(unset)")), envOr("DRUNIX_MSP_ID", "InvestorMSP"))
		case os.Getenv("DRUNIX_FALLBACK_MOCK") == "true":
			// Opt-in only. A node that quietly serves simulated answers under
			// the word "real" is the one defect this project cannot afford,
			// so falling back has to be asked for and is said out loud.
			log.Printf("Drunix real mode failed (%v); DRUNIX_FALLBACK_MOCK=true, so continuing on the SIMULATOR. Nothing in this process is on a real network.", err)
		default:
			log.Fatalf("Drunix real mode failed: %v\n"+
				"Set DRUNIX_PEER_ENDPOINT, DRUNIX_MSP_ID, DRUNIX_CERT_FILE, DRUNIX_KEY_FILE and DRUNIX_TLS_CERT, "+
				"or set DRUNIX_FALLBACK_MOCK=true to run on the simulator instead. See docs/DRUNIX.md.", err)
		}
	} else {
		log.Printf("Drunix mode: mock, deterministic Fabric-fork simulator (set DRUNIX_MODE=real and build with -tags real for a live network)")
	}

	srv := drunix.NewServer(ledger)

	// Embedded Drunix pipeline: LP → Orderer(RAFT) → VS(VSCC) → CP(MVCC+commit)
	state := drunix.NewStateDB()
	transient := drunix.NewTransientStore()
	// The block chain is durable when DATABASE_URL is set: blocks are appended
	// to umi_block (append-only — no UPDATE, no DELETE) and replayed at boot,
	// re-verified before the node will extend them. Without a database the
	// chain is in-memory, exactly as before.
	blockStore := drunix.OpenUMIStoreFromEnv()
	var chain *drunix.DrunixChain
	var chainV drunix.ChainVerification
	if blockStore != nil {
		chain, chainV = drunix.NewChainWithStore(blockStore)
	} else {
		chain, chainV = drunix.NewChain(), drunix.ChainVerification{Valid: true}
	}
	if !chainV.Valid {
		log.Printf("WARNING: stored chain failed verification at block %d (%s) — serving read-only", chainV.BrokenAt, chainV.Reason)
	}
	srv.Pipeline = drunix.NewPipeline(state, transient, chain)
	// Document register: IPFS content addressing + anchoring to the same
	// chain. Additive — the existing single documentHash on a property keeps
	// working untouched.
	evmMirror := drunix.OpenEVMMirrorFromEnv()
	srv.Docs = drunix.NewDocumentRegistry(chain, drunix.OpenPinStoreFromEnv()).
		WithEVMMirror(evmMirror)
	log.Println(evmMirror.Describe())
	if evmMirror != nil {
		// Prove the address really holds the contract, rather than finding
		// out one document at a time once traffic starts.
		if n, err := evmMirror.Total(); err != nil {
			log.Printf("public-chain mirror: reachable but not answering as a DocumentRegistry (%v) — anchors will still commit locally", err)
		} else {
			log.Printf("public-chain mirror: contract live, %d documents already anchored there", n)
		}
	}
	if blockStore != nil {
		defer blockStore.Close()
	}

	// Settlement event stream. Post-commit fan-out of what each block meant,
	// over the Kafka wire protocol so the deployment can point it at Kafka,
	// Redpanda, WarpStream, MSK or Confluent without a code change. With no
	// EVENT_STREAM_BROKERS this is a local counter that contacts nothing.
	stream := drunix.NewEventPublisher()
	chain.StreamTo(stream)
	srv.Stream = stream
	defer func() { _ = stream.Close() }()
	if stream.Mode() == "simulation" {
		log.Printf("event stream: off. Set EVENT_STREAM_BROKERS to publish settlement events over the Kafka protocol (Kafka, Redpanda, WarpStream, MSK, Confluent)")
	}
	// UMI rail — RBI Unified Market Interface pattern (atomic DvP in wholesale
	// CBDC) mounted on the same service. Disable with UMI_ENABLED=false.
	if os.Getenv("UMI_ENABLED") != "false" {
		sec := drunix.NewMemorySecurities()
		srv.UMI = drunix.NewUMIRail(sec, chain)
		// Durable mirror: DATABASE_URL (the project's Neon Postgres) makes rail
		// state survive restarts and free-instance sleeps. Absent/unreachable =>
		// in-memory, exactly as before. UMI_PERSIST=false forces in-memory.
		if blockStore != nil {
			srv.UMI = srv.UMI.WithStore(blockStore)
		}
		// File the rail's own generated certificates — contract notes and
		// coupon advices — into the content-addressed register.
		srv.UMI = srv.UMI.WithDocuments(srv.Docs)
		// Request-level idempotency for the money-moving POSTs. Durable when
		// a database is present, so a retry after a restart still replays the
		// original response instead of settling twice. Callers that send no
		// Idempotency-Key are unaffected.
		srv.Idem = drunix.NewIdemStore()
		if blockStore != nil {
			srv.Idem = srv.Idem.WithPersister(blockStore)
		}
		log.Printf("UMI idempotency: %s — send Idempotency-Key on POST /umi/dvp to make retries safe", srv.Idem.Mode())
		log.Printf("UMI rail mounted at /umi/* — SEBI Demat 2.0 pattern: Drunix securities leg + e₹-W wholesale CBDC cash leg, atomic DvP (simulation)")
		// Hosted deployments start empty, which makes the demo page look broken.
		// Seed the same positions/wallets the local demo uses (UMI_SEED_DEMO=false to skip).
		// Seeding is skipped when state was restored from the database, so a
		// restart never re-credits wallets (that would break conservation).
		// IsEmpty() looks at wallets, instructions and funding — not at
		// positions. An asset that already has a cap table must never be
		// seeded again on top of it, so check that separately.
		seedAsset := envOr("UMI_SEED_ASSET", "PROP-GREEN-VALLEY-PUNE-001")
		_, seedOutstanding := srv.UMI.AuthorisedSupply(seedAsset)
		if os.Getenv("UMI_SEED_DEMO") != "false" && srv.UMI.IsEmpty() && seedOutstanding == 0 {
			// via the rail so the seeded position is mirrored to the store too
			_, _ = srv.UMI.SeedPosition(seedAsset, envOr("UMI_SEED_OWNER", "originator1"), 15000, 15000)
			_, _, _ = srv.UMI.FundWallet("investor1", 100000)
			_, _, _ = srv.UMI.FundWallet("investor2", 50000)
			log.Printf("UMI demo state seeded: 15000 tokens to %s, e₹-W wallets investor1 ₹1,00,000 / investor2 ₹50,000",
				envOr("UMI_SEED_OWNER", "originator1"))

		}

		// Carbon and the private data collections seed on their own terms,
		// not behind IsEmpty().
		//
		// IsEmpty() asks whether there are wallets, instructions or funding.
		// Production restores all three from the database, so it is false
		// from the first boot after go-live, and every later feature seeded
		// inside that branch silently never ran: the carbon card and the
		// collections table were empty on the deployed site while working
		// perfectly in development. Each seed now checks for the thing it
		// creates, which also makes it safe to run on every start.
		if os.Getenv("UMI_SEED_DEMO") != "false" {
			carbonAsset := envOr("UMI_SEED_CARBON_ASSET", "CARB-NSK-AGROFOREST-2024")
			if _, outstanding := srv.UMI.AuthorisedSupply(carbonAsset); outstanding == 0 {
				if _, err := srv.UMI.RegisterAsset(drunix.AssetProfile{
					AssetID:      carbonAsset,
					Class:        drunix.AssetClassCarbon,
					Name:         "Nashik agroforestry carbon credits, vintage 2024",
					ProjectID:    "AAS-CARB-0001",
					Vintage:      2024,
					Methodology:  "Afforestation and reforestation (pattern reference, not a certified methodology)",
					Country:      "IN",
					SerialPrefix: "AAS-CARB-0001-2024",
				}); err != nil && !errors.Is(err, drunix.ErrUMIAssetClassLocked) {
					log.Printf("carbon seed: could not register asset class: %v", err)
				} else {
					_, _ = srv.UMI.SeedPosition(carbonAsset, envOr("UMI_SEED_OWNER", "originator1"), 5000, 5000)
					_, _, _ = srv.UMI.AssignISIN(carbonAsset, envOr("UMI_SEED_OWNER", "originator1"), "")
					log.Printf("carbon credits seeded: 5000 credits of %s to %s (asset class CARBON, registry simulated)",
						carbonAsset, envOr("UMI_SEED_OWNER", "originator1"))
				}
			}

			// One KYC record per demo investor, written into the private
			// data collection by the registrar, so a reviewer can try the
			// thing worth trying: read it as the subject, be refused as
			// anybody else, and verify it against the chain hash without
			// being able to read it at all. The values are invented, like
			// every other demo figure here.
			if pdc := srv.UMI.Private(); pdc != nil {
				for _, sub := range []struct{ id, name, last4 string }{
					{"investor1", "Asha Kulkarni", "4417"},
					{"investor2", "Rohit Deshmukh", "8820"},
				} {
					if _, _, err := pdc.Get(drunix.CollectionKYC, sub.id, "regulator1", "regulator"); err == nil {
						continue // already there, leave it alone
					}
					if _, err := pdc.Put(drunix.PrivateWrite{
						Collection: drunix.CollectionKYC,
						Key:        sub.id,
						Owner:      sub.id,
						Value: map[string]interface{}{
							"documentType": "AADHAAR",
							"holderName":   sub.name,
							"idLastFour":   sub.last4,
							"verifiedBy":   "registrar1",
							"simulated":    true,
						},
					}, "registrar1", "registrar"); err != nil {
						log.Printf("private data seed: %v", err)
					}
				}
				log.Printf("Private data collections mounted at /umi/private/*: values held by member roles, hashes on the chain")
			}
		}

		// Verifiable credentials (credentials.go): a registrar signs a
		// statement about a property, the hash is anchored here, and
		// anyone can check both without trusting this service.
		srv.Credentials = drunix.NewCredentialRegistry(chain)
		if n := srv.Credentials.RestoreFromChain(); n > 0 {
			log.Printf("Credential registry restored %d credential anchor(s) from the ledger", n)
		}
		log.Printf("Credentials mounted at /umi/credentials/*: Ed25519 signed, hash anchored on the chain")

		// Attestation accountability: who vouched for an asset, and who is
		// exposed when that is withdrawn (attestation.go).
		srv.Attestations = drunix.NewAttestationService(chain, srv.Credentials, srv.UMI)
		log.Printf("Attestations mounted at /umi/attestations/*: downstream exposure of every attestation")

		// Proof of backing: tokens outstanding against units a named party
		// has attested exist, refreshed on a stated cadence (backing.go).
		// Assets nobody has attested are unaffected.
		srv.Backing = drunix.NewBackingRegistry(srv.UMI, chain)
		if n := srv.Backing.RestoreBackingFromChain(); n > 0 {
			log.Printf("Backing registry restored %d statement(s) of backing from the ledger", n)
		}
		srv.UMI.SetIssuanceGate(srv.Backing)
		log.Printf("Backing mounted at /umi/backing/*: issuance refused past the attested figure, or once it goes stale")

		// Cross-border funding (crossborder.go): a buyer outside India funds
		// a purchase with a stablecoin that is converted outside India, and
		// the rupee wallet is credited only against an off-ramp attestation.
		// Paying a seller in tokens for Indian property is not a route.
		srv.CrossBorder = drunix.NewCBXRegistry(srv.UMI, chain, nil)
		log.Printf("Cross-border funding mounted at /umi/crossborder/*: simulated, settles in INR through banking channels")

		// Public-chain anchoring (solana.go). This one is not a simulation:
		// the RPC calls are live. Reads work with no key; publishing needs a
		// funded SOLANA_SECRET_B58 and is off until it has one.
		srv.Anchors = drunix.NewSolanaAnchor(chain,
			os.Getenv("SOLANA_RPC_URL"), os.Getenv("SOLANA_CLUSTER"), os.Getenv("SOLANA_SECRET_B58"))
		// CBDC settlement layer: e₹ accounts, programmable grants, the
		// offline voucher path and conditional release. Additive: nothing
		// else on the rail depends on it.
		srv.CBDC = drunix.NewCBDCLedger(srv.UMI, chain)
		log.Printf("CBDC layer mounted at /umi/cbdc/*: simulated e₹, no central bank money is issued")

		// Cross-border corridors on top of the CBDC layer: each rail with
		// its own licence requirement, caps and settlement model.
		srv.AML = drunix.NewAMLDesk(chain)
		srv.Corridors = drunix.NewCorridorDesk(srv.UMI, chain, srv.CBDC)
		srv.Corridors.AML = srv.AML
		srv.Agent = drunix.NewAgentDesk(chain, srv.Corridors, srv.CBDC, srv.AML, srv.Backing)
		srv.KYC = drunix.NewKYCDesk(chain, srv.CBDC)
		srv.CBDCInterop = drunix.NewCBDCInteropDesk(chain, srv.CBDC)
		srv.Keys = drunix.NewKeyRegistry(chain)

		// Signed feeds: the one supported way an outside fact enters the
		// rail. The cross-border quote is its first consumer, and falls
		// back to the published indicative constant, saying so, whenever
		// no signed reading is fresh enough to use.
		srv.Oracle = drunix.NewOracleRegistry(chain, srv.Keys)
		// Declared at boot, deliberately with no reading in it. The rate
		// the quote actually uses is then an honest "declared, nothing
		// published yet, falling back to the indicative constant" rather
		// than the feed simply not existing.
		if _, err := srv.Oracle.RegisterFeed(drunix.Feed{
			FeedID:          drunix.FeedINRUSD,
			Description:     "Indian rupees per US dollar, for the cross-border funding leg",
			Unit:            "INR per USD",
			Publishers:      []string{"registrar1", "regulator1"},
			MaxStalenessSec: 900,
			MinPublishers:   1,
			MaxDeviationPct: 2,
		}, "system"); err != nil {
			log.Printf("signed feeds: could not declare %s: %v", drunix.FeedINRUSD, err)
		}
		if srv.CrossBorder != nil {
			srv.CrossBorder.UseRateFeed(srv.Oracle, drunix.FeedINRUSD)
		}
		log.Printf("Signed feeds mounted at /umi/oracle/*: every reading signed by a registered key, every feed declaring the age at which it stops being usable")
		log.Printf("Corridors mounted at /umi/corridors/*: simulated, this deployment holds no payment licence")
		log.Printf("AML screening mounted at /umi/aml/*: %s", drunix.AMLListDescription(srv.AML))
		log.Printf("CBDC interoperability mounted at /umi/cbdc/interop/*: e-rupee to bank and tokenised deposit, far legs simulated")
		log.Printf("Electronic KYC mounted at /umi/kyc/*: simulated verification, real flow; Aadhaar numbers are refused, not stored")
		log.Printf("Proposing agent mounted at /umi/agent/*: drafts actions for a person to approve, executes nothing on its own")

		if srv.Anchors.CanWrite() {
			log.Printf("Anchoring mounted at /umi/anchors/*: live Solana writes from %s", srv.Anchors.Address())
		} else {
			log.Printf("Anchoring mounted at /umi/anchors/*: live reads, writes off until a funded key is set")
		}

		// Agent passports (agentid.go): an automated actor acts under a
		// pseudonym, and the principal behind it is split across custodians
		// so that identifying them takes a threshold and leaves a record.
		// Per-jurisdiction rule sets (jurisdiction.go): the statutory basis
		// expressed as rules a transaction is actually tested against, each
		// citing the instrument it comes from.
		srv.Jurisdictions = drunix.NewJurisdictionRegistry(chain)
		if srv.CrossBorder != nil {
			srv.CrossBorder.UseRuleSet(srv.Jurisdictions, "IN-MH")
		}
		log.Printf("Jurisdiction rules mounted at /umi/jurisdictions/*: cross-border quotes are tested against the declared rule set, and an undeclared jurisdiction refuses")

		// Card rail economics and disputes (cardscheme.go): the split a
		// merchant never sees, and the reversibility that makes card money
		// behave unlike ledger money.
		srv.Cards = drunix.NewCardDesk(chain)
		log.Printf("Card rail mounted at /umi/cards/*: interchange split and the full dispute ladder, modelled; this deployment holds no scheme membership so nothing is authorised or cleared")

		srv.Agents = drunix.NewAgentRegistry(chain)
		log.Printf("Agent passports mounted at /umi/agents/*: pseudonymous actors, principal recoverable only by a threshold of custodians")

		// Delegated authority for software agents (mandates.go). Nothing
		// autonomous runs here; this is the authority layer such an actor
		// would act under, enforced on the settlement path.
		srv.Mandates = drunix.NewMandateRegistry(chain, srv.Credentials)
		if n := srv.Mandates.RestoreFromChain(); n > 0 {
			log.Printf("Mandate registry restored %d delegated mandate(s) from the ledger", n)
		}
		log.Printf("Mandates mounted at /umi/mandates/*: bounded agent authority, spend counted on the ledger")

		// Work desk — escrowed property upkeep paid on accepted delivery
		// (work.go), with a pluggable adapter at the talent boundary.
		// WORK_ENABLED=false removes the routes and changes nothing else.
		if os.Getenv("WORK_ENABLED") != "false" {
			provider := drunix.NewWorkProvider()
			srv.Work = drunix.NewWorkDesk(srv.UMI, provider)
			// The chain is the desk's durable store: replaying WORK_* blocks
			// restores the orders and re-applies any escrow that was still
			// held when the process stopped.
			if n := srv.Work.RestoreWorkFromChain(); n > 0 {
				log.Printf("Work desk restored %d order(s) from the ledger", n)
			}
			log.Printf("Work desk mounted at /umi/work/* — escrow released against an anchored deliverable; talent provider %q mode=%s",
				provider.Name(), provider.Mode())
		}
	}
	log.Printf("Drunix pipeline wired: LitePeer + Orderer(3, RAFT sim) + ValidationService + CommittingPeer on hash-chained ledger")
	// PaaS hosts (Render, Railway, Cloud Run, Fly) inject $PORT — honour it,
	// falling back to DRUNIX_PORT and then the local default.
	port := envOr("DRUNIX_PORT", os.Getenv("PORT"))
	addr := ":" + envOr2(port, "21100")
	// Router() late-binds the event hub to the chain, so the relay is started
	// after it: the hub must exist before anything is delivered to it.
	// Wrap the router so every failure is recorded against a request id and a
	// panic in one handler can no longer take the whole rail down. See
	// diagnostics.go; read it back with GET /diagnostics.
	handler := drunix.WithDiagnostics(srv.Router())
	if relay := srv.StartOutboxRelay(context.Background()); relay != nil {
		defer relay.Stop()
	}
	log.Printf("AasthiChain Drunix Gateway (Golang) listening on %s — channel %s, chaincode %s",
		addr, drunix.Channel, drunix.ChaincodeName)
	log.Fatal(http.ListenAndServe(addr, handler))
}

// envOr2 returns v, or def when v is empty.
func envOr2(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
