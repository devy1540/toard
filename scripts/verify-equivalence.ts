// PG↔CH 동등성 동적 대조 — 같은 이벤트셋을 양쪽에 저장하고 같은 기간 쿼리 결과를 비교.
// 격리 기간(2027)을 써서 기존 데이터와 섞이지 않게 한다.
import "dotenv/config"; // 루트 .env 로드 (셸 env 우선)
import { Pool } from "pg";
import { createClickHouseStorage } from "../packages/storage-clickhouse/src/index.ts";
import { PostgresStorage } from "../packages/storage-postgres/src/index.ts";

const pg = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://toard:toard@localhost:5432/toard",
});

async function main(): Promise<void> {
  const pgS = new PostgresStorage(pg);
  const chS = createClickHouseStorage(pg);

  const us = await pg.query<{ id: string; team_id: string | null }>(
    "SELECT DISTINCT ON (team_id) id, team_id FROM users WHERE team_id IS NOT NULL ORDER BY team_id, created_at LIMIT 2",
  );
  const u0 = us.rows[0]!.id;
  const u1 = us.rows[1]?.id ?? u0;
  const dept0 = us.rows[0]!.team_id!;
  const pk = (await pg.query<{ key: string }>("SELECT key FROM providers ORDER BY key LIMIT 1")).rows[0]!.key;
  console.log(`provider_key=${pk}  u0 dept=${dept0}  u1 dept=${us.rows[1]?.team_id}`);

  const base = new Date("2027-09-15T10:00:00.000Z");
  const events = [
    { dedupKey: "eqv-e1", providerKey: pk, userId: u0, sessionId: "eqv-se1", model: "claude-sonnet-4-5", ts: base, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100, costUsd: 0.03 },
    { dedupKey: "eqv-e2", providerKey: pk, userId: u1, sessionId: "eqv-se2", model: "gpt-5", ts: new Date(base.getTime() + 3_600_000), inputTokens: 2000, outputTokens: 800, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.05 },
  ];

  console.log("save PG:", await pgS.saveUsageEvents(events));
  console.log("save CH:", await chS.saveUsageEvents(events));

  const period = { from: new Date("2027-09-01T00:00:00Z"), to: new Date("2027-10-01T00:00:00Z") };

  let mismatches = 0;
  const cmp = async (name: string, fn: (s: PostgresStorage | ReturnType<typeof createClickHouseStorage>) => Promise<unknown>): Promise<void> => {
    const p = await fn(pgS);
    const c = await fn(chS);
    const eq = JSON.stringify(p) === JSON.stringify(c);
    console.log(`${eq ? "✓" : "✗ MISMATCH"} ${name}`);
    if (!eq) {
      mismatches += 1;
      console.log("  PG:", JSON.stringify(p));
      console.log("  CH:", JSON.stringify(c));
    }
  };

  await cmp("getOverview", (s) => s.getOverview(period));
  await cmp("getDailyTimeseries(전체)", (s) => s.getDailyTimeseries(period));
  await cmp("getLeaderboard(user)", (s) => s.getLeaderboard({ ...period, scope: "user" }));
  await cmp("getLeaderboard(team)", (s) => s.getLeaderboard({ ...period, scope: "team" }));
  await cmp("getUserUsage", (s) => s.getUserUsage(u0, period));
  const insightQuery = {
    previous: { from: new Date("2027-09-14T00:00:00Z"), to: new Date("2027-09-15T00:00:00Z") },
    current: { from: new Date("2027-09-15T00:00:00Z"), to: new Date("2027-09-16T00:00:00Z") },
    providerKey: pk,
    timezone: "UTC",
  };
  await cmp("getUserInsightComparison", (s) => s.getUserInsightComparison(u0, insightQuery));
  // scope=team: PG/CH 둘 다 team_id 비정규화로 필터(7a057b6 이후) → 일치해야 함
  await cmp("getDailyTimeseries(scope=team)", (s) => s.getDailyTimeseries({ ...period, scope: "team", teamId: dept0 }));

  console.log(mismatches === 0 ? "\n전부 일치" : `\n${mismatches}건 불일치 (위 ✗)`);
  await pg.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
