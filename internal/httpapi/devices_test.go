package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/model"
	"github.com/thatmyassets/tma-dashboard/internal/store"
)

func enrollmentRequest() *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/agents/enroll", bytes.NewBufferString(`{"code":"tma_pair_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ123456","hostname":"workstation-01","os":"windows","agent_version":"0.1.0"}`))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestEnrollmentReturnsDeviceCredentials(t *testing.T) {
	memory := newMemoryStore()
	memory.codes[string(model.TokenHash("tma_pair_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ123456"))] = time.Now().Add(time.Hour)
	memory.policies = []model.Policy{model.DefaultPolicy()}
	server, _ := NewServer(memory, testConfig())
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, enrollmentRequest())
	if response.Code != http.StatusCreated {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
	var enrolled struct {
		DeviceID      string `json:"device_id"`
		DeviceToken   string `json:"device_token"`
		PolicyVersion string `json:"policy_version"`
	}
	if err := json.NewDecoder(response.Body).Decode(&enrolled); err != nil {
		t.Fatal(err)
	}
	if !model.UUID(enrolled.DeviceID) || !strings.HasPrefix(enrolled.DeviceToken, "tma_device_") || enrolled.PolicyVersion != memory.policies[0].Version {
		t.Fatalf("invalid enrollment: %+v", enrolled)
	}
}

func TestEnrollmentFailsForUnknownCode(t *testing.T) {
	memory := newMemoryStore()
	memory.policies = []model.Policy{model.DefaultPolicy()}
	server, _ := NewServer(memory, testConfig())
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, enrollmentRequest())
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
	if len(memory.devices) != 0 {
		t.Fatal("invalid code created a device")
	}
}

func TestHeartbeatCannotClaimProtectedWithoutReadiness(t *testing.T) {
	memory := newMemoryStore()
	memory.policies = []model.Policy{model.DefaultPolicy()}
	memory.devices[string(model.TokenHash("device-token"))] = model.Device{ID: model.NewUUID(), Status: "limited"}
	server, _ := NewServer(memory, testConfig())
	request := httptest.NewRequest(http.MethodPost, "/api/v1/agent/heartbeat", bytes.NewBufferString(`{"agent_version":"0.1.0","status":"protected","inspection_engine_ready":true,"browser_connected":false}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer device-token")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
	if memory.heartbeatStatus != "" {
		t.Fatal("invalid heartbeat reached persistence")
	}
}

func TestRevokedDeviceCannotAuthenticate(t *testing.T) {
	memory := newMemoryStore()
	now := time.Now()
	memory.devices[string(model.TokenHash("token"))] = model.Device{ID: model.NewUUID(), RevokedAt: &now}
	server, _ := NewServer(memory, testConfig())
	request := httptest.NewRequest(http.MethodGet, "/api/v1/agent/policies", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("got %d", response.Code)
	}
}

func TestEnrollmentConflict(t *testing.T) {
	memory := newMemoryStore()
	memory.policies = []model.Policy{model.DefaultPolicy()}
	memory.enrollErr = store.ErrInvalidCredentials
	server, _ := NewServer(memory, testConfig())
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, enrollmentRequest())
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d", response.Code)
	}
}
