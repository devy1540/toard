import assert from "node:assert/strict";
import { test } from "node:test";
import type { PricingMap } from "@toard/pricing";
import { loadPricingSchedule } from "./pricing";
import { syncPricingRevisions } from "./pricing-sync";

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
