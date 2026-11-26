"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");
const { parseArguments, collect, packageVersion, HELP } = require("./cli.cjs");
const { renderEnv, redactEnv, parseEnv } = require("./config.cjs");

const SOURCE_ENTRIES = ["cmd", "internal", "web", "compose.yaml", "Dockerfile", "Caddyfile", ".dockerignore", ".env.example", "go.mod", "go.sum", "README.md", "LICENSE"];
const executable = (name) => process.platform === "win32" ? `${name}.exe` : name;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true, shell: process.platform === "win32" && command === "npm" });
    let output = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", (error) => reject(new Error(`${command} could not run: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with ${signal || `status ${code}`}${options.capture && output ? `: ${output.trim().slice(0, 1000)}` : ""}`));
    });
  });
}

async function available(command, args = ["--version"]) {
  try { await run(command, args, { capture: true }); return true; } catch { return false; }
}

async function requireCommands(requirements) {
  const missing = [];
  for (const [command, args, label] of requirements) if (!(await available(command, args))) missing.push(label || command);
  if (!missing.length) return;
  const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  throw new Error(`missing required tools on ${platform}: ${missing.join(", ")}. Install them and ensure their commands are on PATH. Downloads: https://go.dev/dl/, https://nodejs.org/, https://www.postgresql.org/download/, https://docs.docker.com/get-docker/. No runtimes were installed.`);
}

async function atomicWrite(file, content, mode = 0o600) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temp, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temp, file);
    if (process.platform !== "win32") await fs.promises.chmod(file, mode);
  } catch (error) {
    if (handle) await handle.close();
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
}

async function copySource(destination) {
  const source = path.resolve(__dirname, "..");
  if (source === path.resolve(destination)) return;
  for (const entry of SOURCE_ENTRIES) {
    const from = path.join(source, entry);
    await fs.promises.cp(from, path.join(destination, entry), {
      recursive: true,
      force: true,
      filter: (item) => !["node_modules", ".next", ".git", "tests"].includes(path.basename(item)) && path.basename(item) !== ".env" && !item.endsWith(".tsbuildinfo"),
    });
  }
}

function composeArgs(config, ...args) {
  return ["compose", "--env-file", path.join(config.installDir, ".env"), "-f", path.join(config.installDir, "compose.yaml"), ...args];
}

async function waitForDocker(config) {
  const deadline = Date.now() + 120_000;
  let lastError = "services are not ready";
  while (Date.now() < deadline) {
    try {
      await run("docker", composeArgs(config, "exec", "-T", "dashboard", "node", "-e", "Promise.all([fetch('http://control-plane:8080/healthz'),fetch('http://127.0.0.1:3000/login')]).then(rs=>{if(rs.some(r=>r.status!==200))process.exit(1)}).catch(()=>process.exit(1))"), { cwd: config.installDir, capture: true });
      return;
    } catch (error) { lastError = error.message; }
    await sleep(2000);
  }
  throw new Error(`health check timed out: ${lastError}. Inspect with: docker compose --env-file .env ps`);
}

async function installDocker(config) {
  await requireCommands([["docker", ["--version"]], ["docker", ["compose", "version"], "Docker Compose v2"], ["docker", ["info", "--format", "{{.ServerVersion}}"], "running Docker daemon"]]);
  console.log("Build images include Go 1.23 and Node.js 22; PostgreSQL and Caddy are pinned in compose.yaml.");
  console.log("Building and starting PostgreSQL, Control Plane, Dashboard, and Caddy...");
  await run("docker", composeArgs(config, "config", "--quiet"), { cwd: config.installDir });
  await run("docker", composeArgs(config, "up", "--build", "-d"), { cwd: config.installDir });
  await waitForDocker(config);
}

function databaseUrl(config) {
  return config.databaseUrl;
}

async function configureDatabase(config) {
  const admin = new URL(config.dbAdminUrl);
  const host = admin.hostname.includes(":") && !admin.hostname.startsWith("[") ? `[${admin.hostname}]` : admin.hostname;
  admin.hostname = host;
  admin.port = admin.port || String(config.dbPort);
  const setup = path.join(__dirname, "database-setup.sql");
  console.log("Configuring the PostgreSQL role and database idempotently...");
  await run("psql", [admin.href, "-v", "ON_ERROR_STOP=1", "-q", "-f", setup, "--set", `db_name=${config.dbName}`, "--set", `db_user=${config.dbUser}`, "--set", `db_password=${config.dbPassword}`], { cwd: config.installDir });
  await run("psql", [databaseUrl(config), "-v", "ON_ERROR_STOP=1", "-q", "-c", "SELECT 1"], { cwd: config.installDir });
}

async function buildSystem(config) {
  console.log("Building the Control Plane...");
  await run("go", ["build", "-trimpath", "-o", path.join(config.installDir, "bin", executable("control-plane")), "./cmd/control-plane"], { cwd: config.installDir });
  console.log("Installing locked web dependencies and building Dashboard...");
  await run("npm", ["ci", "--omit=optional"], { cwd: path.join(config.installDir, "web") });
  await run("npm", ["run", "build"], { cwd: path.join(config.installDir, "web") });
}

function unitQuote(value, exec = false) {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", exec ? "$$" : "$")}"`;
}

const posixJoin = (...parts) => parts.join("/").replace(/\/{2,}/g, "/");

function systemdUnits(config) {
  const common = `[Unit]\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${unitQuote(config.installDir)}\nEnvironmentFile=${unitQuote(posixJoin(config.installDir, ".env"))}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\n`;
  return {
    "tma-control-plane.service": `${common}ExecStart=${unitQuote(posixJoin(config.installDir, "bin", "control-plane"), true)}\n\n[Install]\nWantedBy=multi-user.target\n`,
    "tma-dashboard.service": `${common.replace(`WorkingDirectory=${unitQuote(config.installDir)}`, `WorkingDirectory=${unitQuote(posixJoin(config.installDir, "web"))}`)}ExecStart=${unitQuote(process.execPath, true)} ${unitQuote(posixJoin(config.installDir, "web", "node_modules", "next", "dist", "bin", "next"), true)} start\n\n[Install]\nWantedBy=multi-user.target\n`,
  };
}

function serviceMode(config, requested) {
  if (requested === "local") return "local";
  if (process.platform !== "linux") {
    if (requested === "systemd") throw new Error("systemd services are available only on Linux; use --service local");
    return "local";
  }
  const runningSystemd = fs.existsSync("/run/systemd/system");
  if (process.geteuid && process.geteuid() === 0 && runningSystemd) return "systemd";
  if (requested === "systemd") throw new Error("systemd setup requires root and a running systemd instance; rerun with sudo or use --service local");
  return "local";
}

async function waitForLocal(config) {
  const deadline = Date.now() + 90_000;
  let lastError = "connection failed";
  while (Date.now() < deadline) {
    try {
      const api = await fetch(`http://127.0.0.1:${config.controlPlanePort}/healthz`, { signal: AbortSignal.timeout(3000) });
      const ui = await fetch(`http://127.0.0.1:${config.webPort}/login`, { signal: AbortSignal.timeout(3000) });
      if (api.status === 200 && ui.status === 200) return;
      lastError = `Control Plane HTTP ${api.status}; Dashboard HTTP ${ui.status}`;
    } catch (error) { lastError = error.message; }
    await sleep(1000);
  }
  throw new Error(`local health check timed out: ${lastError}. Check logs/control-plane.log and logs/dashboard.log`);
}

async function startDetached(config) {
  const pidFile = path.join(config.installDir, "run", "processes.json");
  if (fs.existsSync(pidFile)) {
    const pids = JSON.parse(await fs.promises.readFile(pidFile, "utf8"));
    const alive = Object.values(pids).every((pid) => isRunning(pid));
    if (alive && await localHealthy(config)) return false;
    for (const pid of Object.values(pids)) if (isRunning(pid)) throw new Error("an existing partial installation is still running; stop it before restarting");
  }
  await fs.promises.mkdir(path.join(config.installDir, "logs"), { recursive: true });
  await fs.promises.mkdir(path.join(config.installDir, "run"), { recursive: true });
  const env = { ...process.env, ...parseEnv(await fs.promises.readFile(path.join(config.installDir, ".env"), "utf8")), NODE_ENV: "production" };
  const pids = {};
  try {
    for (const [name, command, args, cwd] of [
      ["controlPlane", path.join(config.installDir, "bin", executable("control-plane")), [], config.installDir],
      ["dashboard", process.execPath, [path.join(config.installDir, "web", "node_modules", "next", "dist", "bin", "next"), "start"], path.join(config.installDir, "web")],
    ]) {
      const log = await fs.promises.open(path.join(config.installDir, "logs", `${name === "controlPlane" ? "control-plane" : "dashboard"}.log`), "a", 0o600);
      try {
        const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", log.fd, log.fd], windowsHide: true });
        await new Promise((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
        child.unref();
        pids[name] = child.pid;
      } finally { await log.close(); }
    }
    await atomicWrite(pidFile, `${JSON.stringify(pids, null, 2)}\n`);
    await waitForLocal(config);
    return true;
  } catch (error) {
    for (const pid of Object.values(pids).reverse()) if (isRunning(pid)) process.kill(pid, "SIGTERM");
    await fs.promises.rm(pidFile, { force: true });
    throw error;
  }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function localHealthy(config) {
  try { const [api, ui] = await Promise.all([fetch(`http://127.0.0.1:${config.controlPlanePort}/healthz`, { signal: AbortSignal.timeout(2000) }), fetch(`http://127.0.0.1:${config.webPort}/login`, { signal: AbortSignal.timeout(2000) })]); return api.status === 200 && ui.status === 200; } catch { return false; }
}
async function stopRecorded(installDir) {
  const pidFile = path.join(installDir, "run", "processes.json");
  if (!fs.existsSync(pidFile)) return;
  const pids = JSON.parse(await fs.promises.readFile(pidFile, "utf8"));
  for (const pid of Object.values(pids).reverse()) if (isRunning(pid)) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Object.values(pids).some(isRunning) && Date.now() < deadline) await sleep(200);
  if (Object.values(pids).some(isRunning)) throw new Error("existing Dashboard processes did not stop");
  await fs.promises.rm(pidFile, { force: true });
}


async function stopSystemd() {
  if (!(await available("systemctl", ["--version"]))) return;
  for (const unit of ["tma-dashboard.service", "tma-control-plane.service"]) {
    try { await run("systemctl", ["cat", unit], { capture: true }); } catch { continue; }
    await run("systemctl", ["stop", unit]);
  }
}

async function installSystem(config, requestedService) {

  await requireCommands([["go", ["version"]], ["node", ["--version"]], ["npm", ["--version"]], ["psql", ["--version"]]]);
  if (process.platform === "linux" && process.geteuid && process.geteuid() === 0 && fs.existsSync("/run/systemd/system")) await stopSystemd();
  const mode = serviceMode(config, requestedService);
  if (mode === "local") await stopRecorded(config.installDir);
  await fs.promises.mkdir(path.join(config.installDir, "bin"), { recursive: true });
  await configureDatabase(config);
  await buildSystem(config);
  if (mode === "systemd") {
    console.log("Installing and starting systemd services...");
    const units = systemdUnits(config);
    for (const [name, content] of Object.entries(units)) await atomicWrite(path.join("/etc/systemd/system", name), content, 0o644);
    await run("systemctl", ["daemon-reload"]);
    await run("systemctl", ["enable", "tma-control-plane.service", "tma-dashboard.service"]);
    await run("systemctl", ["restart", "tma-control-plane.service", "tma-dashboard.service"]);
    await waitForLocal(config);
  } else {
    console.log("Starting local background processes...");
    await startDetached(config);
  }
  return mode;
}

function plan(config) {
  const commands = config.mode === "docker" ? [
    "docker compose --env-file .env up --build -d",
    "Require Control Plane /healthz and Dashboard /login to return HTTP 200",
  ] : [
    "Configure PostgreSQL role/database with psql",
    "go build -trimpath -o bin/control-plane ./cmd/control-plane",
    "npm ci --omit=optional && npm run build (in web/)",
    "Start systemd services when available, otherwise detached local processes",
    `Require Control Plane :${config.controlPlanePort}/healthz and Dashboard :${config.webPort}/login to return HTTP 200`,
  ];
  return { mode: config.mode, installDir: config.installDir, origin: config.origin, source: "bundled with this npm package", steps: ["Copy application source", "Atomically write .env with mode 0600", ...commands] };
}

async function install(options) {
  const config = await collect(options);
  const env = renderEnv(config);
  if (options.dryRun) {
    console.log(JSON.stringify(plan(config), null, 2));
    console.log("\nRedacted configuration:\n" + redactEnv(env));
    console.log("Dry run only; no files changed and no installation commands executed.");
    return;
  }
  await fs.promises.mkdir(config.installDir, { recursive: true, mode: 0o700 });
  await copySource(config.installDir);
  await atomicWrite(path.join(config.installDir, ".env"), env);
  if (config.mode === "docker") await installDocker(config);
  const mode = config.mode === "docker" ? "docker" : await installSystem(config, options.service);
  await atomicWrite(path.join(config.installDir, "installation.json"), `${JSON.stringify({ version: packageVersion(), mode, origin: config.origin }, null, 2)}\n`);
  console.log(`\nInstallation healthy. Open ${config.origin}`);
  console.log(`Configuration: ${path.join(config.installDir, ".env")} (secrets not displayed)`);
  if (config.adminUsername) console.log(`Administrator: ${config.adminUsername}`);
  console.log("Retrieve generated bootstrap values from .env and store them securely. Existing admin passwords are not replaced on restart.");
}

async function loadLocal(installDir) {
  const metadataPath = path.join(installDir, "installation.json");
  if (!fs.existsSync(metadataPath)) throw new Error(`no installation found at ${installDir}`);
  const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
  if (metadata.mode === "docker") throw new Error(`Docker installation: run docker compose --env-file ${path.join(installDir, ".env")} -f ${path.join(installDir, "compose.yaml")} up -d`);
  if (metadata.mode === "systemd") throw new Error("systemd installation: use sudo systemctl start|stop tma-dashboard.service tma-control-plane.service");
  return metadata;
}

async function start(options) {
  const installDir = path.resolve(options.installDir || path.resolve("tma-dashboard"));
  const metadata = await loadLocal(installDir);
  const env = parseEnv(await fs.promises.readFile(path.join(installDir, ".env"), "utf8"));
  const config = { installDir, webPort: Number(env.PORT), controlPlanePort: Number(new URL(env.CONTROL_PLANE_URL).port) };
  await startDetached(config);
  console.log(`Dashboard is running at ${metadata.origin}`);
}

async function stop(options) {
  const installDir = path.resolve(options.installDir || path.resolve("tma-dashboard"));
  await loadLocal(installDir);
  if (!fs.existsSync(path.join(installDir, "run", "processes.json"))) { console.log("No local processes are recorded."); return; }
  await stopRecorded(installDir);
  console.log("Dashboard processes stopped.");
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments([...argv]);
  if (options.help) { console.log(HELP); return; }
  if (options.version) { console.log(packageVersion()); return; }
  if (command === "install") return install(options);
  if (command === "start") return start(options);
  return stop(options);
}

module.exports = { main, install, plan, copySource, atomicWrite, systemdUnits, databaseUrl, composeArgs };
