// ClickHouseStorage 스모크 검증 — 저장·dedup·집계·라벨(PG) 머지.
// 사용: ClickHouse·Postgres(시드 완료) 기동 후 `pnpm exec tsx scripts/verify-clickhouse.ts`
import "dotenv/config"; // 루트 .env 로드 (셸 env 우선)
import { Pool } from "pg";
// scripts/ 는 root devDep 만 보므로 패키지를 상대 경로로 import(내부 deps 는 패키지 자신의 node_modules 에서 resolve)
import { createClickHouseStorage } from "../packages/storage-clickhouse/src/index.ts";

const pg = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://toard:toard@localhost:5432/toard",
});

async function main(): Promise<void> {
  const s = createClickHouseStorage(pg);

  const u = await pg.query<{ id: string; team_id: string | null }>(
    "SELECT id, team_id FROM users WHERE team_id IS NOT NULL LIMIT 1",
  );
  const userId = u.rows[0]?.id ?? null;
  console.log("PG user:", userId, "/ dept:", u.rows[0]?.team_id ?? "(none)");

  const now = new Date();
  const ev = {
    dedupKey: "ch-verify-dept-key",
    providerKey: "claude_code",
    userId,
    sessionId: "ch-sess-1",
    model: "claude-sonnet-4-5",
    ts: now,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheCreationTokens: 0,
    costUsd: 0.01,
  };

  console.log("save #1:", await s.saveUsageEvents([ev]));
  console.log("save #2 (동일 dedupKey → deduped 기대):", await s.saveUsageEvents([ev]));

  const from = new Date(now.getTime() - 86_400_000);
  const to = new Date(now.getTime() + 86_400_000);
  console.log("overview:", await s.getOverview({ from, to }));
  console.log("daily:", await s.getDailyTimeseries({ from, to }));
  console.log("leaderboard(user):", await s.getLeaderboard({ from, to, scope: "user" }));
  console.log("leaderboard(dept):", await s.getLeaderboard({ from, to, scope: "team" }));

  await pg.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
