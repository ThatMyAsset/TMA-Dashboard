package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/model"
	"github.com/thatmyassets/tma-dashboard/internal/store"
)

func (s *Server) listPolicies(w http.ResponseWriter, r *http.Request) {
	policies, err := s.store.ListPolicies(r.Context())
	if err != nil {
		writeError(w, 500, "internal_error", "Could not load policies")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"policies": policies})
}

func (s *Server) createPolicy(w http.ResponseWriter, r *http.Request) {
	var policy model.Policy
	if !decodeJSON(w, r, &policy) {
		return
	}
	if err := policy.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_policy", err.Error())
		return
	}
	if err := s.store.CreatePolicy(r.Context(), policy); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusConflict, "policy_exists", "Policy version already exists")
			return
		}
		writeError(w, 500, "internal_error", "Could not create policy")
		return
	}
	writeJSON(w, http.StatusCreated, policy)
}

func (s *Server) updatePolicy(w http.ResponseWriter, r *http.Request) {
	version := r.PathValue("version")
	if !model.UUID(version) {
		writeError(w, http.StatusBadRequest, "invalid_policy_id", "Policy ID must be a UUID")
		return
	}
	var policy model.Policy
	if !decodeJSON(w, r, &policy) {
		return
	}
	if policy.Version != version {
		writeError(w, http.StatusBadRequest, "policy_id_mismatch", "Policy ID cannot change while editing a policy")
		return
	}
	policy.GeneratedAt = time.Now().UTC().Truncate(time.Second)
	if err := policy.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_policy", err.Error())
		return
	}
	if err := s.store.UpdatePolicy(r.Context(), policy); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "policy_not_found", "Policy was not found")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Could not update policy")
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

func (s *Server) deletePolicy(w http.ResponseWriter, r *http.Request) {
	version := r.PathValue("version")
	if !model.UUID(version) {
		writeError(w, 400, "invalid_policy_version", "Policy version must be a UUID")
		return
	}
	err := s.store.DeletePolicy(r.Context(), version)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, 404, "policy_not_found", "Policy version was not found")
		return
	}
	if err != nil {
		writeError(w, 500, "internal_error", "Could not delete policy")
		return
	}
	writeJSON(w, 200, map[string]any{"version": version, "deleted": true, "message": "Assigned active devices were moved to another policy. Historical activity is retained."})
}
