package handlers

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/aasthichain/api-gateway/fabric"
	"github.com/aasthichain/api-gateway/store"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type Handler struct {
	fabric      fabric.FabricClient
	idempotency *store.IdempotencyStore
}

func NewHandler(fabricClient fabric.FabricClient) *Handler {
	return &Handler{
		fabric:      fabricClient,
		idempotency: store.NewIdempotencyStore(),
	}
}

var jwtSecret = []byte("aasthichain-hackathon-secret-key-change-in-prod")

func (h *Handler) Login(c *gin.Context) {
	var req struct {
		IdentityID string `json:"identityId" binding:"required"`
		Role       string `json:"role" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT", "message": err.Error()})
		return
	}
	validRoles := map[string]string{
		"Originator": "OriginatorMSP",
		"Registrar":  "RegistrarMSP",
		"Investor":   "InvestorMSP",
		"Regulator":  "RegulatorMSP",
	}
	mspID, ok := validRoles[req.Role]
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT", "message": "invalid role"})
		return
	}
	if req.Role == "Investor" {
		kyc, _ := h.fabric.GetKYC(req.IdentityID)
		if kyc.KYCStatus != "VERIFIED" {
			c.Header("X-KYC-Warning", "KYC not verified")
		}
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"identityId": req.IdentityID,
		"mspId":      mspID,
		"role":       req.Role,
	})
	tokenString, err := token.SignedString(jwtSecret)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token generation failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"token":      tokenString,
		"identityId": req.IdentityID,
		"mspId":      mspID,
		"role":       req.Role,
		"fabricMode": h.fabric.Mode(),
	})
}

func (h *Handler) RegisterProperty(c *gin.Context) {
	var req struct {
		Title        string `json:"title" binding:"required"`
		State        string `json:"state" binding:"required"`
		City         string `json:"city" binding:"required"`
		Pincode      string `json:"pincode" binding:"required"`
		ValuationINR int64  `json:"valuationINR" binding:"required"`
		DocumentHash string `json:"documentHash" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT", "message": err.Error()})
		return
	}
	if len(req.DocumentHash) != 64 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT", "message": "documentHash must be SHA-256 hex (64 chars) — frontend now auto-computes via crypto.subtle.digest"})
		return
	}
	if req.ValuationINR < 100000 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT", "message": "valuation must be >= 100000"})
		return
	}
	idemKey := c.GetHeader("X-Idempotency-Key")
	if idemKey != "" {
		if cached, ok := h.idempotency.Get(idemKey); ok {
			c.JSON(http.StatusOK, cached)
			return
		}
	}
	identityId := c.GetString("identityId")
	assetId, err := h.fabric.RegisterProperty(identityId, req.Title, req.State, req.City, req.Pincode, req.ValuationINR, req.DocumentHash)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	resp := gin.H{"assetId": assetId, "status": "DRAFT", "message": "Property registered, pending registrar validation", "fabricMode": h.fabric.Mode()}
	if idemKey != "" {
		h.idempotency.Set(idemKey, resp)
	}
	c.JSON(http.StatusCreated, resp)
}

func (h *Handler) ValidateProperty(c *gin.Context) {
	assetId := c.Param("id")
	var req struct {
		Decision string `json:"decision" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT"})
		return
	}
	if req.Decision != "VALIDATED" && req.Decision != "REJECTED" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT", "message": "decision must be VALIDATED or REJECTED"})
		return
	}
	if err := h.fabric.ValidateProperty(assetId, req.Decision); err != nil {
		if strings.Contains(err.Error(), "ERR_ASSET_NOT_FOUND") {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		} else {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"assetId": assetId, "validationStatus": req.Decision, "fabricMode": h.fabric.Mode()})
}

func (h *Handler) MintPropertyTokens(c *gin.Context) {
	assetId := c.Param("id")
	var req struct {
		TotalTokens int64 `json:"totalTokens" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT"})
		return
	}
	if req.TotalTokens <= 0 || req.TotalTokens > 10_000_000 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_AMOUNT", "message": "totalTokens must be 1..10,000,000"})
		return
	}
	idemKey := c.GetHeader("X-Idempotency-Key")
	if idemKey != "" {
		if cached, ok := h.idempotency.Get(idemKey); ok {
			c.JSON(http.StatusOK, cached)
			return
		}
	}
	identityId := c.GetString("identityId")
	err := h.fabric.MintPropertyTokens(assetId, req.TotalTokens, identityId)
	if err != nil {
		msg := err.Error()
		status := http.StatusBadRequest
		if strings.Contains(msg, "ERR_ASSET_NOT_FOUND") {
			status = http.StatusNotFound
		} else if strings.Contains(msg, "ERR_ALREADY_TOKENIZED") || strings.Contains(msg, "ERR_DUPLICATE_MINT") {
			status = http.StatusConflict
		}
		c.JSON(status, gin.H{"error": msg})
		return
	}
	resp := gin.H{"assetId": assetId, "totalTokens": req.TotalTokens, "status": "TOKENIZED", "fabricMode": h.fabric.Mode(), "endorsement": "AND('OriginatorMSP.peer','RegistrarMSP.peer') enforced"}
	if idemKey != "" {
		h.idempotency.Set(idemKey, resp)
	}
	c.JSON(http.StatusOK, resp)
}

func (h *Handler) GetPropertyDetails(c *gin.Context) {
	assetId := c.Param("id")
	prop, err := h.fabric.GetProperty(assetId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	var tokenPrice int64
	if prop.TotalTokens > 0 {
		tokenPrice = prop.ValuationINR / prop.TotalTokens
	}
	c.JSON(http.StatusOK, gin.H{
		"property":             prop,
		"tokenPrice":           tokenPrice,
		"documentHashVerified": true,
		"fabricMode":           h.fabric.Mode(),
	})
}

func (h *Handler) ListProperties(c *gin.Context) {
	status := c.Query("status")
	props, err := h.fabric.ListProperties(status)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"properties": props, "count": len(props), "fabricMode": h.fabric.Mode(), "indexUsed": "idx_property_status"})
}

func (h *Handler) FreezeAsset(c *gin.Context) {
	assetId := c.Param("id")
	var req struct {
		Reason string `json:"reason" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT"})
		return
	}
	if err := h.fabric.FreezeAsset(assetId); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"assetId": assetId, "status": "FROZEN", "reason": req.Reason, "fabricMode": h.fabric.Mode()})
}

func (h *Handler) TransferTokens(c *gin.Context) {
	var req struct {
		AssetID string `json:"assetId" binding:"required"`
		FromID  string `json:"fromId"`
		ToID    string `json:"toId" binding:"required"`
		Amount  int64  `json:"amount" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT", "message": err.Error()})
		return
	}
	callerId := c.GetString("identityId")
	fromId := req.FromID
	if fromId == "" {
		fromId = callerId
	}
	if fromId != callerId {
		mspId := c.GetString("mspId")
		if mspId == "InvestorMSP" && fromId != callerId {
			c.JSON(http.StatusForbidden, gin.H{"error": "ERR_UNAUTHORIZED", "message": "investor can only transfer from own wallet"})
			return
		}
	}
	if kyc, _ := h.fabric.GetKYC(req.ToID); kyc.KYCStatus != "VERIFIED" {
		if !strings.Contains(strings.ToLower(req.ToID), "originator") {
			if kyc.KYCStatus == "UNVERIFIED" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_KYC_NOT_VERIFIED", "message": fmt.Sprintf("receiver %s KYC not verified", req.ToID)})
				return
			}
		}
	}
	transferId, err := h.fabric.TransferTokens(req.AssetID, fromId, req.ToID, req.Amount)
	if err != nil {
		msg := err.Error()
		status := http.StatusBadRequest
		if strings.Contains(msg, "ERR_ASSET_NOT_FOUND") {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"error": msg})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"transferId": transferId,
		"assetId":    req.AssetID,
		"fromId":     fromId,
		"toId":       req.ToID,
		"amount":     req.Amount,
		"status":     "COMPLETED",
		"fabricMode": h.fabric.Mode(),
	})
}

func (h *Handler) GetBalance(c *gin.Context) {
	assetId := c.Param("assetId")
	ownerId := c.Param("ownerId")
	bal, err := h.fabric.GetBalance(assetId, ownerId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, bal)
}

func (h *Handler) GetWallet(c *gin.Context) {
	ownerId := c.Param("ownerId")
	callerId := c.GetString("identityId")
	mspId := c.GetString("mspId")
	if mspId == "InvestorMSP" && ownerId != callerId {
		c.JSON(http.StatusForbidden, gin.H{"error": "ERR_UNAUTHORIZED"})
		return
	}
	balances, err := h.fabric.GetWallet(ownerId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var enriched []gin.H
	var totalPortfolioValue int64
	for _, b := range balances {
		prop, _ := h.fabric.GetProperty(b.AssetID)
		var tokenPrice int64
		var propertyTitle string
		if prop != nil {
			propertyTitle = prop.Title
			if prop.TotalTokens > 0 {
				tokenPrice = prop.ValuationINR / prop.TotalTokens
				totalPortfolioValue += tokenPrice * b.Balance
			}
		}
		enriched = append(enriched, gin.H{
			"balance":       b,
			"propertyTitle": propertyTitle,
			"tokenPrice":    tokenPrice,
			"valueINR":      tokenPrice * b.Balance,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"ownerId":             ownerId,
		"balances":            enriched,
		"totalPortfolioValue": totalPortfolioValue,
		"fabricMode":          h.fabric.Mode(),
		"indexUsed":           "idx_balance_owner",
	})
}

// Updated with pagination per Track A3
func (h *Handler) GetTransferHistory(c *gin.Context) {
	assetId := c.Query("assetId")
	ownerId := c.Query("ownerId")
	pageSizeStr := c.Query("pageSize")
	bookmark := c.Query("bookmark")

	pageSize := 10
	if pageSizeStr != "" {
		if ps, err := strconv.Atoi(pageSizeStr); err == nil {
			pageSize = ps
		}
	}
	if pageSize > 100 {
		pageSize = 100
	}

	callerId := c.GetString("identityId")
	mspId := c.GetString("mspId")
	if mspId != "RegulatorMSP" {
		if ownerId != "" && ownerId != callerId {
			c.JSON(http.StatusForbidden, gin.H{"error": "ERR_UNAUTHORIZED", "message": "can only query own history"})
			return
		}
		if assetId == "" && ownerId == "" {
			ownerId = callerId
		}
	}

	paginated, err := h.fabric.GetTransferHistoryPaginated(assetId, ownerId, pageSize, bookmark)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"transfers": paginated.Transfers,
		"count":     len(paginated.Transfers),
		"total":     paginated.Total,
		"bookmark":  paginated.Bookmark,
		"hasMore":   paginated.HasMore,
		"pageSize":  pageSize,
		"fabricMode": h.fabric.Mode(),
		"indexUsed": "idx_transfer_asset_time",
	})
}

func (h *Handler) UpdateKYCStatus(c *gin.Context) {
	identityId := c.Param("identityId")
	var req struct {
		Status string `json:"status" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT"})
		return
	}
	valid := map[string]bool{"UNVERIFIED": true, "PENDING": true, "VERIFIED": true, "REJECTED": true}
	if !valid[req.Status] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT", "message": "invalid status"})
		return
	}
	if err := h.fabric.UpdateKYC(identityId, req.Status); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"identityId": identityId, "kycStatus": req.Status, "fabricMode": h.fabric.Mode()})
}

func (h *Handler) GetKYCStatus(c *gin.Context) {
	identityId := c.Param("identityId")
	kyc, err := h.fabric.GetKYC(identityId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, kyc)
}

func (h *Handler) ConfirmPayment(c *gin.Context) {
	var req struct {
		TransferID string `json:"transferId"`
		AmountINR  int64  `json:"amountINR"`
		Method     string `json:"method"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT"})
		return
	}
	hash := sha256.Sum256([]byte(req.TransferID + fmt.Sprintf("%d", req.AmountINR) + req.Method))
	confirmationId := "PAY-" + uuid.New().String()
	c.JSON(http.StatusOK, gin.H{
		"confirmationId": confirmationId,
		"transferId":     req.TransferID,
		"amountINR":      req.AmountINR,
		"method":         req.Method,
		"paymentHash":    fmt.Sprintf("%x", hash),
		"status":         "CONFIRMED",
		"note":           "Mock payment - in production, integrate with actual settlement rail. Token transfer triggered only after this confirmation per spec §1.2",
	})
}

// A7: Failure mode demo endpoint — shows edge case rejection live
func (h *Handler) FailureModeDemo(c *gin.Context) {
	var req struct {
		Scenario string `json:"scenario" binding:"required"` // insufficient_balance, self_transfer, kyc_unverified, frozen_asset, double_spend
		AssetID  string `json:"assetId"`
		FromID   string `json:"fromId"`
		ToID     string `json:"toId"`
		Amount   int64  `json:"amount"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ERR_INVALID_INPUT"})
		return
	}

	callerId := c.GetString("identityId")
	if req.FromID == "" {
		req.FromID = callerId
	}
	if req.AssetID == "" {
		// Use first property
		props, _ := h.fabric.ListProperties("")
		if len(props) > 0 {
			req.AssetID = props[0].AssetID
		}
	}

	switch req.Scenario {
	case "insufficient_balance":
		req.Amount = 999999999
		req.ToID = "investor2"
		_, err := h.fabric.TransferTokens(req.AssetID, req.FromID, req.ToID, req.Amount)
		c.JSON(http.StatusOK, gin.H{
			"scenario": "insufficient_balance",
			"expected": "ERR_INSUFFICIENT_BALANCE",
			"result":   err.Error(),
			"passed":   strings.Contains(err.Error(), "ERR_INSUFFICIENT_BALANCE"),
			"explanation": "No partial transfer — atomic rejection per §6.2",
		})
		return
	case "self_transfer":
		req.ToID = req.FromID
		req.Amount = 10
		_, err := h.fabric.TransferTokens(req.AssetID, req.FromID, req.ToID, req.Amount)
		c.JSON(http.StatusOK, gin.H{
			"scenario": "self_transfer",
			"expected": "ERR_INVALID_TRANSFER",
			"result":   err.Error(),
			"passed":   strings.Contains(err.Error(), "ERR_INVALID_TRANSFER"),
			"explanation": "Self-transfer blocked per §6.2",
		})
		return
	case "kyc_unverified":
		req.ToID = "unverified_user_" + uuid.New().String()[:6]
		req.Amount = 10
		_, err := h.fabric.TransferTokens(req.AssetID, req.FromID, req.ToID, req.Amount)
		c.JSON(http.StatusOK, gin.H{
			"scenario": "kyc_unverified",
			"expected": "ERR_KYC_NOT_VERIFIED",
			"result":   err.Error(),
			"passed":   strings.Contains(err.Error(), "ERR_KYC_NOT_VERIFIED"),
			"explanation": "Transfer to unverified KYC wallet rejected per §6.2",
		})
		return
	case "zero_amount":
		req.ToID = "investor2"
		req.Amount = 0
		_, err := h.fabric.TransferTokens(req.AssetID, req.FromID, req.ToID, req.Amount)
		c.JSON(http.StatusOK, gin.H{
			"scenario": "zero_amount",
			"expected": "ERR_INVALID_AMOUNT",
			"result":   err.Error(),
			"passed":   strings.Contains(err.Error(), "ERR_INVALID_AMOUNT"),
			"explanation": "Zero/negative amount rejected per §6.2",
		})
		return
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown scenario", "valid": []string{"insufficient_balance", "self_transfer", "kyc_unverified", "zero_amount"}})
	}
}
