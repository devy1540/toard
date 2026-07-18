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
CAPTURE_FILE="$WORK/capture.jsonl"
FAILURE_CONTROL="$WORK/fail-prefixes"
INSTALLER="$WORK/install-personal.sh"
UNINSTALL_PERSONAL="$WORK/uninstall-personal.sh"
UNINSTALL_COMPANY="$WORK/uninstall-company.sh"
UNINSTALL_MISSING="$WORK/uninstall-missing.sh"
BIN_DIR="$HOME_DIR/.toard/bin"
CODEX_HOME_DIR="$HOME_DIR/.codex-e2e"
DOCTOR_PATH="$BIN_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SERVER_PID=
DAEMON_REGISTERED=0
if [ "${TOARD_E2E_DAEMON:-0}" = 1 ]; then
  DAEMON_REGISTERED=1
fi

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$DAEMON_REGISTERED" = 1 ] && [ -x "$BIN_DIR/toard-shim" ]; then
    HOME="$HOME_DIR" PATH="$DOCTOR_PATH" "$BIN_DIR/toard-shim" daemon uninstall >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

cursor_sent_total() {
  node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(Object.values(c.files||{}).reduce((n,v)=>n+(v.sent||0),0))' "$1"
}

mkdir -p "$HOME_DIR/.toard/state/cursors" "$RELEASE_DIR" "$CODEX_HOME_DIR/sessions/2026/07/18"
printf 'export PATH="before:$PATH"\n' > "$HOME_DIR/.zshrc"
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

node "$ROOT/.github/scripts/shim-e2e-server.mjs" "$RELEASE_DIR" "$PORT_FILE" "$CAPTURE_FILE" "$FAILURE_CONTROL" &
SERVER_PID=$!
i=0
while [ ! -s "$PORT_FILE" ]; do
  i=$((i + 1))
  if [ "$i" -ge 100 ]; then echo "E2E server did not start" >&2; exit 1; fi
  sleep 0.1
done
BASE_URL="http://127.0.0.1:$(cat "$PORT_FILE")"
COMPANY_ENDPOINT="$BASE_URL/company/api"
PERSONAL_ENDPOINT="$BASE_URL/personal/api"
MISSING_ENDPOINT="$BASE_URL/missing/api"
COMPANY_ID=$(sha256_text "$COMPANY_ENDPOINT")
PERSONAL_ID=$(sha256_text "$PERSONAL_ENDPOINT")
COMPANY_TARGET="$HOME_DIR/.toard/targets/$COMPANY_ID"
PERSONAL_TARGET="$HOME_DIR/.toard/targets/$PERSONAL_ID"

# 구버전 회사 설치와 이미 진행된 target별 상태를 만든다.
cat > "$HOME_DIR/.toard/credentials" <<EOF
agent_key=tk_company
endpoint=$COMPANY_ENDPOINT
collect_content=server_v1
collect_content_since=all
collect_tools=true
EOF
cat > "$HOME_DIR/.toard/state/cursors/codex.json" <<'EOF'
{"files":{"/legacy/already-sent.jsonl":{"mtime_ms":1,"size":2,"sent":3,"sent_hash":"legacy"}},"reconciliation_version":0}
EOF
printf '123\n' > "$HOME_DIR/.toard/state/content-since"
printf '456\n' > "$HOME_DIR/.toard/state/tool-since"

TOARD_E2E_INSTALLER="$INSTALLER" \
TOARD_E2E_UNINSTALL_PERSONAL="$UNINSTALL_PERSONAL" \
TOARD_E2E_UNINSTALL_COMPANY="$UNINSTALL_COMPANY" \
TOARD_E2E_UNINSTALL_MISSING="$UNINSTALL_MISSING" \
TOARD_E2E_PERSONAL_ENDPOINT="$PERSONAL_ENDPOINT" \
TOARD_E2E_COMPANY_ENDPOINT="$COMPANY_ENDPOINT" \
TOARD_E2E_MISSING_ENDPOINT="$MISSING_ENDPOINT" \
  pnpm --filter @toard/web exec tsx -e \
  "import { writeFileSync } from 'node:fs'; import { installScript } from './lib/shell-installer.ts'; import { uninstallScript } from './lib/shell-uninstaller.ts'; writeFileSync(process.env.TOARD_E2E_INSTALLER, installScript(process.env.TOARD_E2E_PERSONAL_ENDPOINT, false)); writeFileSync(process.env.TOARD_E2E_UNINSTALL_PERSONAL, uninstallScript(process.env.TOARD_E2E_PERSONAL_ENDPOINT)); writeFileSync(process.env.TOARD_E2E_UNINSTALL_COMPANY, uninstallScript(process.env.TOARD_E2E_COMPANY_ENDPOINT)); writeFileSync(process.env.TOARD_E2E_UNINSTALL_MISSING, uninstallScript(process.env.TOARD_E2E_MISSING_ENDPOINT));"

run_personal_installer() {
  TOKEN=$1
  TOARD_INSTALL_DAEMON=${TOARD_E2E_DAEMON:-0} \
  TOARD_SHIM_RELEASE_BASE="$BASE_URL/release" \
  TOARD_INGEST_ENDPOINT="$PERSONAL_ENDPOINT" \
  TOARD_INGEST_TOKEN="$TOKEN" \
  TOARD_SHIM_COLLECT_CONTENT=1 \
  TOARD_SHIM_COLLECT_CONTENT_SINCE=all \
  TOARD_SHIM_COLLECT_TOOLS=1 \
  TOARD_BIN_DIR="$BIN_DIR" \
  HOME="$HOME_DIR" \
  sh "$INSTALLER"
}

run_personal_installer tk_personal_old
test -x "$BIN_DIR/toard-shim"
test -d "$COMPANY_TARGET"
test -d "$PERSONAL_TARGET"
test ! -f "$HOME_DIR/.toard/credentials"
test "$(ls -1 "$HOME_DIR/.toard/targets" | wc -l | tr -d ' ')" = 2
grep -q '"sent":3' "$COMPANY_TARGET/state/cursors/codex.json"
test "$(cat "$COMPANY_TARGET/state/content-since")" = 123
test "$(cat "$COMPANY_TARGET/state/tool-since")" = 456
test ! -e "$PERSONAL_TARGET/state/content-since"
test -f "$PERSONAL_TARGET/state/tool-since"
test "$(cat "$PERSONAL_TARGET/state/tool-since")" -gt 0

# 같은 개인 endpoint 재설치는 token/policy만 갱신하고 회사 상태와 target 수를 보존한다.
run_personal_installer tk_personal_new
test "$(ls -1 "$HOME_DIR/.toard/targets" | wc -l | tr -d ' ')" = 2
grep -q '^agent_key=tk_personal_new$' "$PERSONAL_TARGET/credentials"
grep -q '"sent":3' "$COMPANY_TARGET/state/cursors/codex.json"
HOME="$HOME_DIR" PATH="$DOCTOR_PATH" "$BIN_DIR/toard-shim" targets list > "$WORK/targets.txt"
grep -q "$COMPANY_ENDPOINT" "$WORK/targets.txt"
grep -q "$PERSONAL_ENDPOINT" "$WORK/targets.txt"
if grep -q 'tk_company\|tk_personal' "$WORK/targets.txt"; then
  echo "targets list exposed a token" >&2
  exit 1
fi

ROLLOUT="$CODEX_HOME_DIR/sessions/2026/07/18/rollout.jsonl"
cat > "$ROLLOUT" <<'EOF'
{"timestamp":"2026-07-18T01:00:00Z","type":"session_meta","payload":{"session_id":"e2e-session"}}
{"timestamp":"2026-07-18T01:00:01Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}
{"timestamp":"2026-07-18T01:00:02Z","type":"event_msg","payload":{"type":"user_message","message":"first prompt"}}
{"timestamp":"2026-07-18T01:00:03Z","type":"event_msg","payload":{"type":"agent_message","message":"first answer"}}
{"timestamp":"2026-07-18T01:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10},"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}
EOF

# 회사만 503: 개인 usage/content/inventory는 전진하고 회사 usage/content는 멈춘다.
printf '/company/\n' > "$FAILURE_CONTROL"
if HOME="$HOME_DIR" CODEX_HOME="$CODEX_HOME_DIR" PATH="$DOCTOR_PATH" "$BIN_DIR/toard-shim" collect; then
  echo "company failure should make collect return non-zero" >&2
  exit 1
fi
test "$(cursor_sent_total "$COMPANY_TARGET/state/cursors/codex.json")" = 3
test "$(cursor_sent_total "$PERSONAL_TARGET/state/cursors/codex.json")" = 1
test ! -f "$COMPANY_TARGET/state/cursors/codex-content.json"
test "$(cursor_sent_total "$PERSONAL_TARGET/state/cursors/codex-content.json")" = 2
test -f "$PERSONAL_TARGET/state/tool-inventory.json"
test ! -f "$COMPANY_TARGET/state/tool-inventory.json"

cat >> "$ROLLOUT" <<'EOF'
{"timestamp":"2026-07-18T01:01:02Z","type":"event_msg","payload":{"type":"user_message","message":"second prompt"}}
{"timestamp":"2026-07-18T01:01:03Z","type":"event_msg","payload":{"type":"agent_message","message":"second answer"}}
{"timestamp":"2026-07-18T01:01:04Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"cached_input_tokens":40,"output_tokens":20},"total_token_usage":{"input_tokens":300,"output_tokens":30}}}}
{"timestamp":"2026-07-18T01:01:05Z","type":"response_item","payload":{"type":"function_call","name":"mcp__demo__tool","call_id":"call-1","status":"completed"}}
EOF
# 첫 수집 때 개인 target에 기록된 현재 시각보다 fixture의 고정 시각이
# 이르더라도 두 target 모두 동일한 tool event를 검증할 수 있게 한다.
printf '0\n' > "$COMPANY_TARGET/state/tool-since"
printf '0\n' > "$PERSONAL_TARGET/state/tool-since"
rm -f "$FAILURE_CONTROL"
HOME="$HOME_DIR" CODEX_HOME="$CODEX_HOME_DIR" PATH="$DOCTOR_PATH" "$BIN_DIR/toard-shim" collect

test "$(cursor_sent_total "$COMPANY_TARGET/state/cursors/codex.json")" = 2
test "$(cursor_sent_total "$PERSONAL_TARGET/state/cursors/codex.json")" = 2
test "$(cursor_sent_total "$COMPANY_TARGET/state/cursors/codex-content.json")" = 4
test "$(cursor_sent_total "$PERSONAL_TARGET/state/cursors/codex-content.json")" = 4
test "$(cursor_sent_total "$COMPANY_TARGET/state/cursors/codex-tools.json")" = 1
test "$(cursor_sent_total "$PERSONAL_TARGET/state/cursors/codex-tools.json")" = 1
grep -q '"reconciliation_version": 1' "$COMPANY_TARGET/state/cursors/codex.json"
grep -q '"reconciliation_version": 1' "$PERSONAL_TARGET/state/cursors/codex.json"

node - "$CAPTURE_FILE" <<'EOF'
const fs = require("fs");
const assert = require("assert/strict");
const records = fs.readFileSync(process.argv[2], "utf8").trim().split(/\n/).filter(Boolean).map(JSON.parse);
for (const record of records) {
  assert.equal(record.authorizationScheme, "Bearer");
  assert.match(record.bodyHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(record, "body"), false);
  assert.equal(Object.hasOwn(record, "token"), false);
}
const by = (prefix, suffix) => records.filter((record) => record.path.includes(`/${prefix}/`) && record.path.endsWith(suffix));
const companyEvents = by("company", "/v1/events");
const personalEvents = by("personal", "/v1/events");
assert.ok(companyEvents.length >= 2);
assert.ok(personalEvents.length >= 2);
assert.notEqual(companyEvents.at(-1).bodyHash, personalEvents.at(-1).bodyHash);
assert.ok(by("company", "/v1/prompts").length >= 2);
assert.ok(by("personal", "/v1/prompts").length >= 2);
assert.ok(by("company", "/v1/tool-events").length >= 1);
assert.ok(by("personal", "/v1/tool-events").length >= 1);
assert.ok(by("company", "/v1/tool-inventory").length >= 2);
// 개인 target은 첫 성공 때 snapshot을 기록하므로 변경 없는 두 번째 수집은 재전송하지 않는다.
assert.ok(by("personal", "/v1/tool-inventory").length >= 1);
EOF
if grep -q 'tk_company\|tk_personal\|first prompt\|second prompt' "$CAPTURE_FILE"; then
  echo "capture file stored token or body plaintext" >&2
  exit 1
fi

# 서버별 제거: 개인 제거와 없는 target 제거는 회사 shim/daemon/PATH를 유지한다.
HOME="$HOME_DIR" PATH="$DOCTOR_PATH" sh "$UNINSTALL_PERSONAL"
test ! -d "$PERSONAL_TARGET"
test -d "$COMPANY_TARGET"
test -x "$BIN_DIR/toard-shim"
grep -q 'toard shim' "$HOME_DIR/.zshrc"
if [ "${TOARD_E2E_DAEMON:-0}" = 1 ]; then
  HOME="$HOME_DIR" PATH="$DOCTOR_PATH" "$BIN_DIR/toard-shim" daemon status
fi

HOME="$HOME_DIR" PATH="$DOCTOR_PATH" sh "$UNINSTALL_MISSING"
test -d "$COMPANY_TARGET"
test -x "$BIN_DIR/toard-shim"
grep -q 'toard shim' "$HOME_DIR/.zshrc"

HOME="$HOME_DIR" PATH="$DOCTOR_PATH" sh "$UNINSTALL_COMPANY"
test ! -e "$BIN_DIR/toard-shim"
test ! -e "$HOME_DIR/.toard/targets"
test ! -e "$HOME_DIR/.toard/legacy-backup"
test -f "$ROLLOUT"
if grep -q 'toard shim' "$HOME_DIR/.zshrc"; then
  echo "last target cleanup left the marked PATH line" >&2
  exit 1
fi

echo "multi-target Unix installer lifecycle E2E passed"
