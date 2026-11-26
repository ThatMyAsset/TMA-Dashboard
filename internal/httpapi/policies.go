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
