import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PricingMap, PricingSchedule } from "@toard/pricing";
import { pricingSyncDueToday } from "./pricing-auto-sync";
import {
  createPricingScheduleCache,
  loadPricingSchedule,
  loadPricingStatus,
  PRICING_SYNC_STATUS_SETTING_KEY,
} from "./pricing";
import { runPricingSyncTransaction, syncPricingRevisions } from "./pricing-sync";

type Query = { sql: string; params?: unknown[] };

function createSyncClient(rows: Array<Record<string, unknown>>) {
  const queries: Query[] = [];
  return {
    queries,
    client: {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("SELECT DISTINCT ON")) return { rows };
        return { rows: [] };
      },
    },
  };
}

function latestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_id: "model-a",
    input_price_per_mtok: "1",
    output_price_per_mtok: "2",
    cache_read_price_per_mtok: null,
    cache_creation_price_per_mtok: null,
    input_price_above_200k_per_mtok: null,
    output_price_above_200k_per_mtok: null,
    fast_multiplier: "1",
    ...overrides,
  };
}

function createConcurrentSyncClients() {
  let latest = [latestRow()];
  let insertCount = 0;
  let lockTail = Promise.resolve();
  let unlockedSelects = 0;
  let releaseSelectBarrier!: () => void;
  const selectBarrier = new Promise<void>((resolve) => {
    releaseSelectBarrier = resolve;
  });
  const events: string[] = [];

  function client(label: string) {
    let releaseLock: (() => void) | undefined;
    let hasLock = false;
    return {
      async query(sql: string, params?: unknown[]) {
        if (sql.includes("pg_advisory_xact_lock")) {
          events.push(`${label}:lock-requested`);
          const previous = lockTail;
          lockTail = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          await previous;
          hasLock = true;
          events.push(`${label}:lock-acquired`);
          return { rows: [] };
        }
        if (sql.includes("SELECT DISTINCT ON")) {
          const snapshot = latest.map((row) => ({ ...row }));
          if (!hasLock) {
            unlockedSelects += 1;
            if (unlockedSelects === 2) releaseSelectBarrier();
            await selectBarrier;
          }
          return { rows: snapshot };
        }
        if (sql.includes("INSERT INTO pricing_revisions")) {
          insertCount += 1;
          latest = [latestRow({
            model_id: params?.[1],
            input_price_per_mtok: params?.[2],
            output_price_per_mtok: params?.[3],
            cache_read_price_per_mtok: params?.[4],
            cache_creation_price_per_mtok: params?.[5],
            input_price_above_200k_per_mtok: params?.[6],
            output_price_above_200k_per_mtok: params?.[7],
            fast_multiplier: params?.[8],
          })];
        }
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          releaseLock?.();
          releaseLock = undefined;
        }
        return { rows: [] };
      },
    };
  }

  return {
    client,
    events,
    get insertCount() {
      return insertCount;
    },
  };
}

function createRevisionHistoryClient() {
  const revisions = [{
    effectiveAt: new Date("2026-07-01T00:00:00Z"),
    row: latestRow(),
  }];
  let syncStatus: { day: string; syncedAt: string } | undefined;
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("SELECT DISTINCT ON")) {
        const latest = [...revisions].sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime())[0]!;
        return { rows: [{ ...latest.row }] };
      }
      if (sql.includes("INSERT INTO pricing_revisions")) {
        revisions.push({
          effectiveAt: params?.[0] as Date,
          row: latestRow({
            model_id: params?.[1],
            input_price_per_mtok: params?.[2],
            output_price_per_mtok: params?.[3],
            cache_read_price_per_mtok: params?.[4],
            cache_creation_price_per_mtok: params?.[5],
            input_price_above_200k_per_mtok: params?.[6],
            output_price_above_200k_per_mtok: params?.[7],
            fast_multiplier: params?.[8],
          }),
        });
      }
      if (sql.includes("INSERT INTO app_settings")) {
        syncStatus = JSON.parse(String(params?.[1]));
      }
      return { rows: [] };
    },
  };

  return {
    client,
    latest: () => [...revisions].sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime())[0]!,
    get syncStatus() {
      return syncStatus;
    },
  };
}

test("schedule 로더는 과거 revision을 시간순으로 보존한다", async () => {
  const queries: string[] = [];
  const schedule = await loadPricingSchedule(async (sql) => {
    queries.push(sql);
    return {
      rows: [
        {
          id: "old",
          model_id: "model-a",
          effective_at: new Date("2026-07-01T00:00:00Z"),
          input_price_per_mtok: "1",
          output_price_per_mtok: "2",
          cache_read_price_per_mtok: null,
          cache_creation_price_per_mtok: null,
          input_price_above_200k_per_mtok: null,
          output_price_above_200k_per_mtok: null,
          fast_multiplier: "1",
        },
        {
          id: "new",
          model_id: "model-a",
          effective_at: new Date("2026-07-11T00:00:00Z"),
          input_price_per_mtok: "3",
          output_price_per_mtok: "4",
          cache_read_price_per_mtok: "0.3",
          cache_creation_price_per_mtok: "3.75",
          input_price_above_200k_per_mtok: "6",
          output_price_above_200k_per_mtok: "8",
          fast_multiplier: "2",
        },
      ],
    };
  });

  assert.match(queries[0]!, /FROM pricing_revisions/);
  assert.match(queries[0]!, /ORDER BY model_id, effective_at ASC/);
  assert.deepEqual(schedule.get("model-a"), [
    {
      id: "old",
      modelId: "model-a",
      effectiveAt: new Date("2026-07-01T00:00:00Z"),
      pricing: { inputPerM: 1, outputPerM: 2, fastMultiplier: 1 },
    },
    {
      id: "new",
      modelId: "model-a",
      effectiveAt: new Date("2026-07-11T00:00:00Z"),
      pricing: {
        inputPerM: 3,
        outputPerM: 4,
        cacheReadPerM: 0.3,
        cacheCreatePerM: 3.75,
        inputAbove200kPerM: 6,
        outputAbove200kPerM: 8,
        fastMultiplier: 2,
      },
    },
  ]);
});

test("비용 표시 상태는 mixed, all-unpriced, legacy-only를 구분한다", async () => {
  const pricing = await import("./pricing") as unknown as Record<string, unknown>;
  assert.equal(typeof pricing.costCoverageState, "function");
  const state = pricing.costCoverageState as (coverage: {
    pricedEvents: number;
    unpricedEvents: number;
    legacyEvents: number;
  }) => string;

  assert.equal(state({ pricedEvents: 2, unpricedEvents: 1, legacyEvents: 0 }), "partial");
  assert.equal(state({ pricedEvents: 0, unpricedEvents: 3, legacyEvents: 0 }), "unpriced");
  assert.equal(state({ pricedEvents: 0, unpricedEvents: 0, legacyEvents: 4 }), "legacy");
  assert.equal(state({ pricedEvents: 2, unpricedEvents: 0, legacyEvents: 0 }), "complete");

  assert.equal(typeof pricing.formatCostForCoverage, "function");
  const format = pricing.formatCostForCoverage as (
    cost: string,
    coverage: { pricedEvents: number; unpricedEvents: number; legacyEvents: number },
    labels: { partial: string; unpriced: string; legacy: string },
  ) => string;
  const labels = { partial: "부분 합계", unpriced: "가격 미확정", legacy: "기존 저장 비용" };
  assert.equal(format("$0.00", { pricedEvents: 0, unpricedEvents: 3, legacyEvents: 0 }, labels), "가격 미확정");
  assert.equal(format("$1.25", { pricedEvents: 2, unpricedEvents: 1, legacyEvents: 0 }, labels), "$1.25 · 부분 합계");
  assert.equal(format("$4.50", { pricedEvents: 0, unpricedEvents: 0, legacyEvents: 4 }, labels), "$4.50");

  assert.equal(typeof pricing.legacyCostHintCount, "function");
  const legacyCostHintCount = pricing.legacyCostHintCount as (
    coverage: { pricedEvents: number; unpricedEvents: number; legacyEvents: number },
  ) => number | null;
  assert.equal(legacyCostHintCount({ pricedEvents: 0, unpricedEvents: 0, legacyEvents: 4 }), 4);
  assert.equal(legacyCostHintCount({ pricedEvents: 2, unpricedEvents: 0, legacyEvents: 4 }), 4);
  assert.equal(legacyCostHintCount({ pricedEvents: 2, unpricedEvents: 1, legacyEvents: 4 }), null);
  assert.equal(legacyCostHintCount({ pricedEvents: 2, unpricedEvents: 0, legacyEvents: 0 }), null);

  assert.equal(typeof pricing.costCoverageForStatus, "function");
  const coverageForStatus = pricing.costCoverageForStatus as (status: string) => {
    pricedEvents: number;
    unpricedEvents: number;
    legacyEvents: number;
  };
  assert.deepEqual(coverageForStatus("priced"), { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 0 });
  assert.deepEqual(coverageForStatus("unpriced"), { pricedEvents: 0, unpricedEvents: 1, legacyEvents: 0 });
  assert.deepEqual(coverageForStatus("legacy"), { pricedEvents: 0, unpricedEvents: 0, legacyEvents: 1 });
});

test("한영 UI는 미확정 건수, 부분 합계, legacy 근거를 명시한다", () => {
  for (const locale of ["ko", "en"] as const) {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}/dashboard.json`, import.meta.url), "utf8"));
    assert.match(messages.pricingNotice.unpricedTitle, /\{count\}/);
    assert.equal(typeof messages.pricingNotice.legacyTitle, "string");
    assert.equal(typeof messages.costCoverage.partial, "string");
    assert.equal(typeof messages.costCoverage.unpriced, "string");
    assert.equal(typeof messages.costCoverage.legacy, "string");
    assert.match(messages.costCoverage.legacyHint, /\{count\}/);
  }
});

test("sync를 건너뛴 replica도 공유 generation이 바뀌면 TTL 전에 schedule을 다시 읽는다", async () => {
  const oldSchedule: PricingSchedule = new Map([["model-a", [
    { id: "old", modelId: "model-a", effectiveAt: new Date("2026-07-01T00:00:00Z"), pricing: { inputPerM: 1, outputPerM: 2 } },
  ]] ]);
  const newSchedule: PricingSchedule = new Map([["model-a", [
    ...oldSchedule.get("model-a")!,
    { id: "new", modelId: "model-a", effectiveAt: new Date("2026-07-10T12:00:00Z"), pricing: { inputPerM: 3, outputPerM: 4 } },
  ]] ]);
  let sharedSchedule = oldSchedule;
  let sharedVersion = "2026-07-10T09:00:00.000Z";
  const loads = { first: 0, second: 0 };
  const replica = (name: keyof typeof loads) => createPricingScheduleCache({
    loadSchedule: async () => {
      loads[name] += 1;
      return sharedSchedule;
    },
    readVersion: async () => sharedVersion,
    now: () => 0,
  });
  const first = replica("first");
  const second = replica("second");

  await first.get();
  await second.get();
  await second.get();
  assert.equal(loads.second, 1);

  sharedSchedule = newSchedule;
  sharedVersion = "2026-07-10T12:00:00.000Z";
  first.invalidate();
  assert.equal(pricingSyncDueToday("2026-07-10", "2026-07-10"), false);

  const reloaded = await second.get();
  assert.equal(reloaded.get("model-a")?.at(-1)?.id, "new");
  assert.equal(loads.second, 2);
});

test("가격 sync는 최신 revision과 가격이 같으면 INSERT를 건너뛴다", async () => {
  const fixture = createSyncClient([latestRow()]);
  const pricing: PricingMap = new Map([["model-a", { inputPerM: 1, outputPerM: 2 }]]);

  const inserted = await syncPricingRevisions(fixture.client, pricing, new Date("2026-07-10T12:00:00Z"));

  assert.equal(inserted, 0);
  assert.equal(fixture.queries.filter((query) => query.sql.includes("INSERT INTO")).length, 0);
});

test("가격 sync는 가격이 바뀐 모델만 현재 시각 revision으로 INSERT한다", async () => {
  const fixture = createSyncClient([latestRow()]);
  const pricing: PricingMap = new Map([
    ["model-a", { inputPerM: 3, outputPerM: 4, fastMultiplier: 2 }],
    ["model-b", { inputPerM: 5, outputPerM: 6 }],
  ]);
  const effectiveAt = new Date("2026-07-10T12:00:00Z");

  const inserted = await syncPricingRevisions(fixture.client, pricing, effectiveAt);

  assert.equal(inserted, 2);
  const insert = fixture.queries.find((query) => query.sql.includes("INSERT INTO pricing_revisions"));
  assert.ok(insert);
  assert.deepEqual(insert.params?.[0], effectiveAt);
  assert.deepEqual(insert.params?.filter((value) => value === "model-a" || value === "model-b"), ["model-a", "model-b"]);
  assert.doesNotMatch(insert.sql, /ON CONFLICT[\s\S]*DO UPDATE/);
});

test("가격이 같아 revision이 0개여도 성공 조직 날짜를 기록해 다음 tick을 건너뛴다", async () => {
  const fixture = createSyncClient([latestRow()]);
  const pricing: PricingMap = new Map([["model-a", { inputPerM: 1, outputPerM: 2 }]]);
  const effectiveAt = new Date("2026-07-10T12:00:00Z");

  const inserted = await runPricingSyncTransaction(
    fixture.client,
    async () => pricing,
    "2026-07-10",
    effectiveAt,
    () => {},
    () => effectiveAt,
  );

  assert.equal(inserted, 0);
  const settingQuery = fixture.queries.find((query) => query.sql.includes("INSERT INTO app_settings"));
  assert.ok(settingQuery);
  assert.equal(settingQuery.params?.[0], PRICING_SYNC_STATUS_SETTING_KEY);
  const saved = JSON.parse(String(settingQuery.params?.[1]));
  assert.deepEqual(saved, {
    day: "2026-07-10",
    syncedAt: "2026-07-10T12:00:00.000Z",
  });

  const status = await loadPricingStatus(
    async () => ({ rows: [{ models: "1" }] }),
    async (key) => {
      assert.equal(key, PRICING_SYNC_STATUS_SETTING_KEY);
      return saved;
    },
  );
  assert.deepEqual(status, { models: 1, lastDay: "2026-07-10" });
  assert.equal(pricingSyncDueToday(status.lastDay, "2026-07-10"), false);
});

test("동시 가격 sync는 transaction advisory lock으로 단일 revision만 만든다", async () => {
  const fixture = createConcurrentSyncClients();
  const pricing: PricingMap = new Map([["model-a", { inputPerM: 3, outputPerM: 4 }]]);
  const invalidated: string[] = [];
  const run = (label: string, effectiveAt: Date) => runPricingSyncTransaction(
    fixture.client(label),
    async () => {
      fixture.events.push(`${label}:fetch`);
      return pricing;
    },
    "2026-07-10",
    effectiveAt,
    () => invalidated.push(label),
  );

  const results = await Promise.all([
    run("first", new Date("2026-07-10T12:00:00.000Z")),
    run("second", new Date("2026-07-10T12:00:00.001Z")),
  ]);

  assert.deepEqual([...results].sort(), [0, 1]);
  assert.equal(fixture.insertCount, 1);
  assert.deepEqual(invalidated.sort(), ["first", "second"]);
  for (const label of ["first", "second"]) {
    const lockIndex = fixture.events.indexOf(`${label}:lock-acquired`);
    const fetchIndex = fixture.events.indexOf(`${label}:fetch`);
    assert.notEqual(lockIndex, -1);
    assert.notEqual(fetchIndex, -1);
    assert.ok(lockIndex < fetchIndex);
  }
});

test("요청 시작 순서와 lock 실행 순서가 달라도 나중 fetch 가격이 최신 revision이 된다", async () => {
  const fixture = createRevisionHistoryClient();
  const events: string[] = [];
  const sync = (
    inputPerM: number,
    requestedAt: Date,
    observedAt: Date,
  ) => runPricingSyncTransaction(
    fixture.client,
    async () => {
      events.push(`fetch:${inputPerM}`);
      return new Map([["model-a", { inputPerM, outputPerM: inputPerM }]]);
    },
    "2026-07-10",
    requestedAt,
    () => {},
    () => {
      events.push(`timestamp:${inputPerM}`);
      return observedAt;
    },
  );

  await sync(2, new Date("2026-07-10T12:00:00.002Z"), new Date("2026-07-10T12:00:00.010Z"));
  await sync(3, new Date("2026-07-10T12:00:00.001Z"), new Date("2026-07-10T12:00:00.011Z"));

  assert.equal(Number(fixture.latest().row.input_price_per_mtok), 3);
  assert.equal(fixture.latest().effectiveAt.toISOString(), "2026-07-10T12:00:00.011Z");
  assert.equal(fixture.syncStatus?.syncedAt, "2026-07-10T12:00:00.011Z");
  assert.deepEqual(events, ["fetch:2", "timestamp:2", "fetch:3", "timestamp:3"]);
});
