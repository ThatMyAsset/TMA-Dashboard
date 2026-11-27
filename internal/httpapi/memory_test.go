package httpapi

import (
	"context"
	"reflect"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/model"
	"github.com/thatmyassets/tma-dashboard/internal/store"
)

type memoryStore struct {
	passwordHash    string
	sessions        map[string]string
	sessionErr      error
	codes           map[string]time.Time
	devices         map[string]model.Device
	policies        []model.Policy
	events          []model.Event
	enrollErr       error
	heartbeatStatus string
}

func newMemoryStore() *memoryStore {
	return &memoryStore{sessions: map[string]string{}, codes: map[string]time.Time{}, devices: map[string]model.Device{}}
}
func (m *memoryStore) Ping(context.Context) error { return nil }
func (m *memoryStore) PasswordHash(_ context.Context, username string) (string, error) {
	if m.passwordHash == "" || username != "admin" {
		return "", store.ErrInvalidCredentials
	}
	return m.passwordHash, nil
}
func (m *memoryStore) CreateSession(_ context.Context, hash []byte, username string, _ time.Time) error {
	m.sessions[string(hash)] = username
	return nil
}
func (m *memoryStore) Session(_ context.Context, hash []byte) (string, error) {
	if m.sessionErr != nil {
		return "", m.sessionErr
	}
	username, ok := m.sessions[string(hash)]
	if !ok {
		return "", store.ErrInvalidCredentials
	}
	return username, nil
}
func (m *memoryStore) DeleteSession(_ context.Context, hash []byte) error {
	delete(m.sessions, string(hash))
	return nil
}
func (m *memoryStore) CreatePairingCode(_ context.Context, hash, _ []byte, expires time.Time) error {
	m.codes[string(hash)] = expires
	return nil
}
func (m *memoryStore) ListActivePairingCodes(context.Context) ([]model.PairingCode, error) {
	return nil, nil
}
func (m *memoryStore) RevokePairingCode(context.Context, string) error { return store.ErrNotFound }
func (m *memoryStore) Enroll(_ context.Context, codeHash, tokenHash []byte, hostname, os, version string, policyVersion *string) (string, error) {
	if m.enrollErr != nil {
		return "", m.enrollErr
	}
	if _, ok := m.codes[string(codeHash)]; !ok {
		return "", store.ErrInvalidCredentials
	}
	delete(m.codes, string(codeHash))
	id := model.NewUUID()
	m.devices[string(tokenHash)] = model.Device{ID: id, Hostname: hostname, OS: os, AgentVersion: version, Status: "pending_enrollment", PolicyVersion: policyVersion}
	return id, nil
}
func (m *memoryStore) DeviceByToken(_ context.Context, hash []byte) (model.Device, error) {
	device, ok := m.devices[string(hash)]
	if !ok {
		return model.Device{}, store.ErrNotFound
	}
	return device, nil
}
func (m *memoryStore) Heartbeat(_ context.Context, _, _, status string, _, _ bool, _ string) error {
	m.heartbeatStatus = status
	return nil
}
func (m *memoryStore) ListDevices(context.Context) ([]model.Device, error) {
	devices := []model.Device{}
	for _, device := range m.devices {
		if device.RevokedAt == nil {
			devices = append(devices, device)
		}
	}
	return devices, nil
}
func (m *memoryStore) RevokeDevice(_ context.Context, id string) error {
	for hash, device := range m.devices {
		if device.ID == id {
			now := time.Now()
			device.RevokedAt = &now
			device.PolicyVersion = nil
			m.devices[hash] = device
			return nil
		}
	}
	return store.ErrNotFound
}
func (m *memoryStore) AssignDevicePolicy(_ context.Context, id, version string) error {
	var policyExists bool
	for _, policy := range m.policies {
		if policy.Version == version {
			policyExists = true
			break
		}
	}
	if !policyExists {
		return store.ErrNotFound
	}
	for hash, device := range m.devices {
		if device.ID == id && device.RevokedAt == nil {
			device.PolicyVersion = &version
			m.devices[hash] = device
			return nil
		}
	}
	return store.ErrNotFound
}
func (m *memoryStore) LatestPolicy(context.Context) (model.Policy, error) {
	if len(m.policies) == 0 {
		return model.Policy{}, store.ErrNotFound
	}
	return m.policies[len(m.policies)-1], nil
}
func (m *memoryStore) PolicyByVersion(_ context.Context, version string) (model.Policy, error) {
	for _, policy := range m.policies {
		if policy.Version == version {
			return policy, nil
		}
	}
	return model.Policy{}, store.ErrNotFound
}
func (m *memoryStore) CreatePolicy(_ context.Context, policy model.Policy) error {
	for _, existing := range m.policies {
		if existing.Version == policy.Version {
			return store.ErrConflict
		}
	}
	m.policies = append(m.policies, policy)
	return nil
}
func (m *memoryStore) UpdatePolicy(_ context.Context, policy model.Policy) error {
	for index := range m.policies {
		if m.policies[index].Version == policy.Version {
			m.policies[index] = policy
			return nil
		}
	}
	return store.ErrNotFound
}
func (m *memoryStore) ListPolicies(context.Context) ([]model.Policy, error) { return m.policies, nil }
func (m *memoryStore) DeletePolicy(context.Context, string) error           { return store.ErrNotFound }
func (m *memoryStore) InsertEvent(_ context.Context, _ string, event model.Event) error {
	for _, existing := range m.events {
		if existing.EventID == event.EventID {
			if !reflect.DeepEqual(existing, event) {
				return store.ErrConflict
			}
			return nil
		}
	}
	m.events = append(m.events, event)
	return nil
}
func (m *memoryStore) ListEvents(context.Context, model.EventFilters) ([]model.Event, error) {
	return m.events, nil
}
func (m *memoryStore) Overview(context.Context) (model.Overview, error) { return model.Overview{}, nil }
