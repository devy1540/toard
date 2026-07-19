#!/usr/bin/env bash
set -euo pipefail

namespace="${CLOUDFLARE_NAMESPACE:-cloudflare-tunnel}"
tunnel_name="${CLOUDFLARE_TUNNEL_NAME:-macmini-k8s}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    exit 1
  }
}

require_command cloudflared
require_command kubectl

token_file="$(mktemp "${TMPDIR:-/tmp}/cloudflare-tunnel-token.XXXXXX")"
chmod 600 "$token_file"
trap 'rm -f -- "$token_file"' EXIT

cloudflared tunnel token "$tunnel_name" | tr -d '\r\n' >"$token_file"

kubectl --namespace "$namespace" create secret generic tunnel-token \
  --from-file=token="$token_file" \
  --dry-run=client \
  --output=yaml | kubectl apply -f -
