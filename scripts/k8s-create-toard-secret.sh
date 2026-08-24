#!/usr/bin/env bash
set -euo pipefail

namespace="${TOARD_NAMESPACE:-toard-personal}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    exit 1
  }
}

require_command kubectl
require_command openssl
require_command stat

lookup_resource() {
  local resource="$1"
  local name="$2"

  if ! lookup_result="$(kubectl --namespace "$namespace" get "$resource" "$name" --ignore-not-found -o name)"; then
    echo "failed to check $resource/$name in namespace $namespace; refusing to create toard-secrets" >&2
    return 1
  fi
}

lookup_result=""
lookup_resource secret toard-secrets
if [[ -n "$lookup_result" ]]; then
  echo "toard-secrets already exists in namespace $namespace; refusing to replace it; this helper is for first-time installation only" >&2
  exit 1
fi

lookup_resource statefulset postgres
if [[ -n "$lookup_result" ]]; then
  echo "statefulset/postgres already exists in namespace $namespace; Secret recovery is required; restore the backed-up existing values manually" >&2
  exit 1
fi

lookup_resource persistentvolumeclaim data-postgres-0
if [[ -n "$lookup_result" ]]; then
  echo "persistentvolumeclaim/data-postgres-0 already exists in namespace $namespace; Secret recovery is required; restore the backed-up existing values manually" >&2
  exit 1
fi

env_file="$(mktemp "${TMPDIR:-/tmp}/toard-secret.XXXXXX")"
chmod 600 "$env_file"
trap 'rm -f -- "$env_file"' EXIT

postgres_password="$(openssl rand -hex 32)"
auth_secret="$(openssl rand -base64 33)"
cron_secret="$(openssl rand -base64 33)"
if [[ -z "${TOARD_BOOTSTRAP_SETUP_TOKEN_FILE:-}" ]]; then
  echo "TOARD_BOOTSTRAP_SETUP_TOKEN_FILE is required so the browser setup token remains available to its owner" >&2
  exit 1
fi
if [[ ! -f "$TOARD_BOOTSTRAP_SETUP_TOKEN_FILE" || -L "$TOARD_BOOTSTRAP_SETUP_TOKEN_FILE" || ! -r "$TOARD_BOOTSTRAP_SETUP_TOKEN_FILE" ]]; then
  echo "TOARD_BOOTSTRAP_SETUP_TOKEN_FILE must name a readable private regular file" >&2
  exit 1
fi
if token_file_mode="$(stat -c '%a' "$TOARD_BOOTSTRAP_SETUP_TOKEN_FILE" 2>/dev/null)"; then
  : # GNU/Linux
elif token_file_mode="$(stat -f '%Lp' "$TOARD_BOOTSTRAP_SETUP_TOKEN_FILE" 2>/dev/null)"; then
  : # macOS/BSD
else
  echo "failed to inspect TOARD_BOOTSTRAP_SETUP_TOKEN_FILE permissions" >&2
  exit 1
fi
if [[ "$token_file_mode" != "600" && "$token_file_mode" != "400" ]]; then
  echo "TOARD_BOOTSTRAP_SETUP_TOKEN_FILE must have mode 0600 or 0400" >&2
  exit 1
fi
bootstrap_setup_token="$(tr -d '\r\n' <"$TOARD_BOOTSTRAP_SETUP_TOKEN_FILE")"

if (( ${#bootstrap_setup_token} < 32 )); then
  echo "BOOTSTRAP_SETUP_TOKEN must contain at least 32 characters" >&2
  exit 1
fi

{
  printf 'AUTH_SECRET=%s\n' "$auth_secret"
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
  printf 'DATABASE_URL=postgres://toard:%s@postgres:5432/toard\n' "$postgres_password"
  printf 'CRON_SECRET=%s\n' "$cron_secret"
  printf 'BOOTSTRAP_SETUP_TOKEN=%s\n' "$bootstrap_setup_token"
} >"$env_file"

kubectl --namespace "$namespace" create secret generic toard-secrets \
  --from-env-file="$env_file"
