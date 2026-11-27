package httpapi

import (
	"errors"
	"net/http"

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
	if errors.Is(err, store.ErrConflict) {
		writeError(w, 409, "policy_in_use", "The last policy, a device-assigned policy, or a policy referenced by activity cannot be deleted")
		return
	}
	if err != nil {
		writeError(w, 500, "internal_error", "Could not delete policy")
		return
	}
	writeJSON(w, 200, map[string]any{"version": version, "deleted": true})
}
