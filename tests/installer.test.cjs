"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { defaults, validateConfig, renderEnv, renderPostgresEnv, parseEnv, redactEnv, parseOrigin, parseOrigins } = require("../installer/config.cjs");
const { parseArguments, collect } = require("../installer/cli.cjs");
const { main, plan, systemdUnits, atomicWrite, assertPortsFree, preserveDockerSecrets, composeEnvironment } = require("../installer/index.cjs");
const net = require("node:net");

const passwords = { adminPassword: "correct-horse-battery", adminPasswordConfirm: "correct-horse-battery", dbPassword: "database_password_12345" };

test("noninteractive arguments and environment create a valid configuration", async () => {
  const parsed = parseArguments(["install", "--non-interactive", "--mode", "docker", "--web-port=3100", "--origin", "http://localhost:3100"], {});
  const config = await collect({ ...parsed.options, ...passwords });
  assert.equal(config.mode, "docker");
  assert.equal(config.webPort, 3100);
  assert.equal(config.origin, "http://localhost:3100");
  const dockerEnv = parseEnv(renderEnv(config));
  assert.equal(dockerEnv.WEB_PORT, "3100");
  assert.equal(dockerEnv.DATABASE_URL, "postgres://tma:database_password_12345@postgres:5432/tma?sslmode=disable");
  assert.deepEqual(parseEnv(renderPostgresEnv(config)), { POSTGRES_DB: "tma", POSTGRES_USER: "tma", POSTGRES_PASSWORD: passwords.dbPassword });
  assert.equal(Object.hasOwn(dockerEnv, "DASHBOARD_HOST"), false);
  assert.equal(Object.hasOwn(dockerEnv, "CONTROL_PLANE_HOST"), false);
  assert.equal(dockerEnv.CONTROL_PLANE_PORT, "18080");
  assert.equal(dockerEnv.ALLOWED_ORIGINS, "http://localhost:3100");
  assert.equal(dockerEnv.COOKIE_SECURE, "false");
  assert.equal(dockerEnv.TRUST_PROXY, "false");
  assert.equal(dockerEnv.DEV_ALLOW_ALL_ORIGINS, "true");

  const env = parseArguments(["install"], { CI: "true", TMA_MODE: "system", TMA_ORIGIN: "http://localhost:3100", TMA_WEB_PORT: "3100", TMA_ADMIN_NAME: "operator" });
  assert.equal(env.options.nonInteractive, true);
  assert.equal(env.options.adminUsername, "operator");
});

test("password confirmation is mandatory for supplied CI passwords", async () => {
  await assert.rejects(collect({ nonInteractive: true, ...passwords, adminPasswordConfirm: "different-password" }), /confirmation does not match/);
});

test("origins, ports, identifiers, and Docker database passwords are validated", () => {
  assert.equal(parseOrigin("https://dashboard.example.com"), "https://dashboard.example.com");
  assert.throws(() => parseOrigin("https://dashboard.example.com/path"), /only/);
  assert.throws(() => parseOrigin("http://dashboard.example.com"), /HTTPS/);
  assert.throws(() => validateConfig(defaults({ ...passwords, webPort: "0" })), /Dashboard port/);
  assert.throws(() => validateConfig(defaults({ ...passwords, adminUsername: "Admin User" })), /admin username/);
  assert.throws(() => validateConfig(defaults({ ...passwords, dbPassword: "unsafe:password_12345" })), /URL-safe/);
  assert.throws(() => validateConfig(defaults({ ...passwords, mode: "system", origin: "https://localhost:3000" })), /local HTTP/);
  assert.throws(() => validateConfig(defaults({ ...passwords, origin: "http://localhost:8443" })), /origin port/);
  assert.equal(validateConfig(defaults({ ...passwords, mode: "docker", origin: "https://dashboard.example.com" })).secureCookies, true);
  assert.equal(parseOrigin("http://203.0.113.10:3000"), "http://203.0.113.10:3000");
  assert.throws(() => parseOrigin("http://dashboard.example.com"), /IP address/);
  assert.equal(parseOrigins("http://203.0.113.10:3000,http://203.0.113.10:3000"), "http://203.0.113.10:3000");
  assert.equal(parseOrigins("*"), "*");
  const wildcard = parseEnv(renderEnv(validateConfig(defaults({ ...passwords, origin: "*" }))));
  assert.equal(wildcard.ALLOWED_ORIGINS, "*");
  assert.equal(wildcard.DEV_ALLOW_ALL_ORIGINS, "true");
  assert.equal(parseEnv(renderEnv(validateConfig(defaults({ ...passwords, mode: "system" })))).DEV_ALLOW_ALL_ORIGINS, "false");
  assert.deepEqual(parseEnv("ALLOWED_ORIGINS='http://203.0.113.10:3000'\n"), { ALLOWED_ORIGINS: "http://203.0.113.10:3000" });
});

test("environment rendering round-trips and URL-encodes system credentials", () => {
  const config = validateConfig(defaults({ ...passwords, dbPassword: "db:password@localhost/123", mode: "system", origin: "http://localhost:3000", dbHost: "127.0.0.1" }));
  const text = renderEnv(config);
  const parsed = parseEnv(text);
  assert.equal(parsed.ADMIN_PASSWORD, passwords.adminPassword);
  assert.equal(parsed.POSTGRES_PASSWORD, config.dbPassword);
  const database = new URL(parsed.DATABASE_URL);
  assert.equal(decodeURIComponent(database.password), config.dbPassword);
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(parsed.COOKIE_SECURE, "false");
  assert.equal(parsed.CONTROL_PLANE_URL, "http://127.0.0.1:8080");
  const redacted = redactEnv(text);
  assert.ok(!redacted.includes(config.dbPassword));
  assert.ok(!redacted.includes(config.adminPassword));
  assert.ok(!redacted.includes(parsed.DATABASE_URL));
  assert.ok(redacted.includes('ADMIN_PASSWORD="<redacted>"'));
});

test("dry-run reports a complete redacted plan without creating installation files", async (context) => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tma-installer-test-"));
  context.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  const installDir = path.join(temporary, "new-installation");
  const output = [];
  const originalLog = console.log;
  console.log = (...lines) => output.push(lines.join(" "));
  context.after(() => { console.log = originalLog; });
  await main(["install", "--non-interactive", "--dry-run", "--install-dir", installDir, "--admin-password", passwords.adminPassword, "--admin-password-confirm", passwords.adminPasswordConfirm, "--db-password", passwords.dbPassword]);
  const text = output.join("\n");
  assert.ok(text.includes("Dry run only"));
  assert.ok(text.includes("docker compose"));
  assert.ok(!text.includes(passwords.adminPassword));
  assert.ok(!text.includes(passwords.dbPassword));
  assert.equal(fs.existsSync(installDir), false);
});

test("plans and systemd units contain real build and startup commands", () => {
  const config = validateConfig(defaults({ ...passwords, mode: "system", origin: "http://localhost:3000" }));
  assert.ok(plan(config).steps.some((step) => step.includes("npm ci")));
  const units = systemdUnits(config);
  const posixUnits = systemdUnits({ ...config, installDir: "/srv/tma dashboard" });
  assert.match(posixUnits["tma-control-plane.service"], /ExecStart="\/srv\/tma dashboard\/bin\/control-plane"/);
  assert.match(posixUnits["tma-dashboard.service"], /EnvironmentFile="\/srv\/tma dashboard\/\.env"/);
  assert.match(units["tma-dashboard.service"], /next.* start/);
  assert.ok(plan(validateConfig(defaults({ ...passwords }))).steps.some((step) => step.includes("published Control Plane :18080/healthz")));
});

test("atomic writes replace configuration without leaving temporary files", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tma-atomic-test-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".env");
  await atomicWrite(file, "first\n");
  await atomicWrite(file, "second\n");
  assert.equal(await fs.promises.readFile(file, "utf8"), "second\n");
  assert.deepEqual(await fs.promises.readdir(directory), [".env"]);
});

test("occupied deployment ports fail before any installation files are written", async (context) => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "0.0.0.0", resolve));
  const port = listener.address().port;
  context.after(() => new Promise((resolve) => listener.close(resolve)));
  const installDir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), "tma-port-test-")), "installation");
  context.after(() => fs.promises.rm(path.dirname(installDir), { recursive: true, force: true }));
  const config = validateConfig(defaults({ ...passwords, installDir, webPort: port }));
  await assert.rejects(assertPortsFree(config), new RegExp(`port already in use: ${port}`));
  await assert.rejects(main(["install", "--non-interactive", "--install-dir", installDir, "--web-port", String(port), "--origin", `http://localhost:${port}`, "--admin-password", passwords.adminPassword, "--admin-password-confirm", passwords.adminPasswordConfirm, "--db-password", passwords.dbPassword]), /port already in use/);
  assert.equal(fs.existsSync(installDir), false);
});

test("existing Docker secrets override regenerated defaults on reinstall", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tma-preserve-test-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(directory, ".env"), 'POSTGRES_PASSWORD="existing_database_password"\nADMIN_PASSWORD="existing_admin_password"\nADMIN_USERNAME="existingadmin"\n');
  const options = { mode: "docker", installDir: directory };
  await preserveDockerSecrets(options);
  assert.equal(options.dbPassword, "existing_database_password");
  assert.equal(options.adminPassword, "existing_admin_password");
  assert.equal(options.adminUsername, "existingadmin");
  await fs.promises.writeFile(path.join(directory, ".env"), 'ALLOWED_ORIGINS="http://203.0.113.10:3000"\nWEB_PORT="3000"\nCONTROL_PLANE_PORT="18080"\n');
  await preserveDockerSecrets(options);
  assert.equal(options.origin, "http://203.0.113.10:3000");
  assert.equal(options.webPort, "3000");
  assert.equal(options.controlPlanePort, "18080");
});


test("Docker Compose ignores inherited installer and Compose overrides", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tma-compose-env-test-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(directory, ".env"), 'ALLOWED_ORIGINS="http://43.157.201.52:3000"\nWEB_PORT="3000"\nCONTROL_PLANE_PORT="18080"\n');
  const config = { installDir: directory };
  const inherited = {
    PATH: process.env.PATH,
    ALLOWED_ORIGINS: "http://localhost:3000",
    WEB_PORT: "9999",
    CONTROL_PLANE_PORT: "9998",
    DASHBOARD_HOST: "127.0.0.1",
    COMPOSE_FILE: "compose.override.yaml",
    COMPOSE_PROJECT_NAME: "wrong-project",
  };
  const clean = composeEnvironment(config, inherited);
  assert.equal(clean.ALLOWED_ORIGINS, undefined);
  assert.equal(clean.WEB_PORT, undefined);
  assert.equal(clean.CONTROL_PLANE_PORT, undefined);
  assert.equal(clean.DASHBOARD_HOST, undefined);
  assert.equal(clean.COMPOSE_FILE, undefined);
  assert.equal(clean.COMPOSE_PROJECT_NAME, undefined);
  assert.equal(clean.PATH, process.env.PATH);
});


test("Control Plane runtime settings come from the install env file, not shell interpolation", async () => {
  const compose = await fs.promises.readFile(path.join(__dirname, "..", "compose.yaml"), "utf8");
  assert.match(compose, /env_file:\s*\n\s+- \.env/);
  assert.match(compose, /env_file:\s*\n\s+- \.postgres\.env/);
  const dockerignore = await fs.promises.readFile(path.join(__dirname, "..", ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\\.postgres\\.env$/m);
  for (const key of ["DATABASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_API_TOKEN", "ALLOWED_ORIGINS", "DEV_ALLOW_ALL_ORIGINS", "COOKIE_SECURE", "TRUST_PROXY", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"]) {
    assert.equal(compose.includes(key + ": ${"), false, `${key} must come from env_file`);
  }
});
