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

{
  printf 'AUTH_SECRET=%s\n' "$auth_secret"
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
  printf 'DATABASE_URL=postgres://toard:%s@postgres:5432/toard\n' "$postgres_password"
  printf 'CRON_SECRET=%s\n' "$cron_secret"
} >"$env_file"

kubectl --namespace "$namespace" create secret generic toard-secrets \
  --from-env-file="$env_file"
