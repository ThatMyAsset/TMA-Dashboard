package httpapi

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/model"
	"github.com/thatmyassets/tma-dashboard/internal/store"
)

func (s *Server) pairingCipher() (cipher.AEAD, error) {
	key, err := base64.RawURLEncoding.DecodeString(s.cfg.PairingCodeKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("PAIRING_CODE_KEY must be a 32-byte base64url secret")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (s *Server) sealPairingCode(code string) ([]byte, error) {
	aead, err := s.pairingCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return append(nonce, aead.Seal(nil, nonce, []byte(code), nil)...), nil
}
func (s *Server) openPairingCode(value []byte) (string, error) {
	aead, err := s.pairingCipher()
	if err != nil {
		return "", err
	}
	if len(value) < aead.NonceSize() {
		return "", errors.New("invalid pairing ciphertext")
	}
	plain, err := aead.Open(nil, value[:aead.NonceSize()], value[aead.NonceSize():], nil)
	return string(plain), err
}

func (s *Server) listPairingCodes(w http.ResponseWriter, r *http.Request) {
	codes, err := s.store.ListActivePairingCodes(r.Context())
	if err != nil {
		writeError(w, 500, "internal_error", "Could not load active pairing codes")
		return
	}
	for i := range codes {
		codes[i].Code, err = s.openPairingCode(codes[i].Ciphertext)
		if err != nil {
			writeError(w, 500, "internal_error", "Could not decrypt active pairing codes; verify PAIRING_CODE_KEY is unchanged")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"pairing_codes": codes})
}
func (s *Server) revokePairingCode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !model.UUID(id) {
		writeError(w, 400, "invalid_pairing_code_id", "Pairing code ID must be a UUID")
		return
	}
	if err := s.store.RevokePairingCode(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, 404, "pairing_code_not_found", "Active pairing code was not found")
			return
		}
		writeError(w, 500, "internal_error", "Could not revoke pairing code")
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "revoked": true})
}

func (s *Server) createPairingCode(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TTLHours int `json:"ttl_hours"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.TTLHours < 1 || input.TTLHours > 24 {
		writeError(w, http.StatusBadRequest, "invalid_ttl", "ttl_hours must be an integer between 1 and 24")
		return
	}
	code := randomToken("tma_pair_")
	ciphertext, err := s.sealPairingCode(code)
	if err != nil {
		writeError(w, 500, "internal_error", "Could not protect pairing code for display")
		return
	}
	expires := utcNow().Add(time.Duration(input.TTLHours) * time.Hour)
	if err := s.store.CreatePairingCode(r.Context(), model.TokenHash(code), ciphertext, expires); err != nil {
		writeError(w, 500, "internal_error", "Could not create pairing code")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"code": code, "expires_at": expires})
}

func (s *Server) enroll(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Code         string `json:"code"`
		Hostname     string `json:"hostname"`
		OS           string `json:"os"`
		AgentVersion string `json:"agent_version"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Hostname = strings.TrimSpace(input.Hostname)
	input.OS = strings.TrimSpace(input.OS)
	input.AgentVersion = strings.TrimSpace(input.AgentVersion)
	if !strings.HasPrefix(input.Code, "tma_pair_") || len(input.Code) < 52 || len(input.Code) > 64 {
		writeError(w, http.StatusUnauthorized, "invalid_pairing_code", "Pairing code is invalid, expired, or already used")
		return
	}
	for field, value := range map[string]string{"hostname": input.Hostname, "os": input.OS, "agent_version": input.AgentVersion} {
		if err := model.ValidateText(value, field, 120); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_enrollment", err.Error())
			return
		}
	}
	policy, err := s.store.LatestPolicy(r.Context())
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "policy_unavailable", "No policy is available for enrollment")
		return
	}
	if err != nil {
		writeError(w, 500, "internal_error", "Could not load enrollment policy")
		return
	}
	token := randomToken("tma_device_")
	deviceID, err := s.store.Enroll(r.Context(), model.TokenHash(input.Code), model.TokenHash(token), input.Hostname, input.OS, input.AgentVersion, &policy.Version)
	if errors.Is(err, store.ErrInvalidCredentials) {
		writeError(w, http.StatusUnauthorized, "invalid_pairing_code", "Pairing code is invalid, expired, or already used")
		return
	}
	if err != nil {
		writeError(w, 500, "internal_error", "Could not enroll device")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"device_id": deviceID, "device_token": token, "policy_version": policy.Version})
}

func (s *Server) agentPolicies(w http.ResponseWriter, r *http.Request, device model.Device) {
	if device.RevokedAt != nil {
		writeError(w, http.StatusForbidden, "device_revoked", "Device has been revoked")
		return
	}
	if device.PolicyVersion == nil {
		writeError(w, http.StatusConflict, "policy_unassigned", "No policy is assigned to this device")
		return
	}
	policy, err := s.store.PolicyByVersion(r.Context(), *device.PolicyVersion)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "policy_unavailable", "The assigned policy is unavailable")
			return
		}
		writeError(w, 500, "internal_error", "Could not load policy")
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request, device model.Device) {
	var input struct {
		AgentVersion          string `json:"agent_version"`
		Status                string `json:"status"`
		InspectionEngineReady bool   `json:"inspection_engine_ready"`
		BrowserConnected      bool   `json:"browser_connected"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.AgentVersion = strings.TrimSpace(input.AgentVersion)
	if err := model.ValidateText(input.AgentVersion, "agent_version", 120); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_heartbeat", err.Error())
		return
	}
	if !validAgentStatus(input.Status) {
		writeError(w, http.StatusBadRequest, "invalid_status", "status must be pending_enrollment, limited, protected, or degraded")
		return
	}
	if input.Status == "protected" && (!input.InspectionEngineReady || !input.BrowserConnected) {
		writeError(w, http.StatusBadRequest, "readiness_conflict", "Protected status requires both inspection engine and browser readiness")
		return
	}
	if input.Status == "pending_enrollment" {
		writeError(w, http.StatusBadRequest, "invalid_status", "An enrolled device cannot return to pending_enrollment")
		return
	}
	if err := s.store.Heartbeat(r.Context(), device.ID, input.AgentVersion, input.Status, input.InspectionEngineReady, input.BrowserConnected, ""); err != nil {
		writeError(w, 500, "internal_error", "Could not record heartbeat")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"policy_version": device.PolicyVersion, "server_time": utcNow()})
}

func validAgentStatus(status string) bool {
	return status == "pending_enrollment" || status == "limited" || status == "protected" || status == "degraded"
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := s.store.ListDevices(r.Context())
	if err != nil {
		writeError(w, 500, "internal_error", "Could not load devices")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !model.UUID(id) {
		writeError(w, http.StatusBadRequest, "invalid_device_id", "Device ID must be a UUID")
		return
	}
	err := s.store.RevokeDevice(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "device_not_found", "Active device was not found")
		return
	}
	if err != nil {
		writeError(w, 500, "internal_error", "Could not revoke device")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "revoked": true})
}

func (s *Server) assignDevicePolicy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !model.UUID(id) {
		writeError(w, http.StatusBadRequest, "invalid_device_id", "Device ID must be a UUID")
		return
	}
	var input struct {
		PolicyVersion string `json:"policy_version"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if !model.UUID(input.PolicyVersion) {
		writeError(w, http.StatusBadRequest, "invalid_policy_version", "Policy version must be a UUID")
		return
	}
	if err := s.store.AssignDevicePolicy(r.Context(), id, input.PolicyVersion); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "assignment_target_not_found", "Active device or policy was not found")
			return
		}
		writeError(w, 500, "internal_error", "Could not assign policy")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device_id": id, "policy_version": input.PolicyVersion})
}

func parseLimit(value string) (int, bool) {
	if value == "" {
		return 50, true
	}
	limit, err := strconv.Atoi(value)
	return limit, err == nil && limit >= 1 && limit <= 200
}
