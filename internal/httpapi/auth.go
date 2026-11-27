package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/model"
	"github.com/thatmyassets/tma-dashboard/internal/store"
	"golang.org/x/crypto/bcrypt"
)

const sessionCookie = "tma_admin_session"

func randomToken(prefix string) string {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value[:])
}

func bearerToken(r *http.Request) string {
	parts := strings.Split(r.Header.Get("Authorization"), " ")
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

func (s *Server) validAdminToken(token string) bool {
	if s.cfg.AdminAPIToken == "" || token == "" {
		return false
	}
	expected := sha256.Sum256([]byte(s.cfg.AdminAPIToken))
	actual := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(expected[:], actual[:]) == 1
}

type adminIdentity struct {
	username, sessionHash string
	bearer                bool
}

func (s *Server) admin(r *http.Request) (adminIdentity, bool) {
	if s.validAdminToken(bearerToken(r)) {
		return adminIdentity{username: "api", bearer: true}, true
	}
	cookie, err := r.Cookie(sessionCookie)
	if err != nil || cookie.Value == "" {
		return adminIdentity{}, false
	}
	username, err := s.store.Session(r.Context(), model.TokenHash(cookie.Value))
	if err != nil {
		return adminIdentity{}, false
	}
	return adminIdentity{username: username, sessionHash: cookie.Value}, true
}

func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, ok := s.admin(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Admin authentication is required")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !s.validOrigin(r, identity.bearer) {
			writeError(w, http.StatusForbidden, "origin_rejected", "Request origin is not allowed")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), adminKey{}, identity)))
	}
}

type adminKey struct{}

func (s *Server) validOrigin(r *http.Request, automation bool) bool {
	origin := r.Header.Get("Origin")
	if origin != "" && s.cfg.AllowAllOrigins {
		return true
	}
	if origin == "" {
		return automation
	}
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	normalized := strings.ToLower(u.Scheme + "://" + u.Host)
	if len(s.cfg.AllowedOrigins) > 0 {
		return s.cfg.AllowedOrigins[normalized]
	}
	if !strings.EqualFold(u.Host, r.Host) {
		return false
	}
	if s.cfg.SecureCookies && u.Scheme != "https" {
		return false
	}
	return true
}

func (s *Server) device(r *http.Request) (model.Device, bool) {
	token := bearerToken(r)
	if token == "" || s.validAdminToken(token) {
		return model.Device{}, false
	}
	device, err := s.store.DeviceByToken(r.Context(), model.TokenHash(token))
	if err != nil {
		return model.Device{}, false
	}
	return device, true
}

func (s *Server) requireDevice(next func(http.ResponseWriter, *http.Request, model.Device)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		device, ok := s.device(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized", "A valid, active device token is required")
			return
		}
		next(w, r, device)
	}
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.validOrigin(r, false) {
		writeError(w, http.StatusForbidden, "origin_rejected", "Request origin is not allowed")
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Username = strings.ToLower(strings.TrimSpace(input.Username))
	if input.Username == "" || len(input.Username) > 254 || input.Password == "" || len(input.Password) > 72 {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Username or password is incorrect")
		return
	}
	hash, err := s.store.PasswordHash(r.Context(), input.Username)
	if errors.Is(err, store.ErrInvalidCredentials) {
		hash = s.dummyPasswordHash
	} else if err != nil {
		writeError(w, 500, "internal_error", "Could not sign in")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Username or password is incorrect")
		return
	}
	token := randomToken("tma_s_")
	expires := time.Now().UTC().Add(s.cfg.SessionTTL)
	if err := s.store.CreateSession(r.Context(), model.TokenHash(token), input.Username, expires); err != nil {
		writeError(w, 500, "internal_error", "Could not create session")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: int(s.cfg.SessionTTL.Seconds()), Expires: expires})
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "username": input.Username, "expires_at": expires})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	identity := r.Context().Value(adminKey{}).(adminIdentity)
	if identity.sessionHash != "" {
		_ = s.store.DeleteSession(r.Context(), model.TokenHash(identity.sessionHash))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: -1, Expires: time.Unix(0, 0)})
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": false})
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.admin(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Admin authentication is required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "username": identity.username})
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if first, _, ok := strings.Cut(r.Header.Get("X-Forwarded-For"), ","); ok {
			if ip := model.ParseIP(first); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		if ip := model.ParseIP(host); ip != "" {
			return ip
		}
	}
	return model.ParseIP(r.RemoteAddr)
}
