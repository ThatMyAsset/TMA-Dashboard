package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/thatmyassets/tma-dashboard/internal/model"
	"github.com/thatmyassets/tma-dashboard/internal/store"
)

func (s *Server) ingestEvent(w http.ResponseWriter, r *http.Request, device model.Device) {
	var event model.Event
	if !decodeJSON(w, r, &event) {
		return
	}
	if err := event.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_event", err.Error())
		return
	}
	if err := s.store.InsertEvent(r.Context(), device.ID, event); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusConflict, "event_conflict", "Event ID already exists with different metadata")
			return
		}
		writeError(w, 500, "internal_error", "Could not store event")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accepted": true, "event_id": event.EventID})
}

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseLimit(r.URL.Query().Get("limit"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be an integer between 1 and 200")
		return
	}
	filters := model.EventFilters{Limit: limit, Provider: strings.TrimSpace(r.URL.Query().Get("provider")), DeviceID: r.URL.Query().Get("device_id")}
	if filters.Provider != "" && !validProvider(filters.Provider) {
		writeError(w, http.StatusBadRequest, "invalid_provider", "provider contains unsupported characters")
		return
	}
	if filters.DeviceID != "" && !model.UUID(filters.DeviceID) {
		writeError(w, http.StatusBadRequest, "invalid_device_id", "device_id must be a UUID")
		return
	}
	var valid bool
	if filters.Severity, valid = queryEnum(r, "severity", "low", "medium", "high", "critical"); !valid {
		writeError(w, http.StatusBadRequest, "invalid_severity", "severity must be low, medium, high, or critical")
		return
	}
	if filters.Outcome, valid = queryEnum(r, "outcome", "block", "audit", "allow"); !valid {
		writeError(w, http.StatusBadRequest, "invalid_outcome", "outcome must be block, audit, or allow")
		return
	}
	events, err := s.store.ListEvents(r.Context(), filters)
	if err != nil {
		writeError(w, 500, "internal_error", "Could not load events")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "limit": limit})
}

func queryEnum(r *http.Request, key string, values ...string) (string, bool) {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return "", true
	}
	for _, allowed := range values {
		if value == allowed {
			return value, true
		}
	}
	return "", false
}
func validProvider(value string) bool {
	if len(value) > 64 {
		return false
	}
	for i, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' && i > 0) {
			return false
		}
	}
	return true
}

func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	overview, err := s.store.Overview(r.Context())
	if err != nil {
		writeError(w, 500, "internal_error", "Could not load overview")
		return
	}
	writeJSON(w, http.StatusOK, overview)
}
