package middleware

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// The first tests this module has ever had.
//
// It was the one Go module in the repository with no tests at all, and the
// reason given was that it is not on the demo path. That is exactly the
// condition under which an authentication bug survives: nobody exercises it,
// so nobody finds out that three of its four acceptance paths will hand a
// caller RegulatorMSP for the asking.
//
// These tests say what the middleware does, including the parts that are
// deliberately permissive, so that a future change to any of it has to be a
// decision rather than an accident.

func init() { gin.SetMode(gin.TestMode) }

// routerUnder builds a router with JWTAuth in front of a handler that simply
// reports the identity the middleware settled on.
func routerUnder(extra ...gin.HandlerFunc) *gin.Engine {
	r := gin.New()
	g := r.Group("/api")
	g.Use(JWTAuth())
	for _, h := range extra {
		g.Use(h)
	}
	g.GET("/who", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"identityId": c.GetString("identityId"),
			"mspId":      c.GetString("mspId"),
			"role":       c.GetString("role"),
			"clerk":      c.GetBool("clerk"),
		})
	})
	return r
}

func call(r *gin.Engine, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/who", nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func body(t *testing.T, w *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var out map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode body %q: %v", w.Body.String(), err)
	}
	return out
}

// signedToken is what this gateway's own /api/auth/login hands out.
func signedToken(t *testing.T, identity, msp, role string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"identityId": identity,
		"mspId":      msp,
		"role":       role,
		"exp":        time.Now().Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString(jwtSecret)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// unsignedToken is a well-formed JWT signed with a key we made up. It is what
// an attacker sends.
func unsignedToken(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte("not-the-gateways-key"))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func TestAuthRefusesWhatIsNotThere(t *testing.T) {
	r := routerUnder()

	for _, c := range []struct {
		name    string
		headers map[string]string
	}{
		{"no header at all", nil},
		{"no scheme", map[string]string{"Authorization": "abcdef"}},
		{"the wrong scheme", map[string]string{"Authorization": "Basic abcdef"}},
		{"bearer with nothing after it", map[string]string{"Authorization": "Bearer "}},
	} {
		w := call(r, c.headers)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s: expected 401, got %d (%s)", c.name, w.Code, w.Body.String())
		}
	}
}

func TestASignedTokenIsAccepted(t *testing.T) {
	r := routerUnder()
	w := call(r, map[string]string{
		"Authorization": "Bearer " + signedToken(t, "registrar1", "RegistrarMSP", "Registrar"),
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	got := body(t, w)
	if got["identityId"] != "registrar1" || got["mspId"] != "RegistrarMSP" || got["role"] != "Registrar" {
		t.Fatalf("claims did not survive the middleware: %v", got)
	}
	if got["clerk"] == true {
		t.Fatal("a token we signed ourselves must not be reported as a Clerk session")
	}
}

// The point of the demo gate. Unset, an unsigned identity is refused; set, it
// is honoured. Both halves are asserted, because a flag that does nothing is
// worse than no flag.
func TestUnsignedIdentitiesNeedTheDemoFlag(t *testing.T) {
	attack := "Bearer " + unsignedToken(t, jwt.MapClaims{
		"sub":        "anyone",
		"identityId": "regulator1",
		"mspId":      "RegulatorMSP",
		"role":       "Regulator",
	})

	t.Setenv("API_GATEWAY_DEMO_AUTH", "")
	r := routerUnder()
	w := call(r, map[string]string{"Authorization": attack})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("an unsigned RegulatorMSP claim must be refused by default, got %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "API_GATEWAY_DEMO_AUTH") {
		t.Fatalf("the refusal must say how to get the demo behaviour back: %s", w.Body.String())
	}

	t.Setenv("API_GATEWAY_DEMO_AUTH", "true")
	w = call(routerUnder(), map[string]string{"Authorization": attack})
	if w.Code != http.StatusOK {
		t.Fatalf("with the demo flag set the same token must be accepted, got %d (%s)", w.Code, w.Body.String())
	}
	if got := body(t, w); got["mspId"] != "RegulatorMSP" || got["clerk"] != true {
		t.Fatalf("demo mode should have taken the claim at face value and marked it: %v", got)
	}
}

func TestTheHeaderOnlyPathAlsoNeedsTheFlag(t *testing.T) {
	// A base64 blob of JSON, the legacy mock token.
	mock := base64.StdEncoding.EncodeToString([]byte(`{"identityId":"regulator1","mspId":"RegulatorMSP","role":"Regulator"}`))

	t.Setenv("API_GATEWAY_DEMO_AUTH", "")
	w := call(routerUnder(), map[string]string{
		"Authorization":     "Bearer " + mock,
		"X-Fabric-Identity": "regulator1",
	})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("a base64 self-declaration must be refused by default, got %d (%s)", w.Code, w.Body.String())
	}

	t.Setenv("API_GATEWAY_DEMO_AUTH", "true")
	w = call(routerUnder(), map[string]string{
		"Authorization":     "Bearer " + mock,
		"X-Fabric-Identity": "regulator1",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("demo mode should accept it, got %d (%s)", w.Code, w.Body.String())
	}
	if got := body(t, w); got["identityId"] != "regulator1" {
		t.Fatalf("the mock claim should have been read: %v", got)
	}
}

// An unknown identity in demo mode falls back to investor1, which is the
// least privileged of the five. Worth pinning: a fallback to anything else
// would be a silent escalation.
func TestTheDemoFallbackIsTheLeastPrivilegedIdentity(t *testing.T) {
	t.Setenv("API_GATEWAY_DEMO_AUTH", "true")
	tok := "Bearer " + unsignedToken(t, jwt.MapClaims{"sub": "someone", "iss": "https://x.clerk.com"})
	w := call(routerUnder(), map[string]string{
		"Authorization":     tok,
		"X-Fabric-Identity": "somebody-we-do-not-know",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	got := body(t, w)
	if got["identityId"] != "investor1" || got["mspId"] != "InvestorMSP" {
		t.Fatalf("an unknown identity must fall back to the least privileged one, got %v", got)
	}
}

func TestFabricIdentityIsCaseInsensitiveInDemoMode(t *testing.T) {
	t.Setenv("API_GATEWAY_DEMO_AUTH", "true")
	tok := "Bearer " + unsignedToken(t, jwt.MapClaims{"sub": "someone", "iss": "https://x.clerk.com"})
	w := call(routerUnder(), map[string]string{
		"Authorization":     tok,
		"X-Fabric-Identity": "REGISTRAR1",
	})
	if got := body(t, w); got["mspId"] != "RegistrarMSP" {
		t.Fatalf("identity lookup should be case insensitive, got %v", got)
	}
}

func TestRequireMSPLetsTheRightMSPThroughAndRefusesTheRest(t *testing.T) {
	run := func(msp string) int {
		r := gin.New()
		g := r.Group("/api")
		g.Use(func(c *gin.Context) { c.Set("mspId", msp); c.Next() })
		g.Use(RequireMSP([]string{"RegistrarMSP", "RegulatorMSP"}))
		g.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/x", nil))
		return w.Code
	}
	if code := run("RegistrarMSP"); code != http.StatusOK {
		t.Fatalf("RegistrarMSP should pass, got %d", code)
	}
	if code := run("RegulatorMSP"); code != http.StatusOK {
		t.Fatalf("RegulatorMSP should pass, got %d", code)
	}
	if code := run("InvestorMSP"); code != http.StatusForbidden {
		t.Fatalf("InvestorMSP should be refused with 403, got %d", code)
	}
	if code := run(""); code != http.StatusForbidden {
		t.Fatalf("an absent MSP must not pass, got %d", code)
	}
}

func TestRateLimiterCountsPerIdentityAndThenRefuses(t *testing.T) {
	r := gin.New()
	g := r.Group("/api")
	g.Use(func(c *gin.Context) { c.Set("identityId", c.GetHeader("X-Who")); c.Next() })
	g.Use(RateLimiter(3))
	g.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	hit := func(who string) int {
		req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
		req.Header.Set("X-Who", who)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code
	}

	for i := 1; i <= 3; i++ {
		if code := hit("a"); code != http.StatusOK {
			t.Fatalf("request %d should be inside the limit, got %d", i, code)
		}
	}
	if code := hit("a"); code != http.StatusTooManyRequests {
		t.Fatalf("the fourth request should be refused with 429, got %d", code)
	}
	// The limit is per caller, not global: a second identity starts fresh.
	if code := hit("b"); code != http.StatusOK {
		t.Fatalf("a different identity must have its own budget, got %d", code)
	}
}
