import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";
import { changeUserTeam } from "../apps/web/lib/team-membership";
import {
  PgTeamAttributionRepository,
  runTeamAttributionBatchAt,
} from "../apps/web/lib/team-attribution";
import { PostgresStorage } from "../packages/storage-postgres/src/storage";
import type { FinalizedUsageEvent } from "../packages/core/src/storage";

const MIGRATION = "migrations/1700000042_team_membership_attribution.sql";
const execFileAsync = promisify(execFile);

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 1_000, max: 1 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

async function migrationUps(): Promise<string[]> {
  const names = (await readdir("migrations"))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => (
    await readFile(`migrations/${name}`, "utf8")
  ).split("-- Down Migration", 1)[0]!));
}

function usageEvent(
  dedupKey: string,
  userId: string,
  ts: Date,
): FinalizedUsageEvent {
  return {
    dedupKey,
    providerKey: "integration",
    userId,
    sessionId: dedupKey,
    model: "integration-model",
    ts,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    pricingRevisionId: null,
    costStatus: "legacy",
  };
}

test("migration 42는 시각 기반 팀 소속 원장과 durable 귀속 작업을 만든다", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const up = sql.split("-- Down Migration", 1)[0] ?? "";

  assert.match(up, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
  assert.match(up, /DROP CONSTRAINT IF EXISTS user_department_assignments_user_id_effective_from_key/);
  assert.match(up, /effective_from TYPE TIMESTAMPTZ[\s\S]*AT TIME ZONE 'UTC'/);
  assert.match(up, /effective_to TYPE TIMESTAMPTZ[\s\S]*AT TIME ZONE 'UTC'/);
  assert.match(up, /EXCLUDE USING gist[\s\S]*tstzrange\(effective_from, effective_to, '\[\)'\)[\s\S]*WITH &&/);
  assert.match(up, /WHERE effective_to IS NULL/);
  assert.match(up, /assignment_kind IN \('onboarding', 'admin', 'legacy_seed'\)/);
  assert.match(up, /INSERT INTO user_team_assignments[\s\S]*'-infinity'::timestamptz[\s\S]*'legacy_seed'/);

  assert.match(up, /CREATE TABLE team_attribution_jobs/);
  assert.match(up, /kind IN \('initial_backfill', 'legacy_adoption'\)/);
  assert.match(up, /status IN \('pending', 'running', 'succeeded', 'failed'\)/);
  assert.match(up, /UNIQUE \(assignment_id, kind\)/);
  assert.match(up, /CREATE TABLE team_attribution_read_fences/);
  assert.match(up, /CREATE FUNCTION complete_team_attribution_fence/);
  assert.match(up, /SECURITY DEFINER/);
});

test("migration 42는 app role에 최소 귀속 권한만 부여한다", async () => {
  const bootstrap = await readFile("scripts/bootstrap-app-role.sql", "utf8");
  assert.match(bootstrap, /team_attribution_jobs/);
  assert.match(bootstrap, /user_team_assignments/);
  assert.match(bootstrap, /team_attribution_read_fences/);
  assert.doesNotMatch(bootstrap, /GRANT[^;]*DELETE[^;]*team_attribution_jobs/i);
});

test("최초 배정은 과거 미배정 사용량을 귀속하고 이후 이동은 이벤트 시각 경계를 지킨다", { timeout: 240_000 }, async () => {
  const container = `toard-team-attribution-${randomUUID().slice(0, 8)}`;
  let pool: Pool | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    pool = new Pool({ connectionString, max: 4 });
    for (const sql of await migrationUps()) await pool.query(sql);

    const adminId = randomUUID();
    const userId = randomUUID();
    const teamA = randomUUID();
    const teamB = randomUUID();
    await pool.query("INSERT INTO teams (id, name) VALUES ($1, 'A'), ($2, 'B')", [teamA, teamB]);
    await pool.query(
      `INSERT INTO users (id, email, role) VALUES
       ($1, 'admin@example.test', 'admin'), ($2, 'member@example.test', 'member')`,
      [adminId, userId],
    );
    await pool.query(
      `INSERT INTO providers
         (key, display_name, service_name_patterns, collection_method, enabled)
       VALUES ('integration', 'Integration', '{}', 'logfile', true)
       ON CONFLICT (key) DO NOTHING`,
    );

    const storage = new PostgresStorage(pool, { timezone: "UTC" });
    const historical = [
      usageEvent("historical-1", userId, new Date("2026-01-01T00:00:00.000Z")),
      usageEvent("historical-2", userId, new Date("2026-01-02T00:00:00.000Z")),
      usageEvent("historical-3", userId, new Date("2026-01-03T00:00:00.000Z")),
    ];
    assert.deepEqual(await storage.saveUsageEvents(historical), { inserted: 3, deduped: 0 });
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM usage_events WHERE user_id=$1 AND team_id IS NULL",
      [userId],
    )).rows[0].count, 3);

    const firstAssignment = await changeUserTeam(pool, {
      userId,
      teamId: teamA,
      actorId: adminId,
      now: new Date("2026-02-01T00:00:00.000Z"),
    });
    assert.equal(firstAssignment.kind, "initial_assignment");
    assert.ok(firstAssignment.attributionJobId);

    const repository = new PgTeamAttributionRepository(pool);
    const workerDependencies = { repository, storage, limit: 2 };
    const workerNow = new Date(Date.now() + 1_000);
    assert.equal(
      await runTeamAttributionBatchAt(workerNow, workerDependencies),
      "progress",
    );
    assert.equal(
      await runTeamAttributionBatchAt(new Date(workerNow.getTime() + 1_000), workerDependencies),
      "complete",
    );
    const afterBackfill = await pool.query<{ team_id: string | null; count: number }>(
      `SELECT team_id, COUNT(*)::int AS count
         FROM usage_events WHERE user_id=$1 GROUP BY team_id`,
      [userId],
    );
    assert.deepEqual(afterBackfill.rows, [{ team_id: teamA, count: 3 }]);
    assert.equal((await pool.query(
      "SELECT status FROM team_attribution_jobs WHERE id=$1",
      [firstAssignment.attributionJobId],
    )).rows[0].status, "succeeded");

    const boundary = new Date("2026-03-01T00:00:00.000Z");
    const transfer = await changeUserTeam(pool, {
      userId,
      teamId: teamB,
      actorId: adminId,
      now: boundary,
    });
    assert.equal(transfer.kind, "transfer");
    assert.equal(transfer.attributionJobId, null);

    assert.deepEqual(await storage.saveUsageEvents([
      usageEvent("delayed-before-transfer", userId, new Date(boundary.getTime() - 1)),
      usageEvent("at-transfer-boundary", userId, boundary),
    ]), { inserted: 2, deduped: 0 });
    const boundaryRows = await pool.query<{ dedup_key: string; team_id: string | null }>(
      `SELECT dedup_key, team_id FROM usage_events
        WHERE dedup_key IN ('delayed-before-transfer', 'at-transfer-boundary')
        ORDER BY dedup_key`,
    );
    assert.deepEqual(boundaryRows.rows, [
      { dedup_key: "at-transfer-boundary", team_id: teamB },
      { dedup_key: "delayed-before-transfer", team_id: teamA },
    ]);
  } finally {
    await pool?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
