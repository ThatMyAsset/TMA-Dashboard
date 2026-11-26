package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/thatmyassets/tma-dashboard/internal/model"
)

func TestDefaultPolicyIsDeterministicAndValid(t *testing.T) {
	policy := model.DefaultPolicy()
	if err := policy.Validate(); err != nil {
		t.Fatal(err)
	}
	if policy.FailureMode != "block" || policy.Rules[0].Action != "block" || policy.Rules[1].Action != "audit" || policy.Rules[2].Action != "allow" {
		t.Fatalf("unexpected defaults: %+v", policy)
	}
	if policy.Rules[0].Priority >= policy.Rules[1].Priority || policy.Rules[1].Priority >= policy.Rules[2].Priority {
		t.Fatal("policy precedence is not deterministic")
	}
}

func TestPolicyRejectsInvalidActionAndDuplicatePriority(t *testing.T) {
	policy := model.DefaultPolicy()
	policy.Rules[0].Action = "ignore"
	if err := policy.Validate(); err == nil {
		t.Fatal("accepted invalid action")
	}
	policy = model.DefaultPolicy()
	policy.Rules[1].Priority = policy.Rules[0].Priority
	if err := policy.Validate(); err == nil {
		t.Fatal("accepted duplicate priority")
	}
}

func TestCreatePolicyReturnsPersistedVersion(t *testing.T) {
	memory := newMemoryStore()
	server, _ := NewServer(memory, testConfig())
	policy := model.DefaultPolicy()
	body, _ := json.Marshal(policy)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/policies", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://example.com")
	request.Host = "example.com"
	request.AddCookie(&http.Cookie{Name: sessionCookie, Value: "admin-session"})
	memory.sessions[string(model.TokenHash("admin-session"))] = "admin"
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
	if len(memory.policies) != 1 || memory.policies[0].Version != policy.Version {
		t.Fatal("policy version not persisted")
	}
}

func TestPolicyRejectsNonUTCTimestamp(t *testing.T) {
	policy := model.DefaultPolicy()
	body, _ := json.Marshal(policy)
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	raw["generated_at"] = "2026-11-26T01:00:00+01:00"
	body, _ = json.Marshal(raw)
	var decoded model.Policy
	if err := json.Unmarshal(body, &decoded); err == nil {
		t.Fatal("accepted non-UTC policy timestamp")
	}
}
