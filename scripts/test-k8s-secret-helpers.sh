#!/usr/bin/env bash
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly test_root="$(mktemp -d "${TMPDIR:-/tmp}/toard-secret-helper-test.XXXXXX")"
readonly mock_bin="$test_root/bin"
readonly mock_log="$test_root/mock.log"
readonly command_output="$test_root/command-output.log"

cleanup() {
  rm -r -- "$test_root"
}
trap cleanup EXIT

mkdir -p "$mock_bin"

cat >"$mock_bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

printf 'kubectl' >>"$MOCK_LOG"
printf ' %q' "$@" >>"$MOCK_LOG"
printf '\n' >>"$MOCK_LOG"

joined=" $* "
ignore_not_found=0
if [[ "$joined" == *" --ignore-not-found "* ]]; then
  ignore_not_found=1
fi

if [[ "$joined" == *" get secret toard-secrets "* ]]; then
  case "$MOCK_SCENARIO" in
    toard_existing) printf '%s\n' 'secret/toard-secrets' ;;
    toard_get_error) exit 42 ;;
  esac
  if [[ "$MOCK_SCENARIO" != "toard_existing" ]]; then
    (( ignore_not_found )) || exit 1
  fi
  exit 0
fi

if [[ "$joined" == *" get statefulset postgres "* ]]; then
  case "$MOCK_SCENARIO" in
    toard_statefulset) printf '%s\n' 'statefulset.apps/postgres' ;;
    toard_statefulset_get_error) exit 42 ;;
  esac
  if [[ "$MOCK_SCENARIO" != "toard_statefulset" ]]; then
    (( ignore_not_found )) || exit 1
  fi
  exit 0
fi

if [[ "$joined" == *" get persistentvolumeclaim data-postgres-0 "* ]]; then
  case "$MOCK_SCENARIO" in
    toard_pvc) printf '%s\n' 'persistentvolumeclaim/data-postgres-0' ;;
    toard_pvc_get_error) exit 42 ;;
  esac
  if [[ "$MOCK_SCENARIO" != "toard_pvc" ]]; then
    (( ignore_not_found )) || exit 1
  fi
  exit 0
fi

if [[ "$joined" == *" get secret tunnel-token "* ]]; then
  case "$MOCK_SCENARIO" in
    tunnel_existing) printf '%s\n' 'secret/tunnel-token' ;;
    tunnel_get_error) exit 42 ;;
  esac
  if [[ "$MOCK_SCENARIO" != "tunnel_existing" ]]; then
    (( ignore_not_found )) || exit 1
  fi
  exit 0
fi

exit 0
MOCK

cat >"$mock_bin/openssl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'mock-generated-value'
MOCK

cat >"$mock_bin/cloudflared" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'cloudflared token fetched' >>"$MOCK_LOG"
printf '%s\n' 'mock-tunnel-token'
MOCK

chmod +x "$mock_bin/kubectl" "$mock_bin/openssl" "$mock_bin/cloudflared"

failures=0

fail() {
  echo "not ok - $1" >&2
  failures=$((failures + 1))
}

pass() {
  echo "ok - $1"
}

assert_log_contains() {
  local description="$1"
  local expected="$2"

  if ! grep -Fq -- "$expected" "$mock_log"; then
    fail "$description"
    return 1
  fi
}

assert_log_not_contains() {
  local description="$1"
  local unexpected="$2"

  if grep -Fq -- "$unexpected" "$mock_log"; then
    fail "$description"
    return 1
  fi
}

run_helper() {
  local scenario="$1"
  local helper="$2"

  : >"$mock_log"
  : >"$command_output"
  env \
    PATH="$mock_bin:$PATH" \
    MOCK_LOG="$mock_log" \
    MOCK_SCENARIO="$scenario" \
    "$repo_root/$helper" >"$command_output" 2>&1
}

expect_failure() {
  local description="$1"
  local scenario="$2"
  local helper="$3"

  if run_helper "$scenario" "$helper"; then
    fail "$description"
    return 1
  fi
  pass "$description"
}

expect_success() {
  local description="$1"
  local scenario="$2"
  local helper="$3"

  if ! run_helper "$scenario" "$helper"; then
    fail "$description"
    return 1
  fi
  pass "$description"
}

test_toard_helper() {
  expect_failure "toard helper rejects an existing Secret" toard_existing scripts/k8s-create-toard-secret.sh || true
  assert_log_not_contains "existing toard Secret must not be created" "create secret generic toard-secrets" || true

  expect_failure "toard helper fails closed when Secret lookup fails" toard_get_error scripts/k8s-create-toard-secret.sh || true
  assert_log_not_contains "toard lookup failure must not create a Secret" "create secret generic toard-secrets" || true

  expect_failure "toard helper fails closed when StatefulSet lookup fails" toard_statefulset_get_error scripts/k8s-create-toard-secret.sh || true
  assert_log_not_contains "StatefulSet lookup failure must not create a Secret" "create secret generic toard-secrets" || true

  expect_failure "toard helper fails closed when PVC lookup fails" toard_pvc_get_error scripts/k8s-create-toard-secret.sh || true
  assert_log_not_contains "PVC lookup failure must not create a Secret" "create secret generic toard-secrets" || true

  expect_failure "toard helper requires recovery for an existing StatefulSet" toard_statefulset scripts/k8s-create-toard-secret.sh || true
  assert_log_not_contains "existing PostgreSQL StatefulSet must not create a new Secret" "create secret generic toard-secrets" || true

  expect_failure "toard helper requires recovery for an existing PVC" toard_pvc scripts/k8s-create-toard-secret.sh || true
  assert_log_not_contains "existing PostgreSQL PVC must not create a new Secret" "create secret generic toard-secrets" || true

  expect_success "toard helper creates a Secret on a clean first install" clean scripts/k8s-create-toard-secret.sh || true
  assert_log_contains "toard helper must use ignore-not-found lookups" "--ignore-not-found" || true
  assert_log_contains "toard helper must request resource names" "-o name" || true
  assert_log_contains "toard helper must use direct create" "create secret generic toard-secrets" || true
  assert_log_not_contains "toard helper must not use dry-run" "--dry-run" || true
  assert_log_not_contains "toard helper must not call apply" " apply " || true
}

test_tunnel_helper() {
  expect_failure "tunnel helper rejects an existing Secret" tunnel_existing scripts/k8s-create-tunnel-secret.sh || true
  assert_log_not_contains "existing tunnel Secret must be rejected before token fetch" "cloudflared token fetched" || true
  assert_log_not_contains "existing tunnel Secret must not be created" "create secret generic tunnel-token" || true

  expect_failure "tunnel helper fails closed when Secret lookup fails" tunnel_get_error scripts/k8s-create-tunnel-secret.sh || true
  assert_log_not_contains "tunnel lookup failure must stop before token fetch" "cloudflared token fetched" || true
  assert_log_not_contains "tunnel lookup failure must not create a Secret" "create secret generic tunnel-token" || true

  expect_success "tunnel helper fetches a token and creates a Secret on first install" clean scripts/k8s-create-tunnel-secret.sh || true
  assert_log_contains "tunnel helper must check the Secret before token fetch" "get secret tunnel-token" || true
  assert_log_contains "tunnel helper must fetch the token after the check" "cloudflared token fetched" || true
  assert_log_contains "tunnel helper must use direct create" "create secret generic tunnel-token" || true
  assert_log_not_contains "tunnel helper must not use dry-run" "--dry-run" || true
  assert_log_not_contains "tunnel helper must not call apply" " apply " || true
}

test_toard_helper
test_tunnel_helper

if (( failures > 0 )); then
  echo "secret helper behavioral tests failed: $failures" >&2
  exit 1
fi

echo "secret helper behavioral tests passed"
