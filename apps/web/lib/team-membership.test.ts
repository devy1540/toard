import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";
import { changeUserTeam, TeamMembershipError } from "./team-membership";

type Seed = {
  currentTeamId: string | null;
  assignments: Array<{ id: string; team_id: string; effective_from: Date; effective_to: Date | null }>;
  teamExists?: boolean;
  role?: string;
  onboardingCompletedAt?: Date | null;
};

function poolFixture(seed: Seed): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (text: string, params: unknown[] = []): Promise<QueryResult> => {
    const sql = text.replace(/\s+/g, " ").trim();
    calls.push({ sql, params });
    if (sql.startsWith("SELECT id, team_id, role, team_onboarding_completed_at")) {
      return {
        rows: [{
          id: "user-1",
          team_id: seed.currentTeamId,
          role: seed.role ?? "member",
          team_onboarding_completed_at: seed.onboardingCompletedAt ?? null,
        }],
        rowCount: 1,
      } as QueryResult;
    }
    if (sql.startsWith("SELECT 1 FROM teams")) {
      return {
        rows: seed.teamExists === false ? [] : [{ "?column?": 1 }],
        rowCount: seed.teamExists === false ? 0 : 1,
      } as QueryResult;
    }
    if (sql.includes("FROM user_team_assignments") && sql.includes("FOR UPDATE")) {
      return { rows: seed.assignments, rowCount: seed.assignments.length } as QueryResult;
    }
    if (sql.startsWith("INSERT INTO user_team_assignments")) {
      return { rows: [{ id: "assignment-new" }], rowCount: 1 } as QueryResult;
    }
    if (sql.startsWith("INSERT INTO team_attribution_jobs")) {
      return { rows: [{ id: "job-new" }], rowCount: 1 } as QueryResult;
    }
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  };
  const client = { query, release() {} } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as unknown as Pool,
    calls,
  };
}

test("첫 팀 배정은 -infinity 소속과 initial backfill 작업을 함께 만든다", async () => {
  const fixture = poolFixture({ currentTeamId: null, assignments: [] });
  const result = await changeUserTeam(fixture.pool, {
    userId: "user-1",
    teamId: "team-a",
    actorId: "admin-1",
    now: new Date("2026-07-19T15:00:00.000Z"),
  });

  assert.deepEqual(result, {
    changed: true,
    kind: "initial_assignment",
    assignmentId: "assignment-new",
    attributionJobId: "job-new",
  });
  const membership = fixture.calls.find((call) => call.sql.startsWith("INSERT INTO user_team_assignments"));
  assert.equal(membership?.params[2], "-infinity");
  assert.equal(membership?.params[4], "admin");
  assert.ok(fixture.calls.some((call) => call.sql.startsWith("INSERT INTO team_attribution_jobs")));
});

test("팀 이동과 재배정은 변경 시각부터 열고 과거 백필을 만들지 않는다", async () => {
  const now = new Date("2026-07-19T15:10:00.000Z");
  const transfer = poolFixture({
    currentTeamId: "team-a",
    assignments: [{ id: "old", team_id: "team-a", effective_from: new Date(0), effective_to: null }],
  });
  const moved = await changeUserTeam(transfer.pool, {
    userId: "user-1", teamId: "team-b", actorId: "admin-1", now,
  });
  assert.equal(moved.kind, "transfer");
  assert.equal(moved.attributionJobId, null);
  const movedInsert = transfer.calls.find((call) => call.sql.startsWith("INSERT INTO user_team_assignments"));
  assert.equal((movedInsert?.params[2] as Date).toISOString(), now.toISOString());

  const reassignment = poolFixture({
    currentTeamId: null,
    assignments: [{ id: "old", team_id: "team-a", effective_from: new Date(0), effective_to: now }],
  });
  const reassigned = await changeUserTeam(reassignment.pool, {
    userId: "user-1", teamId: "team-b", actorId: "admin-1", now,
  });
  assert.equal(reassigned.kind, "reassignment");
  assert.equal(reassigned.attributionJobId, null);
});

test("동일 팀은 no-op이고 존재하지 않는 팀은 rollback한다", async () => {
  const same = poolFixture({ currentTeamId: "team-a", assignments: [] });
  assert.deepEqual(await changeUserTeam(same.pool, {
    userId: "user-1", teamId: "team-a", actorId: "admin-1",
  }), {
    changed: false, kind: "noop", assignmentId: null, attributionJobId: null,
  });

  const missing = poolFixture({ currentTeamId: null, assignments: [], teamExists: false });
  await assert.rejects(
    changeUserTeam(missing.pool, { userId: "user-1", teamId: "missing", actorId: "admin-1" }),
    (error: unknown) => error instanceof TeamMembershipError && error.code === "TEAM_NOT_FOUND",
  );
  assert.ok(missing.calls.some((call) => call.sql === "ROLLBACK"));
});

test("관리자와 온보딩 팀 변경은 공통 소속 서비스만 사용한다", async () => {
  const [admin, onboarding] = await Promise.all([
    readFile(new URL("../app/(dashboard)/admin/team-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/onboarding/team/actions.ts", import.meta.url), "utf8"),
  ]);

  assert.match(admin, /changeUserTeam\(getPool\(\)/);
  assert.match(admin, /user_team_assignments/);
  assert.doesNotMatch(admin, /UPDATE users SET team_id/);
  assert.match(onboarding, /changeUserTeam\(/);
  assert.match(onboarding, /completeOnboarding:\s*true/);
  assert.doesNotMatch(onboarding, /UPDATE users SET team_id/);
});

test("온보딩 완료가 경합으로 먼저 저장되면 팀을 덮어쓰지 않는다", async () => {
  const fixture = poolFixture({
    currentTeamId: "team-a",
    assignments: [{ id: "old", team_id: "team-a", effective_from: new Date(0), effective_to: null }],
    onboardingCompletedAt: new Date("2026-07-19T14:00:00.000Z"),
  });
  const result = await changeUserTeam(fixture.pool, {
    userId: "user-1",
    teamId: "team-b",
    actorId: "user-1",
    completeOnboarding: true,
  });
  assert.equal(result.kind, "noop");
  assert.equal(result.changed, false);
  assert.equal(fixture.calls.some((call) => call.sql.startsWith("UPDATE users SET team_id")), false);
});
