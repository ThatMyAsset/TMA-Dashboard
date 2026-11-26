package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/model"
)

func validEvent() model.Event {
	return model.Event{EventID: model.NewUUID(), OccurredAt: time.Now().UTC().Add(-time.Minute), Channel: "browser", Provider: "chatgpt", Application: "Chrome", FileName: "notes.txt", FileSize: 123, SHA256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", InspectionStatus: "complete", InspectionComplete: true, PolicyDecision: "block", EnforcementComponent: "browser_extension", EnforcementStatus: "prevented", EnforcementConfirmed: true, Findings: []model.Finding{{Category: "credential", Severity: "critical", Detector: "private_key"}}, RiskScore: 100, PolicyVersion: model.NewUUID()}
}

func TestEventRejectsInconsistentStatuses(t *testing.T) {
	event := validEvent()
	event.InspectionComplete = false
	if err := event.Validate(); err == nil {
		t.Fatal("accepted contradictory inspection booleans")
	}
	event = validEvent()
	event.EnforcementConfirmed = false
	event = validEvent()
	event.InspectionStatus = "failed"
	event.InspectionComplete = false
	event.PolicyDecision = "allow"
	event.EnforcementStatus = "not_required"
	event.EnforcementConfirmed = false
	if err := event.Validate(); err == nil {
		t.Fatal("allowed failed inspection")
	}
}

func TestEventIngestionIsIdempotent(t *testing.T) {
	memory := newMemoryStore()
	memory.devices[string(model.TokenHash("device-token"))] = model.Device{ID: model.NewUUID()}
	server, _ := NewServer(memory, testConfig())
	event := validEvent()
	body, _ := json.Marshal(event)
	for i := range 2 {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/events", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer device-token")
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("ingest %d got %d: %s", i, response.Code, response.Body.String())
		}
	}
	if len(memory.events) != 1 {
		t.Fatalf("stored %d events", len(memory.events))
	}
}

func TestPromptEventRejectsFileMetadata(t *testing.T) {
	event := validEvent()
	event.FileName = ""
	if err := event.Validate(); err == nil {
		t.Fatal("accepted file metadata on prompt event")
	}
}

func TestEventRejectsRawContent(t *testing.T) {
	event := validEvent()
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	raw["content"] = "secret"
	body, _ = json.Marshal(raw)
	memory := newMemoryStore()
	memory.devices[string(model.TokenHash("device-token"))] = model.Device{ID: model.NewUUID()}
	server, _ := NewServer(memory, testConfig())
	request := httptest.NewRequest(http.MethodPost, "/api/v1/events", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer device-token")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || len(memory.events) != 0 {
		t.Fatalf("status %d body %s events %d", response.Code, response.Body.String(), len(memory.events))
	}
}
