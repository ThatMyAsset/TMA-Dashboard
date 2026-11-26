"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const version = pkg.version;
const packageName = `thatmyassets-dashboard-${version}.tgz`;
const releaseName = "TMA-Dashboard-Setup";
const archiveName = `${releaseName}.tar.gz`;
const outputDirectory = path.resolve(root, process.env.TMA_RELEASE_DIR || "release");
const staging = path.join(outputDirectory, ".staging");
const bundleDirectory = path.join(staging, releaseName);
const archive = path.join(outputDirectory, archiveName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root, env: options.env || process.env, input: options.input,
    encoding: "utf8",
    shell: options.shell ?? (process.platform === "win32" && command === "npm"),
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) { if (result.stderr) process.stderr.write(result.stderr); if (result.stdout) process.stdout.write(result.stdout); throw new Error(`${command} exited with status ${result.status}`); }
  return result.stdout.trim();
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(bundleDirectory, { recursive: true });
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", bundleDirectory]));
  if (packed.length !== 1 || packed[0].filename !== packageName) throw new Error(`unexpected npm package ${packed.map((item) => item.filename).join(", ")}`);

  const setup = fs.readFileSync(path.join(root, "setup.sh"), "utf8").replace(/^VERSION=".*"$/m, `VERSION="${version}"`);
  if (!setup.includes(`VERSION="${version}"`)) throw new Error("setup.sh version placeholder not found");
  fs.writeFileSync(path.join(bundleDirectory, "setup.sh"), setup);
  fs.chmodSync(path.join(bundleDirectory, "setup.sh"), 0o755);
  const checksum = `${digest(path.join(bundleDirectory, packageName))}  ${packageName}\n`;
  fs.writeFileSync(path.join(bundleDirectory, "SHA256SUMS"), checksum);

  const wslPath = (value) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
  if (process.platform === "win32") {
    run("wsl.exe", ["-d", "Ubuntu-22.04", "--", "bash", "-c", `set -eux; work=$(mktemp -d); cp -R '${wslPath(staging)}/${releaseName}' "$work/"; chmod 755 "$work/${releaseName}"; find "$work/${releaseName}" -type f -exec chmod 644 {} +; chmod 755 "$work/${releaseName}/setup.sh"; tar -czf '${wslPath(archive)}' -C "$work" '${releaseName}'; rm -rf "$work"`], { shell: true });
  } else {
    run("tar", ["-czf", archive, "-C", staging, releaseName]);
  }
  fs.writeFileSync(`${archive}.sha256`, `${digest(archive)}  ${archiveName}\n`);
  console.log(`Built ${archive}`);
  console.log(`Built ${archive}.sha256`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
