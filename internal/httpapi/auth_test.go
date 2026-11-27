package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/model"
	"github.com/thatmyassets/tma-dashboard/internal/store"
	"golang.org/x/crypto/bcrypt"
)

func testConfig() Config {
	return Config{AdminUsername: "admin", AdminPassword: "correct horse battery", SecureCookies: false, SessionTTL: time.Hour}
}

func loginRequest(password string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"username":"admin","password":"`+password+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://example.com")
	request.Host = "example.com"
	return request
}

func TestLoginSetsSessionCookie(t *testing.T) {
	memory := newMemoryStore()
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct horse battery"), bcrypt.MinCost)
	memory.passwordHash = string(hash)
	server, err := NewServer(memory, testConfig())
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, loginRequest("correct horse battery"))
	if response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
	cookie := response.Result().Cookies()[0]
	if cookie.Name != sessionCookie || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("unsafe cookie: %+v", cookie)
	}
	if cookie.Secure {
		t.Fatal("test configuration must not force secure cookies")
	}
	if len(memory.sessions) != 1 {
		t.Fatal("session was not persisted")
	}
}

func TestDevelopmentWildcardOrigin(t *testing.T) {
	memory := newMemoryStore()
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct horse battery"), bcrypt.MinCost)
	memory.passwordHash = string(hash)
	cfg := testConfig()
	cfg.AllowAllOrigins = true
	server, err := NewServer(memory, cfg)
	if err != nil {
		t.Fatal(err)
	}
	request := loginRequest("correct horse battery")
	request.Header.Set("Origin", "http://43.157.201.52:3000")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("development origin got %d: %s", response.Code, response.Body.String())
	}
}

func TestAdminOriginAndDeviceTokenSeparation(t *testing.T) {
	memory := newMemoryStore()
	server, _ := NewServer(memory, testConfig())
	handler := server.Handler()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/pairing-codes", bytes.NewBufferString(`{"ttl_hours":1}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://evil.invalid")
	memory.sessions[string(model.TokenHash("cookie"))] = "admin"
	request.AddCookie(&http.Cookie{Name: sessionCookie, Value: "cookie"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin admin mutation got %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/agent/policies", nil)
	request.Header.Set("Authorization", "Bearer cookie")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("admin cookie used as device token got %d", response.Code)
	}
}

func TestInvalidPasswordDoesNotCreateSession(t *testing.T) {
	memory := newMemoryStore()
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct horse battery"), bcrypt.MinCost)
	memory.passwordHash = string(hash)
	server, _ := NewServer(memory, testConfig())
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, loginRequest("wrong"))
	if response.Code != http.StatusUnauthorized || len(memory.sessions) != 0 {
		t.Fatal("invalid login created a session")
	}
}

func TestAdminBearerRequiresConfiguredToken(t *testing.T) {
	memory := newMemoryStore()
	cfg := testConfig()
	cfg.AdminAPIToken = "0123456789abcdef0123456789abcdef"
	server, _ := NewServer(memory, cfg)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/overview", nil)
	request.Header.Set("Authorization", "Bearer wrong")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d", response.Code)
	}
}

func TestExpiredSessionRejected(t *testing.T) {
	memory := newMemoryStore()
	memory.sessionErr = store.ErrInvalidCredentials
	server, _ := NewServer(memory, testConfig())
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookie, Value: "expired"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d", response.Code)
	}
}

func TestLoginRateLimit(t *testing.T) {
	limiter := newRateLimiter(2, time.Minute)
	now := time.Now()
	if !limiter.allow("client", now) || !limiter.allow("client", now) || limiter.allow("client", now) {
		t.Fatal("rate limit did not stop third request")
	}
	if !limiter.allow("client", now.Add(time.Minute)) {
		t.Fatal("rate limit did not reset")
	}
}
