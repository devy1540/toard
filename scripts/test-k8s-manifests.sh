#!/usr/bin/env bash
set -euo pipefail

readonly secret_file="k8s/secret.yaml"
secret_created=0

cleanup() {
  if (( secret_created )); then
    rm -f -- "$secret_file"
  fi
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    exit 1
  }
}

assert_contains() {
  local rendered="$1"
  local expected="$2"

  if ! grep -Fq -- "$expected" <<<"$rendered"; then
    echo "rendered manifest is missing: $expected" >&2
    exit 1
  fi
}

assert_not_kind() {
  local rendered="$1"
  local kind="$2"

  if grep -Fxq -- "kind: $kind" <<<"$rendered"; then
    echo "rendered manifest must not include kind: $kind" >&2
    exit 1
  fi
}

prepare_raw_secret() {
  if [[ ! -e "$secret_file" && ! -L "$secret_file" ]]; then
    cp k8s/secret.example.yaml "$secret_file"
    secret_created=1
  fi
}

test_app() {
  local overlay

  prepare_raw_secret
  kubectl kustomize k8s/base >/dev/null
  overlay="$(kubectl kustomize k8s/overlays/orbstack-personal)"

  assert_not_kind "$overlay" Secret
  assert_not_kind "$overlay" Ingress
  assert_contains "$overlay" "namespace: toard-personal"
  assert_contains "$overlay" "TOARD_PUBLIC_URL: https://toard.devy1540.com"
  assert_contains "$overlay" "replicas: 2"
  assert_contains "$overlay" "type: RollingUpdate"
  assert_contains "$overlay" "maxUnavailable: 0"
  assert_contains "$overlay" "maxSurge: 1"
  assert_contains "$overlay" "type: ClusterIP"
  assert_contains "$overlay" "storage: 10Gi"
  assert_contains "$overlay" "image: ghcr.io/devy1540/toard:0.15.36"
  assert_contains "$overlay" "image: ghcr.io/devy1540/toard-migrate:0.15.36"

  kubectl kustomize k8s >/dev/null
}

test_cloudflare() {
  kubectl kustomize k8s/overlays/orbstack-cloudflare >/dev/null
}

main() {
  require_command kubectl

  case "${1:-}" in
    app)
      test_app
      ;;
    cloudflare)
      test_cloudflare
      ;;
    all)
      test_app
      test_cloudflare
      ;;
    *)
      echo "usage: $0 {app|cloudflare|all}" >&2
      exit 2
      ;;
  esac
}

main "$@"
