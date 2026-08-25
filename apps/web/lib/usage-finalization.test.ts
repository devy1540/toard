import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { FinalizedUsageEvent, Provider, UsageEvent } from "@toard/core";
import type { FlatLogRecord, ProviderNormalizer } from "@toard/ingest";
import type { PricingSchedule } from "@toard/pricing";
import { POST as eventsPost } from "../app/api/v1/events/route";
import { POST as logsPost } from "../app/api/v1/logs/route";
import {
  finalizeUsageEvents,
  MAX_USAGE_EVENT_AGE_MS,
} from "./usage-finalization";
import { USAGE_INGEST_MAX_BODY_BYTES } from "./tool-ingest";

const schedule: PricingSchedule = new Map([
  [
    "model-a",
    [
      {
        id: "old",
        modelId: "model-a",
        effectiveAt: new Date("2026-04-01T00:00:00Z"),
        pricing: { inputPerM: 1, outputPerM: 2, fastMultiplier: 2 },
      },
      {
        id: "new",
        modelId: "model-a",
        effectiveAt: new Date("2026-07-10T00:00:00Z"),
        pricing: { inputPerM: 3, outputPerM: 4, fastMultiplier: 2 },
      },
    ],
  ],
]);

function eventAt(ts: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    dedupKey: `event:${ts}`,
    providerKey: "claude",
    userId: "client-user",
    sessionId: "session-1",
    model: "model-a",
    ts: new Date(ts),
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 999,
    ...overrides,
  };
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function streamingRequest(
  path: "events" | "logs",
  chunks: readonly string[],
  options: { contentLength?: string; authorization?: string } = {},
): { request: Request; cancelled: () => boolean } {
  let index = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(Buffer.from(chunks[index++]!));
    },
    cancel() { wasCancelled = true; },
  });
  const request = new Request(`http://toard.test/api/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: options.authorization ?? "Bearer token",
      ...(options.contentLength ? { "content-length": options.contentLength } : {}),
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, cancelled: () => wasCancelled };
}

test("90일을 넘긴 이벤트는 expired이고 저장 대상이 아니다", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  const result = finalizeUsageEvents(
    [eventAt("2026-04-10T23:59:59Z")],
    "u1",
    schedule,
    { mode: "calculate" },
    now,
  );

  assert.equal(result.expired, 1);
  assert.deepEqual(result.events, []);
});

test("90일 경계 시각의 이벤트는 저장 대상이다", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  const event = eventAt(new Date(now.getTime() - MAX_USAGE_EVENT_AGE_MS).toISOString());
  const result = finalizeUsageEvents([event], "u1", schedule, { mode: "calculate" }, now);

  assert.equal(result.expired, 0);
  assert.equal(result.events.length, 1);
});

test("늦게 도착했어도 90일 이내면 ts 기준 revision으로 확정한다", () => {
  const result = finalizeUsageEvents(
    [eventAt("2026-07-09T10:00:00Z")],
    "u1",
    schedule,
    { mode: "calculate" },
    new Date("2026-07-10T00:00:00Z"),
  );

  assert.equal(result.expired, 0);
  assert.equal(result.events[0]?.userId, "u1");
  assert.equal(result.events[0]?.costUsd, 1);
  assert.equal(result.events[0]?.pricingRevisionId, "old");
  assert.equal(result.events[0]?.costStatus, "priced");
});

test("이벤트 시각에 적용할 revision이 없으면 unpriced로 확정한다", () => {
  const result = finalizeUsageEvents(
    [eventAt("2026-07-09T10:00:00Z", { model: "missing" })],
    "u1",
    schedule,
    { mode: "calculate" },
    new Date("2026-07-10T00:00:00Z"),
  );

  assert.equal(result.expired, 0);
  assert.equal(result.events[0]?.costUsd, 0);
  assert.equal(result.events[0]?.pricingRevisionId, null);
  assert.equal(result.events[0]?.costStatus, "unpriced");
});

test("auto 경로의 가격 힌트는 dedup key로 해당 이벤트에 적용한다", () => {
  const event = eventAt("2026-07-09T10:00:00Z", { dedupKey: "hinted" });
  const result = finalizeUsageEvents(
    [event],
    "u1",
    schedule,
    {
      mode: "auto",
      priceHints: new Map([["hinted", { providedCostUsd: 99, isFast: true }]]),
    },
    new Date("2026-07-10T00:00:00Z"),
  );

  assert.equal(result.events[0]?.costUsd, 2);
  assert.equal(result.events[0]?.pricingRevisionId, "old");
});

const providers: Provider[] = [
  {
    key: "claude_code",
    displayName: "Claude Code",
    serviceNamePatterns: ["claude-code"],
    collectionMethod: "logfile",
    enabled: true,
  },
  {
    key: "codex",
    displayName: "Codex",
    serviceNamePatterns: ["codex"],
    collectionMethod: "otel",
    enabled: true,
  },
];

test("events 경로는 expired를 저장하지 않고 dedup 결과와 expired를 HTTP 200으로 응답한다", async () => {
  const saved: FinalizedUsageEvent[][] = [];
  const tokenHosts: Array<string | null | undefined> = [];
  const shimHosts: Array<string | null | undefined> = [];
  const receivedAt = new Date("2026-07-10T00:00:00Z");
  const post = eventsPost.withDependencies({
    authenticateIngestToken: async () => ({ userId: "server-user", tokenId: "token-1" }),
    loadProviders: async () => providers,
    getPricingSchedule: async () => schedule,
    saveUsageEvents: async (events) => {
      saved.push(events);
      return { inserted: 0, deduped: events.length };
    },
    recordTokenHost: async (_tokenId, hosts) => {
      tokenHosts.push(...hosts);
    },
    recordShimVersions: async (_userId, _version, hosts) => {
      shimHosts.push(...hosts);
    },
    now: () => receivedAt,
  });
  const accepted = eventAt("2026-07-09T10:00:00Z", {
    dedupKey: "accepted",
    providerKey: "claude_code",
    host: " accepted-host ",
  });
  const expired = eventAt("2026-04-10T23:59:59Z", {
    dedupKey: "expired",
    providerKey: "claude_code",
    host: " expired-host ",
  });

  const response = await post(new Request("http://toard.test/api/v1/events", {
    method: "POST",
    headers: { authorization: "Bearer token", "user-agent": "toard-shim/1.2.3" },
    body: JSON.stringify([accepted, expired]),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { inserted: 0, deduped: 1, expired: 1 });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.length, 1);
  assert.equal(saved[0]?.[0]?.dedupKey, "accepted");
  assert.equal(saved[0]?.[0]?.userId, "server-user");
  assert.equal(saved[0]?.[0]?.pricingRevisionId, "old");
  assert.deepEqual(tokenHosts, ["accepted-host", "expired-host"]);
  assert.deepEqual(shimHosts, ["accepted-host", "expired-host"]);
});

test("events 경로는 logfile이 아닌 provider를 기존처럼 저장하지 않고 HTTP 200을 유지한다", async () => {
  let saveCalls = 0;
  const post = eventsPost.withDependencies({
    authenticateIngestToken: async () => ({ userId: "server-user", tokenId: "token-1" }),
    loadProviders: async () => providers,
    getPricingSchedule: async () => schedule,
    saveUsageEvents: async () => {
      saveCalls += 1;
      return { inserted: 0, deduped: 0 };
    },
    recordTokenHost: async () => {},
    recordShimVersions: async () => {},
    now: () => new Date("2026-07-10T00:00:00Z"),
  });

  const response = await post(new Request("http://toard.test/api/v1/events", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify([eventAt("2026-07-09T10:00:00Z", { providerKey: "codex" })]),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { inserted: 0, deduped: 0, expired: 0 });
  assert.equal(saveCalls, 0);
});

test("logs 경로는 provider별 expired를 합산하고 gate와 dedup 결과를 HTTP 200으로 유지한다", async () => {
  const records: FlatLogRecord[] = [
    { resourceAttrs: { "host.name": "active-host" }, scopeName: null, eventName: "claude_code", ts: new Date(), attrs: {} },
    { resourceAttrs: { "host.name": "expired-host" }, scopeName: null, eventName: "codex", ts: new Date(), attrs: {} },
    { resourceAttrs: { "host.name": "ignored-host" }, scopeName: null, eventName: "ignored", ts: new Date(), attrs: {} },
  ];
  const testNormalizers: Record<string, ProviderNormalizer> = {
    claude_code: {
      providerKey: "claude_code",
      normalize: () => [{
        dedupKey: "active-log",
        providerKey: "claude_code",
        userId: "client-user",
        sessionId: "s1",
        model: "model-a",
        ts: new Date("2026-07-09T10:00:00Z"),
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        providedCostUsd: 99,
        isFast: false,
      }],
    },
    codex: {
      providerKey: "codex",
      normalize: () => [{
        dedupKey: "expired-log",
        providerKey: "codex",
        userId: "client-user",
        sessionId: "s2",
        model: "model-a",
        ts: new Date("2026-04-10T23:59:59Z"),
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        providedCostUsd: null,
        isFast: false,
      }],
    },
  };
  const rawProviders: string[] = [];
  const saved: FinalizedUsageEvent[][] = [];
  const post = logsPost.withDependencies({
    authenticateIngestToken: async () => ({ userId: "server-user", tokenId: "token-1" }),
    loadProviders: async () => providers,
    getPricingSchedule: async () => schedule,
    parseOtlpLogs: () => records,
    identifyProvider: (record) => record.eventName === "ignored" ? null : record.eventName,
    normalizers: testNormalizers,
    saveRawEvent: async (providerKey) => {
      rawProviders.push(providerKey);
      return rawProviders.length;
    },
    saveUsageEvents: async (events) => {
      saved.push(events);
      return { inserted: 0, deduped: events.length };
    },
    recordTokenHost: async () => {},
    now: () => new Date("2026-07-10T00:00:00Z"),
  });

  const response = await post(new Request("http://toard.test/api/v1/logs", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: "{}",
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { inserted: 0, deduped: 1, expired: 1 });
  assert.deepEqual(rawProviders, ["claude_code", "codex"]);
  assert.deepEqual(saved.map((events) => events.length), [1, 0]);
  assert.equal(saved[0]?.[0]?.userId, "server-user");
  assert.equal(saved[0]?.[0]?.pricingRevisionId, "old");
});

test("events와 logs는 새 사용량 저장 뒤 해당 사용자의 활용 지수 cache를 무효화한다", async () => {
  const eventInvalidations: string[] = [];
  const generationChanges: string[] = [];
  const eventHandler = eventsPost.withDependencies({
    authenticateIngestToken: async () => ({ userId: "events-user", tokenId: "token-1" }),
    loadProviders: async () => providers,
    getPricingSchedule: async () => schedule,
    saveUsageEvents: async (events) => ({ inserted: events.length, deduped: 0 }),
    recordTokenHost: async () => {},
    recordShimVersions: async () => {},
    invalidateUtilizationForUser: async (userId) => { eventInvalidations.push(userId); },
    withUserUtilizationCacheChange: async (userId, operation) => {
      const result = await operation();
      generationChanges.push(userId);
      return result;
    },
    now: () => new Date("2026-07-10T00:00:00Z"),
  });
  const eventResponse = await eventHandler(new Request("http://toard.test/api/v1/events", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify([eventAt("2026-07-09T10:00:00Z", { providerKey: "claude_code" })]),
  }));

  const logInvalidations: string[] = [];
  const logHandler = logsPost.withDependencies({
    authenticateIngestToken: async () => ({ userId: "logs-user", tokenId: "token-2" }),
    loadProviders: async () => providers,
    getPricingSchedule: async () => schedule,
    parseOtlpLogs: () => [{ scopeName: null, eventName: "claude_code", ts: new Date(), attrs: {}, resourceAttrs: {} }],
    identifyProvider: () => "claude_code",
    normalizers: {
      claude_code: {
        providerKey: "claude_code",
        normalize: () => [{
          dedupKey: "new-log",
          providerKey: "claude_code",
          userId: "client-user",
          sessionId: "session-1",
          model: "model-a",
          ts: new Date("2026-07-09T10:00:00Z"),
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          providedCostUsd: null,
          isFast: false,
        }],
      },
    },
    saveRawEvent: async () => 1,
    saveUsageEvents: async (events) => ({ inserted: events.length, deduped: 0 }),
    recordTokenHost: async () => {},
    invalidateUtilizationForUser: async (userId) => { logInvalidations.push(userId); },
    withUserUtilizationCacheChange: async (userId, operation) => {
      const result = await operation();
      generationChanges.push(userId);
      return result;
    },
    now: () => new Date("2026-07-10T00:00:00Z"),
  });
  const logResponse = await logHandler(new Request("http://toard.test/api/v1/logs", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: "{}",
  }));

  assert.equal(eventResponse.status, 200);
  assert.equal(logResponse.status, 200);
  assert.deepEqual(eventInvalidations, ["events-user"]);
  assert.deepEqual(logInvalidations, ["logs-user"]);
  assert.deepEqual(generationChanges, ["events-user", "logs-user"]);
});

test("events와 logs는 중복 사용량만 있으면 활용 지수 cache를 무효화하지 않는다", async () => {
  let invalidations = 0;
  const eventHandler = eventsPost.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
    loadProviders: async () => providers,
    getPricingSchedule: async () => schedule,
    saveUsageEvents: async (events) => ({ inserted: 0, deduped: events.length }),
    recordTokenHost: async () => {},
    recordShimVersions: async () => {},
    invalidateUtilizationForUser: async () => { invalidations += 1; },
    now: () => new Date("2026-07-10T00:00:00Z"),
  });

  await eventHandler(new Request("http://toard.test/api/v1/events", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify([eventAt("2026-07-09T10:00:00Z", { providerKey: "claude_code" })]),
  }));

  assert.equal(invalidations, 0);
});

test("events와 logs는 oversized Content-Length를 body read와 downstream 전에 거부한다", async () => {
  for (const [path, handler] of [
    ["events", eventsPost.withDependencies({ authenticateIngestToken: async () => ({ userId: "u", tokenId: "t" }) })],
    ["logs", logsPost.withDependencies({ authenticateIngestToken: async () => ({ userId: "u", tokenId: "t" }) })],
  ] as const) {
    const input = streamingRequest(path, ["{}"], {
      contentLength: String(USAGE_INGEST_MAX_BODY_BYTES + 1),
    });
    const response = await handler(input.request);
    assert.equal(response.status, 413, path);
    assert.equal(input.request.bodyUsed, false, path);
  }
});

test("events와 logs는 chunked 4MiB overflow를 취소하고 exact boundary를 허용한다", async () => {
  for (const [path, handler, exactJson] of [
    ["events", eventsPost.withDependencies({ authenticateIngestToken: async () => ({ userId: "u", tokenId: "t" }) }), "[]"],
    ["logs", logsPost.withDependencies({ authenticateIngestToken: async () => ({ userId: "u", tokenId: "t" }) }), "{}"],
  ] as const) {
    const oversized = streamingRequest(path, ["[\"", "x".repeat(USAGE_INGEST_MAX_BODY_BYTES), "\"]"]);
    const oversizedResponse = await handler(oversized.request);
    assert.equal(oversizedResponse.status, 413, path);
    assert.equal(oversized.cancelled(), true, path);

    const exactBody = " ".repeat(USAGE_INGEST_MAX_BODY_BYTES - exactJson.length) + exactJson;
    const exact = streamingRequest(path, [exactBody]);
    const exactResponse = await handler(exact.request);
    assert.equal(exactResponse.status, 200, path);
    assert.deepEqual(await exactResponse.json(), { inserted: 0, deduped: 0, expired: 0 }, path);
  }
});

test("events와 logs는 인증 전 body를 읽지 않고 malformed JSON을 400으로 거부한다", async () => {
  for (const [path, post] of [["events", eventsPost], ["logs", logsPost]] as const) {
    const unauthorized = streamingRequest(path, ["{"], { authorization: "Bearer invalid" });
    const unauthorizedResponse = await post.withDependencies({
      authenticateIngestToken: async () => null,
    })(unauthorized.request);
    assert.equal(unauthorizedResponse.status, 401, path);
    assert.equal(unauthorized.request.bodyUsed, false, path);

    const malformed = streamingRequest(path, ["{"]);
    const malformedResponse = await post.withDependencies({
      authenticateIngestToken: async () => ({ userId: "u", tokenId: "t" }),
    })(malformed.request);
    assert.equal(malformedResponse.status, 400, path);
  }
});

test("전체 보존 재가격 action과 UI와 번역은 제거한다", () => {
  const panel = source("app/(dashboard)/admin/pricing-panel.tsx");
  const adminStatus = source("lib/pricing-admin-status.ts");
  const ko = JSON.parse(source("messages/ko/admin.json"));
  const en = JSON.parse(source("messages/en/admin.json"));

  assert.equal(existsSync(new URL("./pricing-reprice.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("./pricing-reprice.test.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../app/(dashboard)/admin/pricing-actions.ts", import.meta.url)), false);
  assert.doesNotMatch(panel, /repriceUsageAction|PricingRepriceState|confirm-reprice|repriceState/);
  assert.match(panel, /repricedLegacyEvents/);
  assert.match(panel, /remainingLegacyEvents/);
  assert.match(adminStatus, /repricedLegacyEvents: repair\.repricedLegacyEvents/);
  assert.match(adminStatus, /remainingLegacyEvents: repair\.remainingLegacyEvents/);
  for (const messages of [ko, en]) {
    assert.equal(
      Object.keys(messages.system).some((key) => key.startsWith("reprice") && key !== "repricedLegacyEvents"),
      false,
    );
    assert.equal(Object.keys(messages.errors).some((key) => key.startsWith("reprice")), false);
    assert.equal(typeof messages.errors.onlyAdmin, "string");
    assert.equal(typeof messages.system.repricedLegacyEvents, "string");
    assert.equal(typeof messages.system.remainingLegacyEvents, "string");
  }
});
