# TMA Control Center

Production-conscious vertical slice of ThatMyAssets AI data-loss prevention: Go Control Plane, PostgreSQL, Next.js admin dashboard, and Caddy. The initial release manages browser agents and local text-inspection metadata only. It does not provide desktop application control, OCR, or archive inspection.

## Stack

- **Control Plane:** Go 1.23, `net/http`, pgx, bcrypt. Database migrations run at startup under a PostgreSQL advisory lock.
- **Dashboard:** Next.js 15, React 19, strict TypeScript. All counts, devices, policies, and activity come from the Control Plane; there are no demo records.
- **Persistence:** PostgreSQL 17. Only SHA-256 hashes of admin session tokens, pairing codes, and device tokens are stored.
- **Edge:** Caddy 2 with automatic HTTPS for named sites. Compose exposes only Caddy; the database and application services stay on the private Docker network.
## Interactive installer (Node.js 20+)

The publishable `@thatmyassets/dashboard` npm package bundles the pinned Go/Next.js source, Compose file, Caddyfile, and database migration. It does not download an unpinned source archive.

```sh
npx @thatmyassets/dashboard install
```

The installer asks for Docker or system mode, origin/ports, administrator credentials with confirmation, database credentials, and an optional automation token. Strong random administrator/database passwords are generated when the corresponding prompt is left blank. The automation token is disabled when blank; answer `generate` to create one. Passwords and tokens are never printed. Retrieve generated bootstrap values from the protected `.env` file and store them securely. Existing administrator passwords are not overwritten by application restarts.

The default installation directory is `./tma-dashboard`. Docker mode validates Docker, Compose v2, and the daemon before building, writes `.env` atomically with restrictive permissions, starts the stack, and succeeds only after an end-to-end health check. System mode checks Go, Node.js, npm, PostgreSQL, and `psql`; it prints installation links instead of installing global runtimes. It provisions the application role/database idempotently, builds both applications, then starts systemd services on supported root Linux installations or local background processes on Windows, macOS, and non-root Linux. System mode is localhost HTTP only; use Docker/Caddy for public HTTPS.

Preview a plan without creating files, checking dependencies, or executing installation commands:

```sh
npx @thatmyassets/dashboard install --dry-run --non-interactive
```

For CI, set secrets through your CI secret store rather than putting them in shell history:

```sh
export TMA_ADMIN_PASSWORD='a-long-unique-admin-password'
export TMA_ADMIN_PASSWORD_CONFIRM="$TMA_ADMIN_PASSWORD"
export TMA_DB_PASSWORD='a_long_unique_database_password'
npx @thatmyassets/dashboard install --non-interactive --mode docker \
  --origin https://dashboard.example.com --install-dir /srv/tma-dashboard
```

All options have `TMA_` environment equivalents; run `npx @thatmyassets/dashboard --help` for the complete list. Supplied administrator passwords require matching confirmation in noninteractive mode. Passwords use printable ASCII without quotes, dollar signs, or backslashes so Docker, systemd, and local process environments parse identically. Docker database passwords additionally use only URL-safe letters, numbers, `_`, and `-`.

Manage a local-process installation with the same package version:

```sh
npx @thatmyassets/dashboard start --install-dir ./tma-dashboard
npx @thatmyassets/dashboard stop --install-dir ./tma-dashboard
```

On systemd installations use `sudo systemctl start|stop tma-dashboard.service tma-control-plane.service`. On Docker installations use `docker compose --env-file .env up -d` or `down` from the installation directory. Local stdout/stderr logs are under `logs/`; no secret values are written to them by the installer.


## Run with Docker Compose

Prerequisites: Docker Engine with Compose v2.

1. Copy `.env.example` to `.env`.
2. Replace both passwords. `ADMIN_PASSWORD` must contain 12–72 bytes. Optionally set a random 32+ character `ADMIN_API_TOKEN` for automation.
3. Start the stack:

   ```sh
   docker compose --env-file .env up --build -d
   docker compose ps
   curl -k https://localhost/healthz
   ```

4. Open `https://localhost`. Caddy uses a local development certificate, so trust that certificate in your browser or proceed through its local-certificate warning. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

The initial administrator and default policy are created only when absent. Changing `ADMIN_PASSWORD` after the first start does **not** overwrite an existing administrator password. Destroying the PostgreSQL volume resets all local data:

```sh
docker compose down
# Destroys all local dashboard data; only use for a deliberate reset:
docker compose down -v
```

### Public deployment

Set these values in `.env` before starting:

```dotenv
SITE_ADDRESS=dashboard.example.com
ALLOWED_ORIGINS=https://dashboard.example.com
```

Point the public DNS record at the Caddy host and allow inbound TCP 80 and 443. Caddy obtains and renews the public certificate. The Compose Control Plane always sets `COOKIE_SECURE=true` and trusts forwarded client IPs only on the private Docker network. Keep PostgreSQL unpublished. Use a secrets manager rather than committing `.env`.

## Local development

Prerequisites: Go 1.23+, Node.js 22+, and PostgreSQL 17+.

```sh
createdb tma
cp .env.example .env
# Export real values in your shell; do not use placeholder passwords.
export DATABASE_URL='postgres://tma:password@127.0.0.1:5432/tma?sslmode=disable'
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD='replace-with-at-least-12-characters'
export COOKIE_SECURE=false
export TRUST_PROXY=false
export ALLOWED_ORIGINS=http://localhost:3000

go run ./cmd/control-plane
```

In another terminal:

```sh
cd web
npm ci
CONTROL_PLANE_URL=http://127.0.0.1:8080 npm run dev
```

Open `http://localhost:3000`. The Next.js same-origin route forwards only browser cookies and JSON requests to the Control Plane; it does not expose the database or accept an admin bearer token from browser JavaScript.

## Verify

```sh
go test ./...
go test -race ./...
go vet ./...
cd web && npm ci && npm test && npx tsc --noEmit && npm run build
cd .. && docker compose --env-file .env config --quiet
npm test
npm pack --dry-run
```

GitHub Actions runs formatting verification, vet, race-enabled Go tests, frontend unit tests, TypeScript checks, production build, Compose validation, installer tests, and an npm package-content dry run.

## API

All resources use `/api/v1`. IDs are UUIDs; timestamps are RFC3339 UTC. Errors use:

```json
{"error":{"code":"invalid_event","message":"Description"}}
```

| Method | Path | Authentication | Behavior |
|---|---|---|---|
| POST | `/auth/login` | Origin-checked, rate-limited | Sets an HTTP-only SameSite=Strict session cookie |
| POST | `/auth/logout` | Admin session or bearer | Deletes server-side session and clears cookie |
| GET | `/auth/session` | Admin session or bearer | Returns current identity |
| POST | `/pairing-codes` | Admin session or bearer, origin check | Creates one-time code with 1–24 hour TTL |
| POST | `/agents/enroll` | Pairing code, rate-limited | Returns device ID and device token once |
| GET | `/agent/policies` | Device bearer | Returns latest policy document |
| POST | `/agent/heartbeat` | Device bearer | Records readiness and returns current policy version/server time |
| POST | `/events` | Device bearer, rate-limited | Ingests one metadata-only event idempotently |
| GET | `/devices` | Admin | Lists active and revoked devices |
| POST | `/devices/{id}/revoke` | Admin, origin check | Immediately revokes device bearer access |
| GET | `/events` | Admin | Filters by provider, severity, outcome, device ID; limit 1–200 |
| GET | `/overview` | Admin | Returns real fleet and 24-hour event counts |
| GET | `/policies` | Admin | Lists immutable policy versions |
| POST | `/policies` | Admin, origin check | Validates and activates a new policy version |
| GET | `/healthz` | Public | Checks PostgreSQL readiness |

Admin automation can send `Authorization: Bearer $ADMIN_API_TOKEN` instead of a cookie. Device bearer tokens only authorize agent routes and cannot authorize admin routes. Cookie-authenticated mutations require an exact allowed `Origin`; automation bearer requests may omit it. Login attempts, enrollment, and ingestion have independent per-client rate limits.

### Event safety and idempotency

Unknown JSON fields are rejected. Raw prompt text, file content, matched values, credentials, and file bytes are not part of the schema and cannot be submitted. Event validation enforces UUIDs, UTC timestamps, metadata bounds, supported statuses, and agreement between inspection/enforcement statuses and booleans. Incomplete inspection cannot be allowed.

`(device_id,event_id)` is the idempotency key. An identical retry returns success without a duplicate. Reusing the key with different metadata returns `409 event_conflict`.

### Policies

The default policy blocks high-and-above credentials/private keys, audits medium-and-above PII/financial findings, and has a final allow rule for complete inspections. Enabled rules use the lowest priority number. Empty providers match all providers. The configured `failure_mode` (`block` or `audit`) governs failed or incomplete inspection; it never becomes silent allow.

Publishing a policy creates a new immutable version. Agents receive the latest version on policy fetch and learn its version on heartbeat. The dashboard does not edit or delete historical versions.

## Operational notes and current limits

- Single-admin username bootstrap is included; there is no user-management UI, SSO, MFA, tenant isolation, or email recovery in this slice.
- Sessions expire after eight hours. PostgreSQL cleanup removes expired rows on later maintenance; expiration is enforced on every read regardless of cleanup.
- Revocation is permanent for a device enrollment. Enroll a replacement with a new one-time code rather than reusing a token.
- Event and policy lists are capped for this vertical slice. Pagination beyond the current 200-event and 100-policy limits is not included.
- Only browser-channel security events are accepted. No desktop enforcement, OCR, archive parsing, raw-content search, or remote agent command channel is claimed.
