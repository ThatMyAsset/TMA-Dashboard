"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const archiveName = "TMA-Dashboard-Setup.tar.gz";
const packageName = `thatmyassets-dashboard-${version}.tgz`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" && command === "npm", ...options });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.error}`);
  return result.stdout.replaceAll("\r\n", "\n");
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const shellOptions = { skip: process.platform === "win32" && "requires Linux/macOS shell path semantics" };

test("release installer and bundle setup pass shell syntax checks", shellOptions, () => {
  run("sh", ["-n", path.join(root, "install.sh")]);
  run("sh", ["-n", path.join(root, "setup.sh")]);
});

test("packaging builds an offline bundle with valid versioned contents", shellOptions, (context) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "tma-release-test-"));
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));
  run(process.execPath, [path.join(root, "scripts/build-release.cjs")], {
    cwd: root,
    env: { ...process.env, TMA_RELEASE_DIR: output },
  });

  const archive = path.join(output, archiveName);
  assert.ok(fs.statSync(archive).size > 0);
  assert.equal(fs.readFileSync(`${archive}.sha256`, "utf8"), `${digest(archive)}  ${archiveName}\n`);
  const entries = run("tar", ["-tzf", archive]).trim().split("\n").sort();
  const expectedFiles = [
    `TMA-Dashboard-Setup/${packageName}`,
    "TMA-Dashboard-Setup/SHA256SUMS",
    "TMA-Dashboard-Setup/setup.sh",
  ];
  for (const entry of expectedFiles) assert.ok(entries.includes(entry), `missing ${entry}`);
  assert.equal(entries.filter((entry) => entry.endsWith(".tgz")).length, 1);
  assert.ok(entries.every((entry) => entry === "TMA-Dashboard-Setup/" || entry.startsWith("TMA-Dashboard-Setup/")));

  const extracted = path.join(output, "extracted");
  fs.mkdirSync(extracted);
  run("tar", ["-xzf", archive, "-C", extracted]);
  const setup = path.join(extracted, "TMA-Dashboard-Setup/setup.sh");
  if (process.platform !== "win32") assert.ok(fs.statSync(setup).mode & 0o100, "setup.sh must be executable");
  const sums = fs.readFileSync(path.join(extracted, "TMA-Dashboard-Setup/SHA256SUMS"), "utf8");
  assert.equal(sums, `${digest(path.join(extracted, "TMA-Dashboard-Setup", packageName))}  ${packageName}\n`);
  run("sh", ["-c", "sha256sum -c SHA256SUMS"], { cwd: path.join(extracted, "TMA-Dashboard-Setup") });
  run("sh", ["-n", setup]);

  const unpackedPackage = path.join(output, "package");
  fs.mkdirSync(unpackedPackage);
  run("tar", ["-xzf", path.join(extracted, "TMA-Dashboard-Setup", packageName), "-C", unpackedPackage]);
  assert.ok(fs.existsSync(path.join(unpackedPackage, "package/bin/tma-dashboard.cjs")));
  assert.ok(fs.existsSync(path.join(unpackedPackage, "package/installer/index.cjs")));

  const temporary = path.join(output, "temporary");
  fs.mkdirSync(temporary);
  const result = spawnSync("sh", [setup, "--help"], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: temporary, npm_config_registry: "http://127.0.0.1:1/" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.deepEqual(fs.readdirSync(temporary).filter((entry) => entry.startsWith("tma-dashboard-setup.")), [], "setup must remove its temporary package");

  const downloaderTools = path.join(output, "tools");
  fs.mkdirSync(downloaderTools);
  const curl = path.join(downloaderTools, "curl");
  fs.writeFileSync(curl, `#!/bin/sh\nset -eu\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then output="$2"; shift 2; else shift; fi\ndone\ncp "$TMA_TEST_RELEASE/$output" "$output"\n`);
  fs.chmodSync(curl, 0o755);
  const downloader = spawnSync("sh", [path.join(root, "install.sh"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${downloaderTools}:${process.env.PATH}`, TMPDIR: temporary, TMA_TEST_RELEASE: output },
  });
  assert.equal(downloader.status, 0, downloader.stderr);
  assert.match(downloader.stdout, /Usage:/);
  assert.deepEqual(fs.readdirSync(temporary).filter((entry) => entry.startsWith("tma-dashboard-install.")), [], "downloader must remove its temporary directory");

  const tampered = path.join(output, "tampered");
  fs.cpSync(path.join(extracted, "TMA-Dashboard-Setup"), tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, packageName), "tampered");
  const rejected = spawnSync("sh", [path.join(tampered, "setup.sh"), "--help"], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /checksum/);
});
