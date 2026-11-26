CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY,
    token_hash BYTEA NOT NULL UNIQUE,
    username TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS pairing_codes (
    id UUID PRIMARY KEY,
    code_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY,
    token_hash BYTEA NOT NULL UNIQUE,
    hostname TEXT NOT NULL,
    os TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending_enrollment', 'limited', 'protected', 'degraded')),
    inspection_engine_ready BOOLEAN NOT NULL DEFAULT false,
    browser_connected BOOLEAN NOT NULL DEFAULT false,
    enrolled_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    policy_version UUID
);
CREATE INDEX IF NOT EXISTS devices_status_idx ON devices (status) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS policies (
    id UUID PRIMARY KEY,
    sequence BIGINT GENERATED ALWAYS AS IDENTITY,
    generated_at TIMESTAMPTZ NOT NULL,
    document JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
    device_id UUID NOT NULL REFERENCES devices(id),
    event_id UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    provider TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    outcome TEXT NOT NULL CHECK (outcome IN ('block', 'audit', 'allow')),
    event JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, event_id)
);
CREATE INDEX IF NOT EXISTS events_occurred_idx ON events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_provider_idx ON events (provider, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_severity_idx ON events (severity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_outcome_idx ON events (outcome, occurred_at DESC);
