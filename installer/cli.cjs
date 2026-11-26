"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { defaults, validateConfig, secret } = require("./config.cjs");

const HELP = `ThatMyAssets Dashboard installer

Usage:
  tma-dashboard install [options]
  tma-dashboard start [--install-dir PATH]
  tma-dashboard stop [--install-dir PATH]

Commands:
  install       Configure, build, and start Dashboard (default)
  start         Start an existing local-process installation
  stop          Stop an existing local-process installation

Options:
  --mode docker|system          Deployment mode (default: docker)
  --install-dir PATH            Installation directory (default: ./tma-dashboard)
  --origin URL                  Browser HTTP(S) origin, without a path
  --web-port PORT               Dashboard HTTP port (default: 3000)
  --control-plane-port PORT     System Control Plane port (default: 8080)
  --admin-name NAME             Initial administrator name (default: admin)
  --admin-password VALUE        Initial administrator password (12–72 bytes)
  --admin-password-confirm VALUE  Password confirmation for noninteractive installs
  --admin-api-token VALUE       Optional URL-safe automation token (32+ characters)
  --generate-admin-api-token    Generate an automation token without displaying it
  --db-name NAME                PostgreSQL database (default: tma)
  --db-user NAME                PostgreSQL application role (default: tma)
  --db-password VALUE           Application database password (16–128 bytes)
  --db-host HOST                System PostgreSQL host (default: 127.0.0.1)
  --db-port PORT                PostgreSQL port (default: 5432)
  --db-admin-url URL            PostgreSQL superuser URL for system setup
  --non-interactive, --yes      Never prompt; flags/env supply required overrides
  --dry-run                     Print a redacted plan; make no changes
  --service auto|systemd|local  System service mode (default: auto)
  --help, -h                    Show this help
  --version, -v                 Show package version

Environment equivalents use the TMA_ prefix and uppercase flag names:
  TMA_MODE, TMA_INSTALL_DIR, TMA_ORIGIN, TMA_ADMIN_NAME,
  TMA_ADMIN_PASSWORD, TMA_ADMIN_PASSWORD_CONFIRM, TMA_ADMIN_API_TOKEN,
  TMA_DB_NAME, TMA_DB_USER, TMA_DB_PASSWORD, TMA_DB_HOST, TMA_DB_PORT,
  TMA_DB_ADMIN_URL, TMA_WEB_PORT, TMA_CONTROL_PLANE_PORT,
  TMA_NON_INTERACTIVE, TMA_SERVICE,
  TMA_GENERATE_ADMIN_API_TOKEN, TMA_DRY_RUN.

Secrets are never printed. Bootstrap values are stored in the protected .env
file; store your own copies securely. Docker passwords must be URL-safe.
PostgreSQL superuser credentials should come from TMA_DB_ADMIN_URL or a
protected .pgpass file, not shell history.
`;

const FLAGS = {
  "mode": "mode", "install-dir": "installDir", "origin": "origin",
  "web-port": "webPort", "control-plane-port": "controlPlanePort",
  "admin-password": "adminPassword", "admin-password-confirm": "adminPasswordConfirm",
  "admin-api-token": "adminApiToken", "db-name": "dbName", "db-user": "dbUser",
  "db-password": "dbPassword", "db-host": "dbHost", "db-port": "dbPort",
  "db-admin-url": "dbAdminUrl", "service": "service",
};
const ENV_KEYS = Object.fromEntries(Object.entries(FLAGS).map(([flag, key]) => [key, `TMA_${flag.replaceAll("-", "_").toUpperCase()}`]));
ENV_KEYS.adminUsername = "TMA_ADMIN_NAME";
const BOOLEAN_FLAGS = new Set(["dry-run", "non-interactive", "yes", "generate-admin-api-token", "help", "version"]);

function parseArguments(argv, env = process.env) {
  const options = {};
  let command = "install";
  if (argv[0] && !argv[0].startsWith("-")) {
    command = argv.shift();
    if (!["install", "start", "stop"].includes(command)) throw new Error(`unknown command: ${command}`);
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) { options.help = true; continue; }
    if (["--version", "-v"].includes(argument)) { options.version = true; continue; }
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const equal = argument.indexOf("=");
    const flag = argument.slice(2, equal < 0 ? undefined : equal);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (equal >= 0) throw new Error(`--${flag} does not take a value`);
      options[flag === "yes" ? "nonInteractive" : flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    const key = FLAGS[flag];
    if (!key) throw new Error(`unknown option: --${flag}`);
    const value = equal >= 0 ? argument.slice(equal + 1) : argv[++index];
    if (value === undefined || value === "") throw new Error(`--${flag} requires a value`);
    options[key] = value;
  }
  for (const [key, variable] of Object.entries(ENV_KEYS)) {
    if (options[key] === undefined && env[variable] !== undefined) options[key] = env[variable];
  }
  if (options.nonInteractive === undefined && /^(1|true|yes)$/i.test(env.TMA_NON_INTERACTIVE || "")) options.nonInteractive = true;
  if (env.CI === "true" && options.nonInteractive === undefined) options.nonInteractive = true;
  if (/^(1|true|yes)$/i.test(env.TMA_GENERATE_ADMIN_API_TOKEN || "")) options.generateAdminApiToken = true;
  if (/^(1|true|yes)$/i.test(env.TMA_DRY_RUN || "")) options.dryRun = true;
  if (!["auto", "systemd", "local", undefined].includes(options.service)) throw new Error("service must be auto, systemd, or local");
  if (command !== "install" && Object.keys(options).some((key) => !["installDir", "help", "version", "nonInteractive"].includes(key))) {
    throw new Error(`${command} accepts only --install-dir, --help, and --version`);
  }
  return { command, options };
}

async function collect(options) {
  const interactive = !options.nonInteractive;
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("interactive setup requires a TTY; use --non-interactive with flags or environment variables");
  const config = defaults(options);
  let rl;
  rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (question, fallback) => {
    if (!interactive) return fallback;
    const suffix = fallback === "" ? " (blank to disable)" : fallback !== undefined ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
  };
  const askSecret = async (label, supplied, confirmation, generate, allowBlank = false) => {
    if (supplied !== undefined) {
      if (options.nonInteractive && confirmation !== supplied) throw new Error(`${label} confirmation does not match`);
      return supplied;
    }
    if (!interactive) return allowBlank ? "" : generate();
    while (true) {
      const value = (await rl.question(`${label} (leave blank to generate${allowBlank ? " or disable" : ""}): `)).trim();
      const again = (await rl.question(`Confirm ${label.toLowerCase()}${value ? "" : " (blank again to accept default)"}: `)).trim();
      if (value !== again) { console.error("Values do not match; try again."); continue; }
      if (!value && allowBlank) return "";
      return value || (allowBlank ? "" : generate());
    }
  };
  try {
    if (interactive) {
      config.mode = (await ask("Deployment mode: docker or system", config.mode)).toLowerCase();
      config.installDir = await ask("Installation directory", config.installDir);
      config.webPort = Number(await ask("Dashboard HTTP port", config.webPort));
      if (config.mode === "docker") {
        config.origin = await ask("Browser origin (use --origin for noninteractive installs)", config.origin);
      } else {
        config.controlPlanePort = Number(await ask("Control Plane port", config.controlPlanePort));
        config.origin = await ask("Browser origin", `http://localhost:${config.webPort}`);
      }
    }
    config.adminUsername = await ask("Administrator username", config.adminUsername);
    config.adminPassword = await askSecret("Administrator password", options.adminPassword, options.adminPasswordConfirm, () => secret(24));
    if ((interactive && !options.generateAdminApiToken) || options.adminApiToken === "generate") config.adminApiToken = await askSecret("Optional admin API token (type 'generate' to create one)", options.adminApiToken, options.adminApiTokenConfirm, () => "", true);
    if (config.adminApiToken === "generate") config.adminApiToken = secret();
    if (options.generateAdminApiToken) config.adminApiToken = secret();
    if (interactive) {
      config.dbPassword = await askSecret("PostgreSQL application password", options.dbPassword, options.dbPasswordConfirm, () => secret());
      if (config.mode === "system") {
        config.dbHost = await ask("PostgreSQL host", config.dbHost);
        config.dbPort = Number(await ask("PostgreSQL port", config.dbPort));
        config.dbName = await ask("PostgreSQL database", config.dbName);
        config.dbUser = await ask("PostgreSQL application role", config.dbUser);
        config.dbAdminUrl = await ask("PostgreSQL superuser URL (credentials can use .pgpass)", config.dbAdminUrl);
      }
    }
  } finally {
    if (rl) rl.close();
  }
  return validateConfig(config);
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
}

module.exports = { parseArguments, collect, packageVersion, HELP };
