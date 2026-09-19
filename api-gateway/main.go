package main

import (
	"log"
	"net/http"
	"os"

	"github.com/aasthichain/api-gateway/fabric"
	"github.com/aasthichain/api-gateway/handlers"
	"github.com/aasthichain/api-gateway/middleware"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Track A1: Factory toggles via FABRIC_MODE env var — live or mock with same interface
	// Live mode tries real Fabric Gateway SDK, falls back to mock for demo resilience
	fabricClient := fabric.NewFabricClient()

	h := handlers.NewHandler(fabricClient)

	r := gin.Default()

	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"http://localhost:5173", "http://localhost:3000", "*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization", "X-Idempotency-Key"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":     "ok",
			"service":    "aasthichain-api-gateway",
			"version":    "1.1",
			"fabricMode": fabricClient.Mode(),
			"tracks":     "A1 live/mock toggle, A3 pagination, A4 persistent idempotency, A7 failure demo",
		})
	})

	r.POST("/api/auth/login", h.Login)

	api := r.Group("/api")
	api.Use(middleware.JWTAuth())
	api.Use(middleware.RateLimiter(100))
	api.Use(middleware.AuditLogger())

	api.POST("/properties", h.RegisterProperty)
	api.GET("/properties", h.ListProperties)
	api.GET("/properties/:id", h.GetPropertyDetails)
	api.POST("/properties/:id/validate", middleware.RequireMSP([]string{"RegistrarMSP"}), h.ValidateProperty)
	api.POST("/properties/:id/mint", middleware.RequireMSP([]string{"OriginatorMSP", "RegistrarMSP"}), h.MintPropertyTokens)
	api.POST("/properties/:id/freeze", middleware.RequireMSP([]string{"RegulatorMSP"}), h.FreezeAsset)

	api.POST("/transfers", h.TransferTokens)
	api.GET("/balances/:assetId/:ownerId", h.GetBalance)
	api.GET("/balances/wallet/:ownerId", h.GetWallet)
	api.GET("/transfers/history", h.GetTransferHistory)

	api.PUT("/kyc/:identityId", middleware.RequireMSP([]string{"RegistrarMSP", "RegulatorMSP"}), h.UpdateKYCStatus)
	api.GET("/kyc/:identityId", h.GetKYCStatus)

	api.POST("/payments/confirm", h.ConfirmPayment)

	// Track A7: Failure mode demo — live rejection of invalid transactions
	api.POST("/transfers/failure-demo", h.FailureModeDemo)

	log.Printf("AasthiChain API Gateway v1.1 listening on :%s | Fabric Mode: %s | Tracks A1-A7 implemented", port, fabricClient.Mode())
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
