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

test("전체 보존 재가격 action과 UI와 번역은 제거한다", () => {
  const panel = source("app/(dashboard)/admin/pricing-panel.tsx");
  const ko = JSON.parse(source("messages/ko/admin.json"));
  const en = JSON.parse(source("messages/en/admin.json"));

  assert.equal(existsSync(new URL("./pricing-reprice.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("./pricing-reprice.test.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../app/(dashboard)/admin/pricing-actions.ts", import.meta.url)), false);
  assert.doesNotMatch(panel, /repriceUsageAction|PricingRepriceState|confirm-reprice|repriceState/);
  for (const messages of [ko, en]) {
    assert.equal(Object.keys(messages.system).some((key) => key.startsWith("reprice")), false);
    assert.equal(Object.keys(messages.errors).some((key) => key.startsWith("reprice")), false);
  }
});
