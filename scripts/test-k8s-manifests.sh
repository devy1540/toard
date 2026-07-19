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

assert_not_contains() {
  local rendered="$1"
  local unexpected="$2"

  if grep -Fq -- "$unexpected" <<<"$rendered"; then
    echo "rendered manifest must not include: $unexpected" >&2
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
  local overlay_kustomization="k8s/overlays/orbstack-personal/kustomization.yaml"
  local image_tag_count
  local app_image_tag
  local migrate_image_tag
  local semver_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?(\+([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?$'

  image_tag_count="$(awk '$1 == "newTag:" { count++ } END { print count + 0 }' "$overlay_kustomization")"
  if [[ "$image_tag_count" != "2" ]]; then
    echo "personal overlay must define exactly two image newTag values" >&2
    exit 1
  fi

  app_image_tag="$(awk '$1 == "newTag:" { print $2; exit }' "$overlay_kustomization")"
  migrate_image_tag="$(awk '$1 == "newTag:" { count++; if (count == 2) { print $2; exit } }' "$overlay_kustomization")"
  if [[ "$app_image_tag" != "$migrate_image_tag" ]]; then
    echo "personal overlay app and migrator image tags must match" >&2
    exit 1
  fi
  if [[ ! "$app_image_tag" =~ $semver_pattern ]]; then
    echo "personal overlay image tag must be semver" >&2
    exit 1
  fi

  prepare_raw_secret
  kubectl kustomize k8s/base >/dev/null
  overlay="$(kubectl kustomize k8s/overlays/orbstack-personal)"

  assert_not_kind "$overlay" Secret
  assert_not_kind "$overlay" Ingress
  assert_not_contains "$overlay" "type: NodePort"
  assert_not_contains "$overlay" "type: LoadBalancer"
  assert_contains "$overlay" "namespace: toard-personal"
  assert_contains "$overlay" "TOARD_PUBLIC_URL: https://toard.devy1540.com"
  assert_contains "$overlay" "replicas: 2"
  assert_contains "$overlay" "type: RollingUpdate"
  assert_contains "$overlay" "maxUnavailable: 0"
  assert_contains "$overlay" "maxSurge: 1"
  assert_contains "$overlay" "type: ClusterIP"
  assert_contains "$overlay" "storage: 10Gi"
  assert_contains "$overlay" "image: ghcr.io/devy1540/toard:$app_image_tag"
  assert_contains "$overlay" "image: ghcr.io/devy1540/toard-migrate:$app_image_tag"

  kubectl kustomize k8s >/dev/null
}

test_cloudflare() {
  local overlay

  overlay="$(kubectl kustomize k8s/overlays/orbstack-cloudflare)"

  assert_not_kind "$overlay" Secret
  assert_contains "$overlay" "kind: Namespace"
  assert_contains "$overlay" "name: cloudflare-tunnel"
  assert_contains "$overlay" "kind: Deployment"
  assert_contains "$overlay" "name: cloudflared"
  assert_contains "$overlay" "replicas: 2"
  assert_contains "$overlay" "image: cloudflare/cloudflared:2026.7.2"
  assert_contains "$overlay" "- cloudflared"
  assert_contains "$overlay" "- tunnel"
  assert_contains "$overlay" "- --no-autoupdate"
  assert_contains "$overlay" "- --loglevel"
  assert_contains "$overlay" "- info"
  assert_contains "$overlay" "- --metrics"
  assert_contains "$overlay" "- 0.0.0.0:2000"
  assert_contains "$overlay" "- run"
  assert_contains "$overlay" "name: TUNNEL_TOKEN"
  assert_contains "$overlay" "name: tunnel-token"
  assert_contains "$overlay" "key: token"
  assert_contains "$overlay" "path: /ready"
  assert_contains "$overlay" "port: 2000"
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
