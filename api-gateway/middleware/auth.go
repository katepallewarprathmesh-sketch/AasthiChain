package middleware

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

var jwtSecret = []byte("aasthichain-hackathon-secret-key-change-in-prod")

// role mapping for Clerk + X-Fabric-Identity header
var clerkRoleMap = map[string]struct {
	IdentityId string
	MspId      string
	Role       string
}{
	"originator1": {IdentityId: "originator1", MspId: "OriginatorMSP", Role: "Originator"},
	"registrar1":  {IdentityId: "registrar1", MspId: "RegistrarMSP", Role: "Registrar"},
	"investor1":   {IdentityId: "investor1", MspId: "InvestorMSP", Role: "Investor"},
	"investor2":   {IdentityId: "investor2", MspId: "InvestorMSP", Role: "Investor"},
	"regulator1":  {IdentityId: "regulator1", MspId: "RegulatorMSP", Role: "Regulator"},
}

func tryDecodeClerkToken(tokenString string) (identityId, mspId, role string, isClerk bool) {
	// Try to decode as JWT without verification to detect Clerk
	parts := strings.Split(tokenString, ".")
	if len(parts) != 3 {
		return "", "", "", false
	}
	// Decode payload
	payloadB64 := parts[1]
	// Add padding if needed
	if m := len(payloadB64) % 4; m != 0 {
		payloadB64 += strings.Repeat("=", 4-m)
	}
	payloadB64 = strings.ReplaceAll(payloadB64, "-", "+")
	payloadB64 = strings.ReplaceAll(payloadB64, "_", "/")

	decoded, err := base64.StdEncoding.DecodeString(payloadB64)
	if err != nil {
		return "", "", "", false
	}
	var claims map[string]interface{}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return "", "", "", false
	}

	// Check if it's a Clerk token (has sub, iss containing clerk, or azp)
	_, hasSub := claims["sub"]
	iss, hasIss := claims["iss"].(string)
	isClerkToken := hasSub && (hasIss && (strings.Contains(iss, "clerk") || strings.Contains(iss, "clerk.dev") || strings.Contains(iss, "clerk.com")))

	// Also treat any JWT that fails our HS256 but has sub as potential Clerk for demo
	if hasSub && !isClerkToken {
		// If token has fabric claims, use them
		if id, ok := claims["identityId"].(string); ok {
			msp, _ := claims["mspId"].(string)
			r, _ := claims["role"].(string)
			return id, msp, r, true
		}
		// Generic Clerk token - will be mapped via X-Fabric-Identity header
		return "", "", "", true
	}

	if isClerkToken {
		// Try custom claims if present
		if id, ok := claims["identityId"].(string); ok {
			msp, _ := claims["mspId"].(string)
			r, _ := claims["role"].(string)
			return id, msp, r, true
		}
		if fid, ok := claims["fabricIdentity"].(string); ok {
			if mapped, exists := clerkRoleMap[strings.ToLower(fid)]; exists {
				return mapped.IdentityId, mapped.MspId, mapped.Role, true
			}
		}
		return "", "", "", true
	}

	return "", "", "", false
}

func JWTAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "ERR_UNAUTHORIZED", "message": "Authorization header required"})
			c.Abort()
			return
		}

		parts := strings.Split(authHeader, " ")
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "ERR_UNAUTHORIZED", "message": "Bearer token required"})
			c.Abort()
			return
		}

		tokenString := parts[1]

		// First try our own HS256 JWT
		token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
			return jwtSecret, nil
		}, jwt.WithValidMethods([]string{"HS256"}))

		if err == nil && token.Valid {
			claims, ok := token.Claims.(jwt.MapClaims)
			if ok {
				identityId, _ := claims["identityId"].(string)
				mspId, _ := claims["mspId"].(string)
				role, _ := claims["role"].(string)
				c.Set("identityId", identityId)
				c.Set("mspId", mspId)
				c.Set("role", role)
				c.Next()
				return
			}
		}

		// Try Clerk token path
		if id, msp, r, isClerk := tryDecodeClerkToken(tokenString); isClerk {
			// If we got identity from token itself, use it
			if id != "" {
				c.Set("identityId", id)
				c.Set("mspId", msp)
				c.Set("role", r)
				c.Set("clerk", true)
				c.Next()
				return
			}
			// Otherwise use X-Fabric-Identity header for demo role mapping
			fabricHeader := c.GetHeader("X-Fabric-Identity")
			if fabricHeader == "" {
				fabricHeader = "investor1"
			}
			lower := strings.ToLower(fabricHeader)
			if mapped, exists := clerkRoleMap[lower]; exists {
				c.Set("identityId", mapped.IdentityId)
				c.Set("mspId", mapped.MspId)
				c.Set("role", mapped.Role)
				c.Set("clerk", true)
				c.Set("clerkToken", tokenString)
				c.Next()
				return
			}
			// Fallback to investor1 for any Clerk token
			c.Set("identityId", "investor1")
			c.Set("mspId", "InvestorMSP")
			c.Set("role", "Investor")
			c.Set("clerk", true)
			c.Next()
			return
		}

		// Try mock base64 token (legacy fallback)
		if decoded, err := base64.StdEncoding.DecodeString(tokenString); err == nil {
			var mockClaims map[string]interface{}
			if err := json.Unmarshal(decoded, &mockClaims); err == nil {
				if id, ok := mockClaims["identityId"].(string); ok {
					msp, _ := mockClaims["mspId"].(string)
					role, _ := mockClaims["role"].(string)
					c.Set("identityId", id)
					c.Set("mspId", msp)
					c.Set("role", role)
					c.Next()
					return
				}
			}
		}

		// Last resort: check X-Fabric-Identity header for mock mode
		fabricHeader := c.GetHeader("X-Fabric-Identity")
		if fabricHeader != "" {
			if mapped, exists := clerkRoleMap[strings.ToLower(fabricHeader)]; exists {
				c.Set("identityId", mapped.IdentityId)
				c.Set("mspId", mapped.MspId)
				c.Set("role", mapped.Role)
				c.Next()
				return
			}
		}

		c.JSON(http.StatusUnauthorized, gin.H{"error": "ERR_UNAUTHORIZED", "message": "invalid token - set VITE_CLERK_PUBLISHABLE_KEY or use mock login"})
		c.Abort()
		return
	}
}

func RequireMSP(allowed []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		mspId := c.GetString("mspId")
		for _, a := range allowed {
			if mspId == a {
				c.Next()
				return
			}
		}
		c.JSON(http.StatusForbidden, gin.H{"error": "ERR_UNAUTHORIZED", "message": "MSP not authorized for this operation"})
		c.Abort()
	}
}

func RateLimiter(limitPerMinute int) gin.HandlerFunc {
	type clientInfo struct {
		count     int
		windowEnd time.Time
	}
	clients := make(map[string]*clientInfo)

	return func(c *gin.Context) {
		identityId := c.GetString("identityId")
		if identityId == "" {
			identityId = c.ClientIP()
		}

		now := time.Now()
		info, exists := clients[identityId]
		if !exists || now.After(info.windowEnd) {
			clients[identityId] = &clientInfo{count: 1, windowEnd: now.Add(time.Minute)}
		} else {
			info.count++
			if info.count > limitPerMinute {
				c.JSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded", "limit": limitPerMinute})
				c.Abort()
				return
			}
		}
		c.Next()
	}
}

func AuditLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		latency := time.Since(start)
		identityId := c.GetString("identityId")
		mspId := c.GetString("mspId")
		_ = latency
		_ = identityId
		_ = mspId
	}
}
