#!/bin/sh
# Download and run a pinned TMA Dashboard release without using the npm registry.
# Inspect this file before running it. TMA_VERSION may select another release.
set -eu

VERSION="${TMA_VERSION:-0.1.1}"
VERSION="${VERSION#v}"
TAG="v$VERSION"
REPOSITORY="https://github.com/ThatMyAsset/TMA-Dashboard"
ARCHIVE="TMA-Dashboard-Setup.tar.gz"
BASE_URL="$REPOSITORY/releases/download/$TAG"
ROOT="TMA-Dashboard-Setup"
WORK_DIR=""

fail() {
  printf 'TMA Dashboard installer: %s\n' "$*" >&2
  exit 1
}

missing=""
for command in curl tar mktemp sha256sum node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    missing="$missing $command"
  fi
done
[ -z "$missing" ] || fail "missing required commands:$missing. Install them with your OS package manager, then retry. No runtimes or system packages were installed."
node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1)' || fail "Node.js 20 or newer is required; found $(node --version). Upgrade Node.js, then retry."

cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

umask 077
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tma-dashboard-install.XXXXXX") || fail "could not create a temporary directory"
cd "$WORK_DIR"

printf 'Downloading TMA Dashboard %s from GitHub Releases...\n' "$TAG"
curl -fL --retry 3 --output "$ARCHIVE" "$BASE_URL/$ARCHIVE"
if curl -fsSL --output "$ARCHIVE.sha256" "$BASE_URL/$ARCHIVE.sha256"; then
  sha256sum -c "$ARCHIVE.sha256"
else
  printf 'No separate release checksum found; the bundled npm archive checksum will be verified instead.\n' >&2
fi

# This release has a fixed, flat file allowlist. Reject traversal, links, and
# unexpected entries before writing anything from the archive.
listing=$(tar -tzf "$ARCHIVE") || fail "could not list the release archive"
while IFS= read -r entry; do
  case "$entry" in
    "$ROOT/"|"$ROOT/setup.sh"|"$ROOT/SHA256SUMS"|"$ROOT/thatmyassets-dashboard-$VERSION.tgz") ;;
    *) fail "unsafe or unexpected archive entry: $entry" ;;
  esac
done <<EOF
$listing
EOF
verbose_listing=$(tar -tvzf "$ARCHIVE") || fail "could not inspect the release archive"
while IFS= read -r entry; do
  case "$entry" in
    [-d]*) ;;
    *) fail "archive links and special files are not allowed: $entry" ;;
  esac
done <<EOF
$verbose_listing
EOF

tar -xzf "$ARCHIVE" --no-same-owner || fail "could not extract the release archive"
[ -f "$ROOT/setup.sh" ] || fail "release archive did not contain setup.sh"
"$ROOT/setup.sh" install "$@"
