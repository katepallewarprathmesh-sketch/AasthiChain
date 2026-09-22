package paymentgateway

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// Go HTTP Server — Production-ready with Webhook + UTR + DigiLocker + Property Data + Persistent DB
// Stay close with Golang — all logic in Go, not just JS mock
// Run: go run ./payment-gateway -port 8080
// Env: DATABASE_URL, NPCI_MODE, DIGILOCKER_CLIENT_ID, PROPERTY_DATA_API_KEY, WEBHOOK_SECRET

type Server struct {
	Gateway        *GatewayWithWebhook
	DigiLocker     *DigiLockerProvider
	PropertyData   *PropertyDataProvider
	DB             *DB
	WebhookSecret  string
}

func NewServer() (*Server, error) {
	// Init DB
	db, err := GetDB()
	if err != nil {
		log.Printf("[Server] DB init failed, using file-backed fallback: %v", err)
		db = NewTestDB()
	}
	if err := db.Init(); err != nil {
		log.Printf("[Server] DB migration failed: %v", err)
	}

	// KYC provider — use DigiLocker for real, mock for hackathon
	digiMode := DigiLockerMode(os.Getenv("DIGILOCKER_MODE"))
	if digiMode == "" {
		digiMode = DigiLockerMock
	}
	digiProvider := NewDigiLockerProvider(digiMode, os.Getenv("DIGILOCKER_CLIENT_ID"), os.Getenv("DIGILOCKER_REDIRECT_URI"))

	// Property data provider
	propMode := PropertyDataMode(os.Getenv("PROPERTY_DATA_MODE"))
	if propMode == "" {
		propMode = PropertyDataMock
	}
	propProvider := NewPropertyDataProvider(propMode, map[PropertySource]string{
		SourceBhoomi:      os.Getenv("BHOOMI_API_KEY"),
		SourceDharani:     os.Getenv("DHARANI_API_KEY"),
		SourceMahabhulekh: os.Getenv("MAHABHULEKH_API_KEY"),
	})

	// Gateway with webhook + UTR
	gw := NewGatewayWithWebhook(digiProvider, nil)

	return &Server{
		Gateway:       gw,
		DigiLocker:    digiProvider,
		PropertyData:  propProvider,
		DB:            db,
		WebhookSecret: os.Getenv("WEBHOOK_SECRET"),
	}, nil
}

func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()

	// Health
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/api/health", s.handleHealth)

	// NPCI — existing + new webhook + UTR
	mux.HandleFunc("/api/npci/config", s.handleNPCIConfig)
	mux.HandleFunc("/api/npci/real-config", s.handleRealConfig)
	mux.HandleFunc("/api/npci/collect", s.handleCollect)
	mux.HandleFunc("/api/npci/payments/", s.handlePayments) // handles GET, approve, release, refund, decline, timeout
	mux.HandleFunc("/api/npci/payments", s.handleListPayments)
	mux.HandleFunc("/api/npci/callback", s.handleCallback)
	mux.HandleFunc("/api/npci/webhook", s.handleWebhook) // NEW — production webhook
	mux.HandleFunc("/api/npci/utr/", s.handleUTRLookup)   // NEW — UTR reconciliation
	mux.HandleFunc("/api/npci/reconcile", s.handleReconcile) // NEW
	mux.HandleFunc("/api/npci/webhook/test", s.handleWebhookTest) // NEW
	mux.HandleFunc("/api/npci/webhooks", s.handleWebhooks) // NEW — audit log
	mux.HandleFunc("/api/npci/failure-demo", s.handleFailureDemo)

	// DigiLocker KYC — NEW
	mux.HandleFunc("/api/kyc/digilocker/config", s.handleDigiLockerConfig)
	mux.HandleFunc("/api/kyc/digilocker/init", s.handleDigiLockerInit)
	mux.HandleFunc("/api/kyc/digilocker/callback", s.handleDigiLockerCallback)
	mux.HandleFunc("/api/kyc/digilocker/pull-document", s.handleDigiLockerPull)

	// Property data verification — NEW
	mux.HandleFunc("/api/properties/verify/config", s.handlePropertyVerifyConfig)
	mux.HandleFunc("/api/properties/", s.handlePropertyVerify) // handles /verify

	// DB config — NEW
	mux.HandleFunc("/api/db/config", s.handleDBConfig)
	mux.HandleFunc("/api/db/stats", s.handleDBStats)
	mux.HandleFunc("/api/db/migrate", s.handleDBMigrate)

	// CORS middleware
	return corsMiddleware(mux)
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Idempotency-Key, X-Fabric-Identity, X-Setu-Signature, X-ICICI-Signature")
		if r.Method == "OPTIONS" {
			w.WriteHeader(200)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"service": "aasthichain-api-gateway",
		"version": "2.4-go-webhook-utr-digilocker-property-db",
		"tracks":  "Go implementation — webhook + UTR + DigiLocker + Property Data + Persistent DB",
		"mode": map[string]string{
			"db":           string(s.DB.Mode),
			"digilocker":   string(s.DigiLocker.mode),
			"propertyData": string(s.PropertyData.mode),
			"npci":         os.Getenv("NPCI_MODE"),
		},
		"paymentRails": map[string]interface{}{
			"primary":   "NPCI UPI Collect (Go — webhook + UTR reconciliation)",
			"secondary": "Sepolia PaymentEscrow.sol",
			"webhook":   "/api/npci/webhook with signature verification + UTR index",
			"utr":       "12-digit numeric realistic IMPS UTR",
		},
	})
}

func (s *Server) handleNPCIConfig(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"rail":        "UPI Collect (P2M) — Go implementation",
		"currency":    "INR",
		"vpaFormat":   "handle@aasthichain",
		"idFormats": map[string]string{
			"paymentId": "NPCI-XXXXXXXXXXXX",
			"utr":       "12-digit numeric (real) + IMPS+RRN legacy",
			"rrn":       "12-digit 418...",
		},
		"expiry":     "5 minutes",
		"statusFlow": "PENDING → CONFIRMED (via webhook with UTR) → RELEASED / REFUNDED",
		"webhook":    "POST /api/npci/webhook — Setu/ICICI POSTs with UTR, RRN, status, signature",
		"utr":        "GET /api/npci/utr/:utr — bank statement reconciliation",
		"reconcile":  "GET /api/npci/reconcile — Regulator dashboard",
		"isGo":       true,
	})
}

func (s *Server) handleRealConfig(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"mode": "Go — real NPCI via Setu/ICICI",
		"providers": []string{"Setu (Pine Labs) — NPCI-certified switch", "ICICI Bank UPI Collect", "Decentro"},
		"webhook": map[string]string{
			"endpoint": "/api/npci/webhook",
			"signature": "HMAC SHA256 — X-Setu-Signature header, WEBHOOK_SECRET env",
			"flow": "Bank → Setu → POST webhook with UTR → verify signature → check amount → update payment → trigger Drunix transfer",
		},
		"utr": map[string]string{
			"format": "12-digit numeric (real IMPS) — e.g., 418123456789",
			"lookup": "GET /api/npci/utr/:utr",
			"index":  "In-memory + Postgres utr_index table — O(1) lookup",
		},
	})
}

func (s *Server) handleCollect(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}

	var req CollectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	// Idempotency key from header
	idemKey := r.Header.Get("X-Idempotency-Key")
	if idemKey != "" && req.IdempotencyKey == "" {
		req.IdempotencyKey = idemKey
	}

	payment, err := s.Gateway.InitiateCollect(req)
	if err != nil {
		// If payment created but failed KYC etc, return payment with error
		if payment != nil {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(payment)
			return
		}
		http.Error(w, err.Error(), 400)
		return
	}

	// Save to DB
	SaveJSON(s.DB.NPCIPayments, payment.PaymentID, payment)

	w.WriteHeader(201)
	json.NewEncoder(w).Encode(payment)
}

func (s *Server) handlePayments(w http.ResponseWriter, r *http.Request) {
	// Path: /api/npci/payments/{id}, /api/npci/payments/{id}/approve, etc
	path := strings.TrimPrefix(r.URL.Path, "/api/npci/payments/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "paymentId required", 400)
		return
	}

	paymentID := parts[0]

	if len(parts) == 1 && r.Method == "GET" {
		// GET /api/npci/payments/{id}
		p, err := s.Gateway.GetPayment(paymentID)
		if err != nil {
			http.Error(w, err.Error(), 404)
			return
		}
		json.NewEncoder(w).Encode(p)
		return
	}

	if len(parts) == 2 {
		action := parts[1]
		switch action {
		case "approve":
			if r.Method != "POST" {
				http.Error(w, "method not allowed", 405)
				return
			}
			var body struct {
				PayerID string `json:"payerId"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			p, err := s.Gateway.ApprovePayment(paymentID, body.PayerID)
			if err != nil {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error(), "payment": p})
				return
			}
			// Generate realistic UTR on CONFIRMED (like JS version)
			// In webhook flow, UTR comes via webhook, but for mock approve we generate
			gen := GenerateUTRRealistic()
			if p.RRN == "" {
				p.RRN = gen.RRN
			}
			if p.UTR == "" {
				p.UTR = gen.UTR
				s.Gateway.Mu.Lock()
				s.Gateway.UtrIndex[gen.UTR] = paymentID
				s.Gateway.UtrIndex[gen.UTR12] = paymentID
				s.Gateway.UtrIndex[gen.RRN] = paymentID
				s.Gateway.Mu.Unlock()
			}
			SaveJSON(s.DB.NPCIPayments, paymentID, p)
			json.NewEncoder(w).Encode(p)
			return

		case "release":
			if r.Method != "POST" {
				http.Error(w, "method not allowed", 405)
				return
			}
			var body struct {
				DrunixTransferID string `json:"drunixTransferId"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			p, err := s.Gateway.ReleasePayment(paymentID, body.DrunixTransferID)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			SaveJSON(s.DB.NPCIPayments, paymentID, p)
			json.NewEncoder(w).Encode(p)
			return

		case "refund":
			if r.Method != "POST" {
				http.Error(w, "method not allowed", 405)
				return
			}
			var body struct {
				Reason string `json:"reason"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			p, err := s.Gateway.RefundPayment(paymentID, body.Reason)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			SaveJSON(s.DB.NPCIPayments, paymentID, p)
			json.NewEncoder(w).Encode(p)
			return

		case "decline":
			if r.Method != "POST" {
				http.Error(w, "method not allowed", 405)
				return
			}
			var body struct {
				Reason string `json:"reason"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			p, err := s.Gateway.DeclinePayment(paymentID, body.Reason)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			json.NewEncoder(w).Encode(p)
			return

		case "timeout":
			if r.Method != "POST" {
				http.Error(w, "method not allowed", 405)
				return
			}
			p, err := s.Gateway.ExpirePayment(paymentID)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			json.NewEncoder(w).Encode(p)
			return
		}
	}

	http.Error(w, "not found", 404)
}

func (s *Server) handleListPayments(w http.ResponseWriter, r *http.Request) {
	list := s.Gateway.ListPayments()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"payments":     list,
		"count":        len(list),
		"isSimulation": true,
		"isGo":         true,
	})
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	// Legacy callback — keep for backward compatibility
	var body map[string]interface{}
	json.NewDecoder(r.Body).Decode(&body)
	paymentID, _ := body["paymentId"].(string)
	if paymentID == "" {
		http.Error(w, "paymentId required", 400)
		return
	}

	// For simplicity, mark as received
	json.NewEncoder(w).Encode(map[string]interface{}{
		"received":  true,
		"paymentId": paymentID,
		"note":      "Legacy callback — use /api/npci/webhook for production with signature + UTR",
	})
}

func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}

	// Read raw body for signature verification
	bodyBytes := make([]byte, r.ContentLength)
	r.Body.Read(bodyBytes)
	// If ContentLength is 0, try decoding anyway
	var payload WebhookPayload
	if len(bodyBytes) == 0 {
		// Re-read via json decoder
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		// Actually need to handle differently — for now decode directly
		json.NewDecoder(r.Body).Decode(&payload)
		bodyBytes, _ = json.Marshal(payload)
	} else {
		json.Unmarshal(bodyBytes, &payload)
	}

	// If still empty, try direct decode
	if payload.GetPaymentID() == "" {
		var temp WebhookPayload
		if err := json.Unmarshal(bodyBytes, &temp); err == nil {
			payload = temp
		} else {
			// Try from raw map
			var raw map[string]interface{}
			json.Unmarshal(bodyBytes, &raw)
			if pid, ok := raw["paymentId"].(string); ok {
				payload.PaymentID = pid
			}
			if ref, ok := raw["referenceId"].(string); ok {
				payload.ReferenceID = ref
			}
			if status, ok := raw["status"].(string); ok {
				payload.Status = status
			}
			if utr, ok := raw["utr"].(string); ok {
				payload.UTR = utr
			}
			if rrn, ok := raw["rrn"].(string); ok {
				payload.RRN = rrn
			}
		}
	}

	signature := r.Header.Get("X-Setu-Signature")
	if signature == "" {
		signature = r.Header.Get("X-ICICI-Signature")
	}
	if signature == "" {
		signature = r.Header.Get("X-Webhook-Signature")
	}

	secret := s.WebhookSecret
	if secret == "" {
		secret = os.Getenv("SETU_WEBHOOK_SECRET")
	}
	if secret == "" {
		secret = os.Getenv("ICICI_WEBHOOK_SECRET")
	}

	payment, err := s.Gateway.ProcessWebhook(payload, bodyBytes, signature, secret)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, err.Error(), 404)
			return
		}
		if strings.Contains(err.Error(), "signature") {
			http.Error(w, err.Error(), 401)
			return
		}
		if strings.Contains(err.Error(), "mismatch") {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error":    err.Error(),
				"paymentId": payload.GetPaymentID(),
				"note":     "Amount mismatch — manual review required",
			})
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}

	SaveJSON(s.DB.NPCIPayments, payment.PaymentID, payment)

	json.NewEncoder(w).Encode(map[string]interface{}{
		"received":  true,
		"paymentId": payment.PaymentID,
		"status":    payment.Status,
		"rrn":       payment.RRN,
		"utr":       payment.UTR,
		"provider":  payload.Provider,
		"message":   "Webhook processed — UTR assigned, ready for RELEASE",
		"isGo":      true,
	})
}

func (s *Server) handleUTRLookup(w http.ResponseWriter, r *http.Request) {
	utr := strings.TrimPrefix(r.URL.Path, "/api/npci/utr/")
	if utr == "" {
		http.Error(w, "UTR required", 400)
		return
	}

	payment, err := s.Gateway.GetPaymentByUTR(utr)
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"utr":       utr,
		"paymentId": payment.PaymentID,
		"payment":   payment,
		"reconciliation": map[string]interface{}{
			"utrFormat": len(utr) == 12,
			"provider":  "mock",
		},
		"isGo": true,
	})
}

func (s *Server) handleReconcile(w http.ResponseWriter, r *http.Request) {
	report := s.Gateway.GetReconciliationReport()
	json.NewEncoder(w).Encode(report)
}

func (s *Server) handleWebhookTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}

	var body struct {
		PaymentID string `json:"paymentId"`
		Scenario  string `json:"scenario"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if body.PaymentID == "" {
		http.Error(w, "paymentId required", 400)
		return
	}

	payment, payload, err := s.Gateway.SimulateWebhook(body.PaymentID, body.Scenario)
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}

	if payment != nil {
		SaveJSON(s.DB.NPCIPayments, payment.PaymentID, payment)
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"test":        true,
		"scenario":    body.Scenario,
		"payloadSent": payload,
		"result":      payment,
		"isGo":        true,
	})
}

func (s *Server) handleWebhooks(w http.ResponseWriter, r *http.Request) {
	limit := 50
	webhooks := s.Gateway.ListWebhooks(limit)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"webhooks": webhooks,
		"count":    len(webhooks),
		"isGo":     true,
	})
}

func (s *Server) handleFailureDemo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scenario string `json:"scenario"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	switch body.Scenario {
	case "insufficient_funds":
		json.NewEncoder(w).Encode(map[string]interface{}{
			"scenario": body.Scenario,
			"expected": "FAILED_INSUFFICIENT_FUNDS",
			"result":   "FAILED_INSUFFICIENT_FUNDS: have ₹1.00 need ₹50,000",
			"isGo":     true,
		})
	case "kyc_unverified":
		json.NewEncoder(w).Encode(map[string]interface{}{
			"scenario": body.Scenario,
			"expected": "FAILED_KYC_NOT_VERIFIED",
			"isGo":     true,
		})
	default:
		json.NewEncoder(w).Encode(map[string]interface{}{
			"scenario": body.Scenario,
			"isGo":     true,
		})
	}
}

// DigiLocker handlers

func (s *Server) handleDigiLockerConfig(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"provider": "DigiLocker — Go implementation",
		"mode":     s.DigiLocker.mode,
		"isGo":     true,
		"endpoints": map[string]string{
			"init":     "POST /api/kyc/digilocker/init",
			"callback": "POST /api/kyc/digilocker/callback",
			"pull":     "POST /api/kyc/digilocker/pull-document",
		},
	})
}

func (s *Server) handleDigiLockerInit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IdentityID string `json:"identityId"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	session, err := s.DigiLocker.Init(body.IdentityID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	json.NewEncoder(w).Encode(session)
}

func (s *Server) handleDigiLockerCallback(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IdentityID string `json:"identityId"`
		Code       string `json:"code"`
		State      string `json:"state"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	session, err := s.DigiLocker.Callback(body.IdentityID, body.Code, body.State)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	json.NewEncoder(w).Encode(session)
}

func (s *Server) handleDigiLockerPull(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IdentityID string `json:"identityId"`
		DocType    string `json:"docType"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	doc, err := s.DigiLocker.PullDocument(body.IdentityID, body.DocType)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	json.NewEncoder(w).Encode(doc)
}

// Property data handlers

func (s *Server) handlePropertyVerifyConfig(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"provider": "Bhoomi/Dharani — Go implementation",
		"mode":     s.PropertyData.mode,
		"isGo":     true,
		"sources":  []string{"bhoomi", "dharani", "mahabhulekh"},
	})
}

func (s *Server) handlePropertyVerify(w http.ResponseWriter, r *http.Request) {
	// Path: /api/properties/{assetId}/verify
	path := strings.TrimPrefix(r.URL.Path, "/api/properties/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[1] != "verify" {
		http.Error(w, "not found", 404)
		return
	}

	assetID := parts[0]
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}

	var body struct {
		Source string `json:"source"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	source := PropertySource(body.Source)
	if source == "" {
		source = SourceBhoomi
	}

	// Mock our valuation — in real would fetch from DB
	verification, err := s.PropertyData.Verify(assetID, 7500000, "originator1", "Maharashtra", "Pune", "411045", source)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	json.NewEncoder(w).Encode(verification)
}

// DB handlers

func (s *Server) handleDBConfig(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"mode":   s.DB.Mode,
		"isGo":   true,
		"tables": []string{"properties", "balances", "transfers", "kyc", "npci_payments", "utr_index", "webhooks"},
	})
}

func (s *Server) handleDBStats(w http.ResponseWriter, r *http.Request) {
	stats, _ := s.DB.Stats()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"mode":  s.DB.Mode,
		"counts": stats,
		"isGo":  true,
	})
}

func (s *Server) handleDBMigrate(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.Init(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"mode":    s.DB.Mode,
		"message": "Migration completed — tables created",
		"isGo":    true,
	})
}

func main() {
	// For standalone Go server — not used in Vercel, but for local Go testing
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server, err := NewServer()
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

	handler := server.Router()

	log.Printf("AasthiChain Go Server v2.4 listening on :%s | DB: %s | DigiLocker: %s | PropertyData: %s", port, server.DB.Mode, server.DigiLocker.mode, server.PropertyData.mode)
	log.Printf("Endpoints: /api/npci/webhook (webhook with UTR), /api/npci/utr/:utr, /api/npci/reconcile, /api/kyc/digilocker/*, /api/properties/:id/verify, /api/db/*")
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatalf("Server failed: %v", err)
	}

	_ = time.Now
	_ = fmt.Sprintf
}
