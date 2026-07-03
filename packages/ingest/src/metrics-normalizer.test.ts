import assert from "node:assert/strict";
import { test } from "node:test";
import { metricDedupKey } from "./dedup";
import { claudeMetricsNormalizer } from "./normalizers/claude-metrics";
import { parseOtlpMetrics } from "./otlp-metrics";
import type { FlatMetricPoint } from "./types";

const MODEL = "claude-opus-4-8[1m]";
const SESSION = "eda019bc-0d50-4cba-a9d9-574d0249f03d";

function tokenPoint(type: string, value: number, session = SESSION, model = MODEL): FlatMetricPoint {
  return {
    resourceAttrs: { "service.name": "claude-code" },
    scopeName: "com.anthropic.claude_code",
    metricName: "claude_code.token.usage",
    ts: new Date(1_700_000_000_000),
    attrs: { type, model, "session.id": session, "user.email": "x@y.z" },
    value,
  };
}
function costPoint(value: number, session = SESSION, model = MODEL): FlatMetricPoint {
  return {
    resourceAttrs: { "service.name": "claude-code" },
    scopeName: "com.anthropic.claude_code",
    metricName: "claude_code.cost.usage",
    ts: new Date(1_700_000_000_000),
    attrs: { model, "session.id": session },
    value,
  };
}

// 한 export 의 누적 스냅샷 (관측값 기준)
const oneExport = (): FlatMetricPoint[] => [
  costPoint(0.1112935),
  tokenPoint("input", 12453),
  tokenPoint("output", 4),
  tokenPoint("cacheRead", 16497),
  tokenPoint("cacheCreation", 4068),
];

test("metrics: token.usage type 별 → NormalizedUsage 토큰 필드로 매핑, cost 는 providedCostUsd", () => {
  const out = claudeMetricsNormalizer.normalize(oneExport(), { userId: "u1" });
  assert.equal(out.length, 1);
  const u = out[0]!;
  assert.equal(u.inputTokens, 12453);
  assert.equal(u.outputTokens, 4);
  assert.equal(u.cacheReadTokens, 16497);
  assert.equal(u.cacheCreationTokens, 4068);
  assert.equal(u.providedCostUsd, 0.1112935);
  assert.equal(u.sessionId, SESSION);
  assert.equal(u.model, MODEL);
  assert.equal(u.providerKey, "claude_code");
  assert.equal(u.userId, "u1");
});

test("metrics: 반복 export(누적)는 동일 dedupKey → storage 가 upsert 로 수렴(중복 아님)", () => {
  const a = claudeMetricsNormalizer.normalize(oneExport(), { userId: "u1" })[0]!;
  const b = claudeMetricsNormalizer.normalize(oneExport(), { userId: "u1" })[0]!;
  // 같은 (session, model) → 같은 dedupKey. 값도 동일 → GREATEST upsert 는 그대로.
  assert.equal(a.dedupKey, b.dedupKey);
  assert.equal(a.dedupKey, metricDedupKey(SESSION, MODEL));
});

test("metrics: 세션·모델이 다르면 dedupKey 도 다름 (독립 집계)", () => {
  const points = [
    ...oneExport(),
    tokenPoint("input", 500, "other-session"),
    tokenPoint("output", 100, "other-session"),
  ];
  const out = claudeMetricsNormalizer.normalize(points, { userId: "u1" });
  assert.equal(out.length, 2);
  const keys = new Set(out.map((u) => u.dedupKey));
  assert.equal(keys.size, 2);
});

test("metrics: 같은 type 이 여러 datapoint(예: query_source 분화)면 합산", () => {
  const points = [
    tokenPoint("input", 1000),
    tokenPoint("input", 500), // 다른 query_source 의 같은 세션·모델 누적
    tokenPoint("output", 10),
  ];
  const out = claudeMetricsNormalizer.normalize(points, { userId: "u1" });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.inputTokens, 1500);
  assert.equal(out[0]!.outputTokens, 10);
});

test("metrics: 토큰 전무(cost 만) 스냅샷은 유령 이벤트로 만들지 않음", () => {
  const out = claudeMetricsNormalizer.normalize([costPoint(0.5)], { userId: "u1" });
  assert.equal(out.length, 0);
});

test("parseOtlpMetrics: token.usage/cost.usage 만 flat 화, session.count 등은 파서엔 남되 정규화가 무시", () => {
  const payload = {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeMetrics: [
          {
            scope: { name: "com.anthropic.claude_code" },
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      startTimeUnixNano: "1783063978917000000",
                      timeUnixNano: "1783063980000000000",
                      asDouble: 12453,
                      attributes: [
                        { key: "type", value: { stringValue: "input" } },
                        { key: "model", value: { stringValue: MODEL } },
                        { key: "session.id", value: { stringValue: SESSION } },
                      ],
                    },
                  ],
                },
              },
              {
                name: "claude_code.session.count",
                sum: {
                  dataPoints: [{ timeUnixNano: "1783063980000000000", asDouble: 1, attributes: [] }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const points = parseOtlpMetrics(payload);
  assert.equal(points.length, 2); // token.usage + session.count 둘 다 flat
  const usage = claudeMetricsNormalizer.normalize(points, { userId: "u1" });
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.inputTokens, 12453);
  assert.equal(usage[0]!.model, MODEL);
});

test("parseOtlpMetrics: ts 없는(epoch) 데이터포인트는 제외", () => {
  const points = parseOtlpMetrics({
    resourceMetrics: [
      {
        resource: { attributes: [] },
        scopeMetrics: [
          {
            scope: { name: "s" },
            metrics: [{ name: "claude_code.token.usage", sum: { dataPoints: [{ asInt: "5", attributes: [] }] } }],
          },
        ],
      },
    ],
  });
  assert.equal(points.length, 0);
});
