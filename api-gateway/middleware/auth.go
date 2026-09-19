package middleware

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

var jwtSecret = []byte("aasthichain-hackathon-secret-key-change-in-prod")

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
		token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
			return jwtSecret, nil
		}, jwt.WithValidMethods([]string{"HS256"}))

		if err != nil || !token.Valid {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "ERR_UNAUTHORIZED", "message": "invalid token"})
			c.Abort()
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "ERR_UNAUTHORIZED"})
			c.Abort()
			return
		}

		identityId, _ := claims["identityId"].(string)
		mspId, _ := claims["mspId"].(string)
		role, _ := claims["role"].(string)

		c.Set("identityId", identityId)
		c.Set("mspId", mspId)
		c.Set("role", role)
		c.Next()
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
	// Simple in-memory rate limiter for hackathon
	// In production: Redis-based sliding window
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
		// In production: structured logging to ELK / Prometheus
		// For demo: print to stdout
		// log.Printf("[AUDIT] %s %s | %d | %s | %s | %s | %v", c.Request.Method, c.Request.URL.Path, c.Writer.Status(), identityId, mspId, c.GetHeader("X-Idempotency-Key"), latency)
		_ = latency
		_ = identityId
		_ = mspId
	}
}
