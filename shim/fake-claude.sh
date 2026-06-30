#!/bin/sh
# 대역 Claude Code: shim 이 주입한 OTEL env 를 읽어 OTLP/JSON 로그 한 건을 toard 로 전송.
# 페이로드는 검증된 fixtures 를 베이스로 timeUnixNano·request_id 만 현재값으로 치환한다.
set -e

[ "$CLAUDE_CODE_ENABLE_TELEMETRY" = "1" ] || { echo "[fake-claude] telemetry off"; exit 1; }
[ -n "$OTEL_EXPORTER_OTLP_ENDPOINT" ] || { echo "[fake-claude] no endpoint"; exit 1; }

echo "[fake-claude] shim 이 주입한 env:"
echo "  CLAUDE_CODE_ENABLE_TELEMETRY=$CLAUDE_CODE_ENABLE_TELEMETRY"
echo "  OTEL_EXPORTER_OTLP_PROTOCOL=$OTEL_EXPORTER_OTLP_PROTOCOL"
echo "  OTEL_EXPORTER_OTLP_ENDPOINT=$OTEL_EXPORTER_OTLP_ENDPOINT"
echo "  OTEL_RESOURCE_ATTRIBUTES=$OTEL_RESOURCE_ATTRIBUTES"

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
FIXTURE="$ROOT/fixtures/sample-otlp-logs.json"

# OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer xxx" → "Authorization: Bearer xxx"
AUTH_HEADER=$(printf '%s' "${OTEL_EXPORTER_OTLP_HEADERS:-X-None=1}" | sed 's/=/: /')
NOW="$(date +%s)000000000"
RID="shim-poc-$(date +%s)"
TMP=$(mktemp)
sed -e "s/1719800000000000000/$NOW/" -e "s/req_test_001/$RID/" "$FIXTURE" > "$TMP"

echo "[fake-claude] OTLP/JSON 전송 → ${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs (request_id=$RID)"
curl -sS -w "\n[fake-claude] HTTP %{http_code}\n" -X POST "${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs" \
  -H "Content-Type: application/json" -H "$AUTH_HEADER" --data @"$TMP"
rm -f "$TMP"
