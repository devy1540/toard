#!/bin/sh
set -eu

BINARY=${1:?usage: test-shim-installer-unix.sh <shim-binary>}
case "$BINARY" in
  /*) ;;
  *) BINARY="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")" ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"
TMP_BASE=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
WORK=$(mktemp -d "$TMP_BASE/toard-shim-e2e.XXXXXX")
HOME_DIR="$WORK/home"
RELEASE_DIR="$WORK/release"
PORT_FILE="$WORK/port"
INSTALLER="$WORK/install.sh"
BIN_DIR="$HOME_DIR/.toard/bin"
DOCTOR_PATH="$BIN_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SERVER_PID=
DAEMON_REGISTERED=0
if [ "${TOARD_E2E_DAEMON:-0}" = 1 ]; then
  DAEMON_REGISTERED=1
fi

cleanup() {
  if [ "$DAEMON_REGISTERED" = 1 ] && [ -x "$BIN_DIR/toard-shim" ]; then
    HOME="$HOME_DIR" PATH="$DOCTOR_PATH" "$BIN_DIR/toard-shim" daemon uninstall >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$HOME_DIR" "$RELEASE_DIR"
case "$(uname -s):$(uname -m)" in
  Darwin:x86_64) ASSET=toard-shim-x86_64-apple-darwin ;;
  Darwin:arm64|Darwin:aarch64) ASSET=toard-shim-aarch64-apple-darwin ;;
  Linux:x86_64|Linux:amd64) ASSET=toard-shim-x86_64-unknown-linux-gnu ;;
  Linux:arm64|Linux:aarch64) ASSET=toard-shim-aarch64-unknown-linux-gnu ;;
  *) echo "unsupported E2E host: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

cp "$BINARY" "$RELEASE_DIR/$ASSET"
cp "$ROOT/shim/install.sh" "$RELEASE_DIR/install.sh"
if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$RELEASE_DIR/$ASSET" | awk '{print $1}')
else
  HASH=$(shasum -a 256 "$RELEASE_DIR/$ASSET" | awk '{print $1}')
fi
printf '%s  %s\n' "$HASH" "$ASSET" > "$RELEASE_DIR/SHA256SUMS"

node "$ROOT/.github/scripts/shim-e2e-server.mjs" "$RELEASE_DIR" "$PORT_FILE" &
SERVER_PID=$!
i=0
while [ ! -s "$PORT_FILE" ]; do
  i=$((i + 1))
  if [ "$i" -ge 100 ]; then echo "E2E server did not start" >&2; exit 1; fi
  sleep 0.1
done
BASE_URL="http://127.0.0.1:$(cat "$PORT_FILE")"

TOARD_E2E_INSTALLER="$INSTALLER" TOARD_E2E_ENDPOINT="$BASE_URL/api" \
  pnpm --filter @toard/web exec tsx -e \
  "import { writeFileSync } from 'node:fs'; import { installScript } from './lib/shell-installer.ts'; writeFileSync(process.env.TOARD_E2E_INSTALLER, installScript(process.env.TOARD_E2E_ENDPOINT, false));"

TOARD_INSTALL_DAEMON=${TOARD_E2E_DAEMON:-0} \
TOARD_SHIM_RELEASE_BASE="$BASE_URL/release" \
TOARD_INGEST_ENDPOINT="$BASE_URL/api" \
TOARD_INGEST_TOKEN=tk_e2e_test \
TOARD_SHIM_COLLECT_CONTENT=1 \
TOARD_BIN_DIR="$BIN_DIR" \
HOME="$HOME_DIR" \
sh "$INSTALLER"

test -x "$BIN_DIR/toard-shim"
test -x "$BIN_DIR/claude"
test -x "$BIN_DIR/codex"
test "$(sed -n '1p' "$HOME_DIR/.toard/credentials")" = "agent_key=tk_e2e_test"
test "$(sed -n '2p' "$HOME_DIR/.toard/credentials")" = "endpoint=$BASE_URL/api"
test "$(sed -n '3p' "$HOME_DIR/.toard/credentials")" = "collect_content=true"
test "$(wc -l < "$HOME_DIR/.toard/credentials" | tr -d ' ')" = 3

HOME="$HOME_DIR" PATH="$DOCTOR_PATH" "$BIN_DIR/toard-shim" doctor
if [ "${TOARD_E2E_DAEMON:-0}" = 1 ]; then
  HOME="$HOME_DIR" PATH="$DOCTOR_PATH" "$BIN_DIR/toard-shim" daemon status
fi
