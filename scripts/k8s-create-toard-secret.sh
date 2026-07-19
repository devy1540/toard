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
  --from-env-file="$env_file" \
  --dry-run=client \
  --output=yaml | kubectl apply -f -
