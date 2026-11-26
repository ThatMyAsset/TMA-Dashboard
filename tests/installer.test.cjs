"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { defaults, validateConfig, renderEnv, parseEnv, redactEnv, parseOrigin } = require("../installer/config.cjs");
const { parseArguments, collect } = require("../installer/cli.cjs");
const { main, plan, systemdUnits, atomicWrite } = require("../installer/index.cjs");

const passwords = { adminPassword: "correct-horse-battery", adminPasswordConfirm: "correct-horse-battery", dbPassword: "database_password_12345" };

test("noninteractive arguments and environment create a valid configuration", async () => {
  const parsed = parseArguments(["install", "--non-interactive", "--mode", "docker", "--https-port=8443", "--origin", "https://localhost:8443"], {});
  const config = await collect({ ...parsed.options, ...passwords });
  assert.equal(config.mode, "docker");
  assert.equal(config.httpsPort, 8443);
  assert.equal(config.siteAddress, "localhost:8443");
  assert.ok(config.adminApiToken === "");

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
  assert.throws(() => validateConfig(defaults({ ...passwords, httpsPort: "0", origin: "https://localhost" })), /HTTPS port/);
  assert.throws(() => validateConfig(defaults({ ...passwords, adminUsername: "Admin User" })), /admin username/);
  assert.throws(() => validateConfig(defaults({ ...passwords, dbPassword: "unsafe:password_12345" })), /URL-safe/);
  assert.throws(() => validateConfig(defaults({ ...passwords, mode: "system", origin: "https://localhost:3000" })), /local HTTP/);
  assert.throws(() => validateConfig(defaults({ ...passwords, origin: "https://localhost:8443" })), /origin port/);
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
