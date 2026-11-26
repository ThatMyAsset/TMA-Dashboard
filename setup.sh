#!/bin/sh
# Runs from a TMA-Dashboard-Setup release bundle; no npm registry is contacted.
set -eu

BUNDLE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION="0.1.0"
PACKAGE="thatmyassets-dashboard-$VERSION.tgz"
INSTALL_DIR=""
CLI=""

cleanup() {
  [ -z "$INSTALL_DIR" ] || rm -rf -- "$INSTALL_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

fail() {
  printf 'TMA Dashboard setup: %s\n' "$*" >&2
  exit 1
}

missing=""
for command in mktemp sha256sum node npm; do
  command -v "$command" >/dev/null 2>&1 || missing="$missing $command"
done
[ -z "$missing" ] || fail "missing required commands:$missing. Install them with your OS package manager, then retry. No runtimes or system packages were installed."
node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1)' || fail "Node.js 20 or newer is required; found $(node --version). Upgrade Node.js, then retry."
[ -f "$BUNDLE_DIR/$PACKAGE" ] || fail "missing bundled package $PACKAGE"
[ -f "$BUNDLE_DIR/SHA256SUMS" ] || fail "missing bundled SHA256SUMS"

umask 077
INSTALL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tma-dashboard-setup.XXXXXX") || fail "could not create a temporary directory"
CLI="$INSTALL_DIR/package/bin/tma-dashboard"
(
  cd "$BUNDLE_DIR"
  sha256sum -c --ignore-missing SHA256SUMS
) || fail "bundled package checksum verification failed"

# npm installs the supplied local archive directly. This never resolves a
# package name or version from the registry.
npm install --global --offline --ignore-scripts --no-audit --no-fund --prefix "$INSTALL_DIR/package" "$BUNDLE_DIR/$PACKAGE" || fail "could not install the bundled CLI"
[ -f "$CLI" ] || fail "the bundled CLI was not installed"
node "$CLI" "$@"
