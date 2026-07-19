import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATION = "migrations/1700000042_team_membership_attribution.sql";

test("migration 42는 시각 기반 팀 소속 원장과 durable 귀속 작업을 만든다", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const up = sql.split("-- Down Migration", 1)[0] ?? "";

  assert.match(up, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
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

