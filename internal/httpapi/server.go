package httpapi

import (
	"encoding/base64"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/model"
	"golang.org/x/crypto/bcrypt"
)

type Store interface {
	Ping(context.Context) error
	PasswordHash(context.Context, string) (string, error)
	CreateSession(context.Context, []byte, string, time.Time) error
	Session(context.Context, []byte) (string, error)
	DeleteSession(context.Context, []byte) error
	CreatePairingCode(context.Context, []byte, []byte, time.Time) error
	ListActivePairingCodes(context.Context) ([]model.PairingCode, error)
	RevokePairingCode(context.Context, string) error
	Enroll(context.Context, []byte, []byte, string, string, string, *string) (string, error)
	DeviceByToken(context.Context, []byte) (model.Device, error)
	Heartbeat(context.Context, string, string, string, bool, bool, string) error
	ListDevices(context.Context) ([]model.Device, error)
	RevokeDevice(context.Context, string) error
	AssignDevicePolicy(context.Context, string, string) error
	LatestPolicy(context.Context) (model.Policy, error)
	PolicyByVersion(context.Context, string) (model.Policy, error)
	CreatePolicy(context.Context, model.Policy) error
	ListPolicies(context.Context) ([]model.Policy, error)
	DeletePolicy(context.Context, string) error
	InsertEvent(context.Context, string, model.Event) error
	ListEvents(context.Context, model.EventFilters) ([]model.Event, error)
	Overview(context.Context) (model.Overview, error)
}

type Server struct {
	store             Store
	cfg               Config
	dummyPasswordHash string
	loginLimiter      *rateLimiter
	enrollLimiter     *rateLimiter
	ingestLimiter     *rateLimiter
}

func NewServer(storage Store, cfg Config) (*Server, error) {
	if storage == nil {
		return nil, errors.New("store is required")
	}
	if cfg.PairingCodeKey == "" {
		cfg.PairingCodeKey = base64.RawURLEncoding.EncodeToString(model.TokenHash(cfg.AdminPassword))
	}
	dummy, err := bcrypt.GenerateFromPassword([]byte("not-a-valid-admin-password"), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	return &Server{store: storage, cfg: cfg, dummyPasswordHash: string(dummy), loginLimiter: newRateLimiter(10, time.Minute), enrollLimiter: newRateLimiter(20, time.Minute), ingestLimiter: newRateLimiter(120, time.Minute)}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.store.Ping(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "database_unavailable", "Database readiness check failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /api/v1/auth/login", s.rateLimit(s.loginLimiter, s.login))
	mux.HandleFunc("POST /api/v1/auth/logout", s.requireAdmin(s.logout))
	mux.HandleFunc("GET /api/v1/auth/session", s.session)
	mux.HandleFunc("POST /api/v1/pairing-codes", s.requireAdmin(s.createPairingCode))
	mux.HandleFunc("GET /api/v1/pairing-codes", s.requireAdmin(s.listPairingCodes))
	mux.HandleFunc("DELETE /api/v1/pairing-codes/{id}", s.requireAdmin(s.revokePairingCode))
	mux.HandleFunc("POST /api/v1/agents/enroll", s.rateLimit(s.enrollLimiter, s.enroll))
	mux.HandleFunc("GET /api/v1/agent/policies", s.requireDevice(s.agentPolicies))
	mux.HandleFunc("POST /api/v1/agent/heartbeat", s.requireDevice(s.heartbeat))
	mux.HandleFunc("POST /api/v1/events", s.rateLimit(s.ingestLimiter, s.requireDevice(s.ingestEvent)))
	mux.HandleFunc("GET /api/v1/devices", s.requireAdmin(s.listDevices))
	mux.HandleFunc("POST /api/v1/devices/{id}/revoke", s.requireAdmin(s.revokeDevice))
	mux.HandleFunc("PUT /api/v1/devices/{id}/policy", s.requireAdmin(s.assignDevicePolicy))
	mux.HandleFunc("GET /api/v1/events", s.requireAdmin(s.listEvents))
	mux.HandleFunc("GET /api/v1/overview", s.requireAdmin(s.overview))
	mux.HandleFunc("GET /api/v1/policies", s.requireAdmin(s.listPolicies))
	mux.HandleFunc("POST /api/v1/policies", s.requireAdmin(s.createPolicy))
	mux.HandleFunc("DELETE /api/v1/policies/{version}", s.requireAdmin(s.deletePolicy))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "API endpoint not found")
	})
	return securityHeaders(recoverPanics(logRequests(mux)))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}
func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("request panic", "error", recovered)
				writeError(w, 500, "internal_error", "Internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(start).Milliseconds())
	})
}

func HashAdminPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	return string(hash), err
}
