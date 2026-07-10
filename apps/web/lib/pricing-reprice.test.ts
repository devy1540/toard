import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repriceModule: Partial<typeof import("./pricing-reprice")> = await import("./pricing-reprice").catch(() => ({}));

type Query = { sql: string; params?: unknown[] };

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function createPoolWithEvents() {
  const queries: Query[] = [];
  const updates: Array<[string, number]> = [];
  let selectCount = 0;

  const client = {
    async query<T>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] as T[] };
      if (sql.includes("FROM usage_events")) {
        selectCount += 1;
        return {
          rows: (selectCount === 1
            ? [
                {
                  dedup_key: "a",
                  model: "gpt-5.6-sol",
                  input_tokens: "1000000",
                  output_tokens: "0",
                  cache_read_tokens: "0",
                  cache_creation_tokens: "0",
                  day: "2026-07-09",
                },
                {
                  dedup_key: "b",
                  model: "gpt-5.6-sol",
                  input_tokens: "0",
                  output_tokens: "0",
                  cache_read_tokens: "1000000",
                  cache_creation_tokens: "0",
                  day: "2026-07-10",
                },
              ]
            : []) as T[],
        };
      }
      if (sql.includes("UPDATE usage_events")) {
        for (let i = 0; i < (params?.length ?? 0); i += 2) {
          updates.push([String(params![i]), Number(params![i + 1])]);
        }
      }
      return { rows: [] as T[] };
    },
    release() {},
  };

  return {
    pool: { async connect() { return client; } },
    queries,
    updates,
  };
}

test("repriceUsageCostsWithPool recalculates every retained event and returns affected days", async () => {
  const reprice = repriceModule.repriceUsageCostsWithPool;
  assert.equal(typeof reprice, "function");
  if (!reprice) return;
  const fixture = createPoolWithEvents();
  const pricing = new Map([["gpt-5.6-sol", { inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 }]]);

  const result = await reprice(fixture.pool, pricing, "UTC");

  assert.deepEqual(result, { repriced: 2, unpriced: 0, days: ["2026-07-09", "2026-07-10"] });
  assert.deepEqual(fixture.updates, [["a", 5], ["b", 0.5]]);
  assert.match(fixture.queries.find((query) => query.sql.includes("FROM usage_events"))!.sql, /ORDER BY dedup_key/);
  assert.match(fixture.queries.find((query) => query.sql.includes("UPDATE usage_events"))!.sql, /cost_usd/);
});

test("admin pricing panel exposes a separately confirmed full-retention reprice action", () => {
  const panel = source("app/(dashboard)/admin/pricing-panel.tsx");
  const actions = source("app/(dashboard)/admin/pricing-actions.ts");

  assert.match(panel, /name="confirm-reprice"/);
  assert.match(actions, /export async function repriceUsageAction/);
  assert.match(actions, /user\.role !== "admin"/);
  assert.match(actions, /STORAGE_BACKEND === "clickhouse"/);
});

test("full-retention reprice uses the existing settings divider instead of a standalone warning panel", () => {
  const panel = source("app/(dashboard)/admin/pricing-panel.tsx");

  assert.match(panel, /<div className="border-t pt-3">/);
  assert.doesNotMatch(panel, /border-amber-500|bg-amber-500/);
});
