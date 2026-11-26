"use strict";

const { randomBytes } = require("node:crypto");
const path = require("node:path");

const SECRET_KEYS = new Set(["ADMIN_PASSWORD", "POSTGRES_PASSWORD", "ADMIN_API_TOKEN", "DATABASE_URL", "DB_ADMIN_URL"]);
const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");
const integer = (value, name) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return number;
};

function parseOrigin(value) {
  let origin;
  try { origin = new URL(value); } catch { throw new Error("origin must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("origin must contain only an HTTP(S) scheme, host, and optional port");
  }
  if (origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("HTTP origins are allowed only for localhost; use HTTPS for a named host");
  }
  return origin.origin;
}

function validateSecret(value, name, minimum = 12, maximum = 72) {
  const length = Buffer.byteLength(value);
  if (length < minimum || length > maximum) throw new Error(`${name} must contain ${minimum}–${maximum} bytes`);
  if (!/^[\x20-\x7e]+$/.test(value) || /["'$\\]/.test(value)) {
    throw new Error(`${name} must use printable ASCII without double quotes, single quotes, dollar signs, or backslashes`);
  }
  return value;
}

function validateConfig(config) {
  if (!["docker", "system"].includes(config.mode)) throw new Error("mode must be docker or system");
  if (!config.installDir || /[\0\r\n]/.test(config.installDir)) throw new Error("install directory is invalid");
  config.installDir = path.resolve(config.installDir);
  config.origin = parseOrigin(config.origin);
  const parsed = new URL(config.origin);
  config.siteAddress = parsed.host;
  config.secureCookies = parsed.protocol === "https:";
  config.httpPort = integer(config.httpPort, "HTTP port");
  config.httpsPort = integer(config.httpsPort, "HTTPS port");
  config.webPort = integer(config.webPort, "web port");
  config.controlPlanePort = integer(config.controlPlanePort, "Control Plane port");
  config.dbPort = integer(config.dbPort, "PostgreSQL port");
  if (new Set([config.webPort, config.controlPlanePort]).size !== 2) throw new Error("web and Control Plane ports must differ");
  if (config.mode === "system" && config.secureCookies) throw new Error("system mode serves local HTTP only; use Docker mode for public HTTPS");
  if (config.mode === "system" && parsed.port && Number(parsed.port) !== config.webPort) throw new Error("system origin port must match the web port");
  if (config.mode === "docker" && parsed.port && Number(parsed.port) !== config.httpsPort) throw new Error("Docker origin port must match the HTTPS port");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(config.adminUsername)) throw new Error("admin username must start with a lowercase letter and contain only lowercase letters, numbers, and underscores");
  validateSecret(config.adminPassword, "admin password");
  validateSecret(config.dbPassword, "database password", 16, 128);
  if (config.mode === "docker" && !/^[A-Za-z0-9_-]+$/.test(config.dbPassword)) throw new Error("Docker database password must use URL-safe letters, numbers, underscores, or hyphens");
  if (config.adminApiToken && !/^[A-Za-z0-9_-]{32,256}$/.test(config.adminApiToken)) throw new Error("admin API token must contain 32–256 URL-safe characters, or be empty");
  if (config.mode === "system" && !config.secureCookies) console.warn("WARNING: local HTTP mode sends credentials without TLS. Keep it on localhost or place a trusted HTTPS reverse proxy in front before remote use.");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(config.dbName)) throw new Error("database name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(config.dbUser)) throw new Error("database user must start with a lowercase letter and contain only lowercase letters, numbers, and underscores");
  if (!/^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i.test(config.dbHost)) throw new Error("database host is invalid");
  config.databaseUrl = renderDatabaseUrl(config);
  if (config.mode === "system") {
    let admin;
    try { admin = new URL(config.dbAdminUrl); } catch { throw new Error("database administrator URL is invalid"); }
    if (!["postgres:", "postgresql:"].includes(admin.protocol) || admin.pathname.length < 2) throw new Error("database administrator URL must be a PostgreSQL connection URL including a database");
  }
  return config;
}

function defaults(options = {}) {
  const docker = (options.mode || "docker") === "docker";
  const httpsPort = options.httpsPort || 443;
  const webPort = options.webPort || 3000;
  return {
    mode: docker ? "docker" : "system",
    installDir: options.installDir || path.resolve("tma-dashboard"),
    origin: options.origin || (docker ? `https://localhost:${httpsPort}` : `http://localhost:${webPort}`),
    httpPort: options.httpPort || 80,
    httpsPort,
    webPort,
    controlPlanePort: options.controlPlanePort || 8080,
    dbHost: options.dbHost || "127.0.0.1",
    dbPort: options.dbPort || 5432,
    dbName: options.dbName || "tma",
    dbUser: options.dbUser || "tma",
    dbPassword: options.dbPassword || secret(),
    dbAdminUrl: options.dbAdminUrl || "postgres://postgres@127.0.0.1:5432/postgres",
    adminUsername: options.adminUsername || "admin",
    adminPassword: options.adminPassword || secret(24),
    adminApiToken: options.adminApiToken || "",
  };
}

function renderDatabaseUrl(config) {
  const host = config.dbHost.includes(":") && !config.dbHost.startsWith("[") ? `[${config.dbHost}]` : config.dbHost;
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(config.dbHost.toLowerCase());
  return `postgres://${encodeURIComponent(config.dbUser)}:${encodeURIComponent(config.dbPassword)}@${host}:${config.dbPort}/${encodeURIComponent(config.dbName)}?sslmode=${local ? "disable" : "require"}`;
}

function renderEnv(config) {
  const values = {
    POSTGRES_DB: config.dbName,
    POSTGRES_USER: config.dbUser,
    POSTGRES_PASSWORD: config.dbPassword,
    ADMIN_USERNAME: config.adminUsername,
    ADMIN_PASSWORD: config.adminPassword,
    ADMIN_API_TOKEN: config.adminApiToken,
    SITE_ADDRESS: config.siteAddress,
    HTTP_PORT: String(config.httpPort),
    HTTPS_PORT: String(config.httpsPort),
    ALLOWED_ORIGINS: config.origin,
    COOKIE_SECURE: String(config.secureCookies),
    TRUST_PROXY: "false",
  };
  if (config.mode === "system") Object.assign(values, {
    DATABASE_URL: config.databaseUrl,
    LISTEN_ADDR: `127.0.0.1:${config.controlPlanePort}`,
    CONTROL_PLANE_URL: `http://127.0.0.1:${config.controlPlanePort}`,
    HOSTNAME: "127.0.0.1",
    PORT: String(config.webPort),
  });
  return `${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
}

function parseEnv(text) {
  const result = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`invalid environment file at line ${index + 1}`);
    try { result[match[1]] = JSON.parse(match[2]); } catch { result[match[1]] = match[2]; }
  }
  return result;
}

function redactEnv(text) {
  return text.split(/\r?\n/).map((line) => {
    const key = line.split("=", 1)[0];
    return SECRET_KEYS.has(key) && !line.endsWith('=""') ? `${key}="<redacted>"` : line;
  }).join("\n");
}

module.exports = { defaults, validateConfig, validateSecret, parseOrigin, renderEnv, parseEnv, redactEnv, secret, integer };
