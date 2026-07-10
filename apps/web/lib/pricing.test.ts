import assert from "node:assert/strict";
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
