package store

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/thatmyassets/tma-dashboard/internal/model"
)

//go:embed migrations/*.sql
var migrations embed.FS

var ErrNotFound = errors.New("not found")
var ErrConflict = errors.New("conflict")
var ErrInvalidCredentials = errors.New("invalid credentials")

type Store struct{ DB *pgxpool.Pool }

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	config.MaxConns = 10
	config.MinConns = 1
	config.MaxConnLifetime = time.Hour
	config.MaxConnIdleTime = 15 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	return &Store{DB: pool}, nil
}

func (s *Store) Close()                         { s.DB.Close() }
func (s *Store) Ping(ctx context.Context) error { return s.DB.Ping(ctx) }
func (s *Store) Migrate(ctx context.Context) error {
	conn, err := s.DB.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock(741931)"); err != nil {
		return err
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock(741931)")
	if _, err := conn.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"); err != nil {
		return err
	}
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		version, err := strconv.Atoi(strings.SplitN(entry.Name(), "_", 2)[0])
		if err != nil {
			return err
		}
		var applied bool
		if err := s.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)", version).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		body, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		tx, err := s.DB.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, string(body)); err == nil {
			_, err = tx.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES($1)", version)
		}
		if err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Bootstrap(ctx context.Context, username, passwordHash string, policy model.Policy) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO admin_users(id,username,password_hash) VALUES($1,$2,$3) ON CONFLICT(username) DO NOTHING`, model.NewUUID(), username, passwordHash); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM policies").Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		document, _ := json.Marshal(policy)
		if _, err := tx.Exec(ctx, "INSERT INTO policies(id,generated_at,document) VALUES($1,$2,$3)", policy.Version, policy.GeneratedAt, document); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) PasswordHash(ctx context.Context, username string) (string, error) {
	var hash string
	err := s.DB.QueryRow(ctx, "SELECT password_hash FROM admin_users WHERE username=$1", username).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInvalidCredentials
	}
	return hash, err
}

func (s *Store) CreateSession(ctx context.Context, tokenHash []byte, username string, expiresAt time.Time) error {
	_, err := s.DB.Exec(ctx, "INSERT INTO admin_sessions(id,token_hash,username,expires_at) VALUES($1,$2,$3,$4)", model.NewUUID(), tokenHash, username, expiresAt)
	return err
}

func (s *Store) Session(ctx context.Context, tokenHash []byte) (string, error) {
	var username string
	err := s.DB.QueryRow(ctx, "SELECT username FROM admin_sessions WHERE token_hash=$1 AND expires_at>now()", tokenHash).Scan(&username)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInvalidCredentials
	}
	return username, err
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.DB.Exec(ctx, "DELETE FROM admin_sessions WHERE token_hash=$1", tokenHash)
	return err
}

func (s *Store) CleanupSessions(ctx context.Context) error {
	_, err := s.DB.Exec(ctx, "DELETE FROM admin_sessions WHERE expires_at<=now()")
	return err
}

func (s *Store) CreatePairingCode(ctx context.Context, hash, ciphertext []byte, expiresAt time.Time) error {
	_, err := s.DB.Exec(ctx, "INSERT INTO pairing_codes(id,code_hash,code_ciphertext,expires_at) VALUES($1,$2,$3,$4)", model.NewUUID(), hash, ciphertext, expiresAt)
	return err
}

func (s *Store) ListActivePairingCodes(ctx context.Context) ([]model.PairingCode, error) {
	rows, err := s.DB.Query(ctx, `SELECT id,code_ciphertext,created_at,expires_at FROM pairing_codes WHERE used_at IS NULL AND expires_at>now() AND code_ciphertext IS NOT NULL ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	codes := []model.PairingCode{}
	for rows.Next() {
		var code model.PairingCode
		if err := rows.Scan(&code.ID, &code.Ciphertext, &code.CreatedAt, &code.ExpiresAt); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, rows.Err()
}
func (s *Store) RevokePairingCode(ctx context.Context, id string) error {
	result, err := s.DB.Exec(ctx, `UPDATE pairing_codes SET used_at=now(),code_ciphertext=NULL WHERE id=$1 AND used_at IS NULL AND expires_at>now()`, id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) Enroll(ctx context.Context, codeHash, tokenHash []byte, hostname, os, version string, policyVersion *string) (string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var codeID string
	err = tx.QueryRow(ctx, "UPDATE pairing_codes SET used_at=now(),code_ciphertext=NULL WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING id", codeHash).Scan(&codeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInvalidCredentials
	}
	if err != nil {
		return "", err
	}
	deviceID := model.NewUUID()
	_, err = tx.Exec(ctx, `INSERT INTO devices(id,token_hash,hostname,os,agent_version,status,enrolled_at,policy_version) VALUES($1,$2,$3,$4,$5,'pending_enrollment',now(),$6)`, deviceID, tokenHash, hostname, os, version, policyVersion)
	if err != nil {
		return "", err
	}
	return deviceID, tx.Commit(ctx)
}

func (s *Store) DeviceByToken(ctx context.Context, tokenHash []byte) (model.Device, error) {
	return scanDevice(s.DB.QueryRow(ctx, deviceSelect+" WHERE token_hash=$1 AND revoked_at IS NULL", tokenHash))
}

const deviceSelect = "SELECT id,hostname,os,agent_version,status,inspection_engine_ready,browser_connected,enrolled_at,last_seen_at,revoked_at,policy_version FROM devices"

type scanner interface{ Scan(...any) error }

func scanDevice(row scanner) (model.Device, error) {
	var d model.Device
	err := row.Scan(&d.ID, &d.Hostname, &d.OS, &d.AgentVersion, &d.Status, &d.InspectionEngineReady, &d.BrowserConnected, &d.EnrolledAt, &d.LastSeenAt, &d.RevokedAt, &d.PolicyVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, ErrNotFound
	}
	return d, err
}

func (s *Store) Heartbeat(ctx context.Context, deviceID, agentVersion, status string, engineReady, browserConnected bool, _ string) error {
	if status == "protected" && (!engineReady || !browserConnected) {
		status = "limited"
	}
	result, err := s.DB.Exec(ctx, `UPDATE devices SET agent_version=$2,status=$3,inspection_engine_ready=$4,browser_connected=$5,last_seen_at=now() WHERE id=$1 AND revoked_at IS NULL`, deviceID, agentVersion, status, engineReady, browserConnected)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListDevices(ctx context.Context) ([]model.Device, error) {
	rows, err := s.DB.Query(ctx, deviceSelect+" ORDER BY enrolled_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	devices := []model.Device{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

func (s *Store) RevokeDevice(ctx context.Context, id string) error {
	result, err := s.DB.Exec(ctx, "UPDATE devices SET revoked_at=now(),status='degraded' WHERE id=$1 AND revoked_at IS NULL", id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) LatestPolicy(ctx context.Context) (model.Policy, error) {
	var p model.Policy
	var document []byte
	err := s.DB.QueryRow(ctx, "SELECT document FROM policies ORDER BY sequence DESC LIMIT 1").Scan(&document)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, err
	}
	err = json.Unmarshal(document, &p)
	return p, err
}

func (s *Store) PolicyByVersion(ctx context.Context, version string) (model.Policy, error) {
	var p model.Policy
	var document []byte
	err := s.DB.QueryRow(ctx, "SELECT document FROM policies WHERE id=$1", version).Scan(&document)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, err
	}
	err = json.Unmarshal(document, &p)
	return p, err
}

func (s *Store) AssignDevicePolicy(ctx context.Context, deviceID, policyVersion string) error {
	result, err := s.DB.Exec(ctx, `UPDATE devices SET policy_version=$2
		WHERE id=$1 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM policies WHERE id=$2)`, deviceID, policyVersion)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CreatePolicy(ctx context.Context, policy model.Policy) error {
	document, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx, "INSERT INTO policies(id,generated_at,document) VALUES($1,$2,$3)", policy.Version, policy.GeneratedAt, document)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

func (s *Store) ListPolicies(ctx context.Context) ([]model.Policy, error) {
	rows, err := s.DB.Query(ctx, "SELECT document FROM policies ORDER BY sequence DESC LIMIT 100")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	policies := []model.Policy{}
	for rows.Next() {
		var document []byte
		if err := rows.Scan(&document); err != nil {
			return nil, err
		}
		var p model.Policy
		if err := json.Unmarshal(document, &p); err != nil {
			return nil, err
		}
		policies = append(policies, p)
	}
	return policies, rows.Err()
}

func (s *Store) DeletePolicy(ctx context.Context, version string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM policies`).Scan(&count); err != nil {
		return err
	}
	if count <= 1 {
		return ErrConflict
	}
	var referenced bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE policy_version=$1) OR EXISTS(SELECT 1 FROM events WHERE event->>'policy_version'=$1)`, version).Scan(&referenced); err != nil {
		return err
	}
	if referenced {
		return ErrConflict
	}
	result, err := tx.Exec(ctx, `DELETE FROM policies WHERE id=$1`, version)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return ErrConflict
		}
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (s *Store) InsertEvent(ctx context.Context, deviceID string, event model.Event) error {
	document, err := json.Marshal(event)
	if err != nil {
		return err
	}
	var id string
	err = s.DB.QueryRow(ctx, `INSERT INTO events(device_id,event_id,occurred_at,provider,severity,outcome,event) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(device_id,event_id) DO NOTHING RETURNING event_id`, deviceID, event.EventID, event.OccurredAt, event.Provider, event.Severity(), event.PolicyDecision, document).Scan(&id)
	if err == nil {
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var existing []byte
	if err := s.DB.QueryRow(ctx, "SELECT event FROM events WHERE device_id=$1 AND event_id=$2", deviceID, event.EventID).Scan(&existing); err != nil {
		return err
	}
	var original model.Event
	if err := json.Unmarshal(existing, &original); err != nil {
		return err
	}
	left, _ := json.Marshal(original)
	if string(left) != string(document) {
		return ErrConflict
	}
	return nil
}

func (s *Store) ListEvents(ctx context.Context, f model.EventFilters) ([]model.Event, error) {
	query := "SELECT event FROM events WHERE ($1='' OR provider=$1) AND ($2='' OR severity=$2) AND ($3='' OR outcome=$3) AND ($4='' OR device_id::text=$4) ORDER BY occurred_at DESC,event_id DESC LIMIT $5"
	rows, err := s.DB.Query(ctx, query, f.Provider, f.Severity, f.Outcome, f.DeviceID, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []model.Event{}
	for rows.Next() {
		var document []byte
		if err := rows.Scan(&document); err != nil {
			return nil, err
		}
		var event model.Event
		if err := json.Unmarshal(document, &event); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) Overview(ctx context.Context) (model.Overview, error) {
	var o model.Overview
	err := s.DB.QueryRow(ctx, `SELECT
		count(*) FILTER(WHERE revoked_at IS NULL),
		count(*) FILTER(WHERE revoked_at IS NULL AND status='protected'),
		count(*) FILTER(WHERE revoked_at IS NULL AND status='degraded'),
		count(*) FILTER(WHERE revoked_at IS NULL AND status='pending_enrollment') FROM devices`).Scan(&o.TotalDevices, &o.ProtectedDevices, &o.DegradedDevices, &o.PendingDevices)
	if err != nil {
		return o, err
	}
	err = s.DB.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE outcome='block'),count(*) FILTER(WHERE event->>'enforcement_status'='failed') FROM events WHERE occurred_at>=now()-interval '24 hours'`).Scan(&o.Events24h, &o.Blocked24h, &o.Failed24h)
	if err != nil {
		return o, err
	}
	policy, err := s.LatestPolicy(ctx)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return o, err
	}
	if err == nil {
		o.ActivePolicy = &policy
	}
	return o, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
