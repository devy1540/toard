import assert from "node:assert/strict";
import test from "node:test";
import {
  readUtilizationCacheGeneration,
  withAllUtilizationCacheChange,
  withUserUtilizationCacheChange,
  type UtilizationCacheGenerationDb,
} from "./utilization-cache-generation";

test("공유 활용 지수 generation row를 숫자 상태로 변환한다", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const db: UtilizationCacheGenerationDb = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{
        personal_user_generation: "4",
        personal_user_pending: 1,
        personal_all_generation: "2",
        personal_all_pending: 0,
        organization_generation: "9",
        organization_pending: 2,
      }] };
    },
  };

  assert.deepEqual(await readUtilizationCacheGeneration("user-1", db), {
    personalUserGeneration: 4,
    personalUserPending: 1,
    personalAllGeneration: 2,
    personalAllPending: 0,
    organizationGeneration: 9,
    organizationPending: 2,
  });
  assert.deepEqual(calls[0]?.values, ["user-1"]);
});

test("사용자 mutation은 begin 뒤 실행하고 실제 변경 여부로 finish한다", async () => {
  const lease = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const db: UtilizationCacheGenerationDb = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: calls.length === 1 ? [{ lease_id: lease }] : [] };
    },
  };

  const result = await withUserUtilizationCacheChange(
    "11111111-1111-1111-1111-111111111111",
    async () => ({ inserted: 1 }),
    db,
  );

  assert.deepEqual(result, { inserted: 1 });
  assert.match(calls[0]!.sql, /begin_user_utilization_cache_change/);
  assert.match(calls[1]!.sql, /finish_user_utilization_cache_change/);
  assert.deepEqual(calls[1]!.values, [lease, "11111111-1111-1111-1111-111111111111", true]);
});

test("전체 mutation attempt는 no-op이어도 rolling overlap 안전을 위해 generation을 전진시킨다", async () => {
  const lease = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const db: UtilizationCacheGenerationDb = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: calls.length === 1 ? [{ lease_id: lease }] : [] };
    },
  };

  await withAllUtilizationCacheChange(
    async () => ({ reconciled: 0 }),
    db,
  );

  assert.match(calls[0]!.sql, /begin_all_utilization_cache_change/);
  assert.match(calls[1]!.sql, /finish_all_utilization_cache_change/);
  assert.deepEqual(calls[1]!.values, [lease, true]);
});

test("mutation과 finish가 함께 실패하면 원래 mutation 오류를 보존하고 pending을 안전하게 남긴다", async () => {
  const primary = new Error("mutation failed");
  let calls = 0;
  const db: UtilizationCacheGenerationDb = {
    async query() {
      calls += 1;
      if (calls === 2) throw new Error("finish failed");
      return { rows: [{ lease_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }] };
    },
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await assert.rejects(
      withAllUtilizationCacheChange(
        async () => { throw primary; },
        db,
      ),
      (error) => error === primary,
    );
  } finally {
    console.warn = originalWarn;
  }
});
