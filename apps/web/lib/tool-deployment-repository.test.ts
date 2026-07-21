import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createToolDeploymentRepository,
  type ToolDeploymentDb,
} from "./tool-deployment-repository";

type Call = { sql: string; params?: unknown[] };

function recordingDb(): ToolDeploymentDb & { calls: Call[]; released: boolean } {
  const calls: Call[] = [];
  let released = false;
  const client = {
    async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: [] as T[], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    get released() {
      return released;
    },
    async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      return client.query<T>(sql, params);
    },
    async connect() {
      return client;
    },
  };
}

test("migration은 version, 정책, 개인 선택, report, audit 관계를 만든다", () => {
  const sql = readFileSync(
    new URL("../../../migrations/1700000046_tool_deployment.sql", import.meta.url),
    "utf8",
  );

  for (const table of [
    "tool_versions",
    "team_tool_policies",
    "user_tool_preferences",
    "user_tool_preference_devices",
    "tool_deployment_reports",
    "tool_deployment_audit",
    "github_app_installations",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(sql, /UNIQUE \(catalog_item_id, source_identity, exact_ref, tree_digest\)/);
  assert.match(sql, /status IN \('queued'.*'unsupported'\)/s);
  assert.match(sql, /ALTER TABLE users\s+ADD COLUMN team_role/);
  assert.doesNotMatch(sql, /secret_value|token_value|access_token|private_key/);
});

test("개인 선택은 기기 목록과 audit을 한 transaction에서 저장한다", async () => {
  const db = recordingDb();
  const repository = createToolDeploymentRepository(db);

  await repository.savePersonalPreference({
    actorUserId: "user-1",
    catalogItemId: "catalog-1",
    mode: "install",
    scope: "selected_devices",
    versionId: "version-1",
    deviceFingerprints: ["b".repeat(64), "a".repeat(64), "a".repeat(64)],
  });

  assert.deepEqual(db.calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 4).join(" ")), [
    "BEGIN",
    "INSERT INTO user_tool_preferences (user_id,",
    "DELETE FROM user_tool_preference_devices WHERE",
    "INSERT INTO user_tool_preference_devices (user_id,",
    "INSERT INTO user_tool_preference_devices (user_id,",
    "INSERT INTO tool_deployment_audit (actor_user_id,",
    "COMMIT",
  ]);
  assert.deepEqual(db.calls[3]?.params, ["user-1", "catalog-1", "a".repeat(64)]);
  assert.deepEqual(db.calls[4]?.params, ["user-1", "catalog-1", "b".repeat(64)]);
  assert.equal(db.released, true);
  assert.equal(JSON.stringify(db.calls).includes("secret"), false);
});

test("개인 제외는 version과 선택 기기를 저장하지 않는다", async () => {
  const db = recordingDb();
  const repository = createToolDeploymentRepository(db);

  await repository.savePersonalPreference({
    actorUserId: "user-1",
    catalogItemId: "catalog-1",
    mode: "exclude",
    scope: "all_devices",
    versionId: null,
    deviceFingerprints: ["a".repeat(64)],
  });

  assert.equal(db.calls.filter((call) => /INSERT INTO user_tool_preference_devices/.test(call.sql)).length, 0);
  assert.equal(db.calls[1]?.params?.[4], null);
});

test("상태 report는 bearer token 소유권과 닫힌 상태만 upsert한다", async () => {
  const db = recordingDb();
  const repository = createToolDeploymentRepository(db);

  await repository.saveDeploymentReport(
    { userId: "user-1", tokenId: "token-1" },
    {
      deviceFingerprint: "a".repeat(64),
      catalogItemId: "catalog-1",
      desiredVersionId: "version-2",
      appliedVersionId: "version-1",
      status: "rolled_back",
      errorCode: "health_check_failed",
      attempt: 2,
      rolloutId: "rollout-1",
    },
  );

  assert.match(db.calls[0]!.sql, /ON CONFLICT \(ingest_token_id, device_fingerprint, catalog_item_id\)/);
  assert.deepEqual(db.calls[0]!.params?.slice(0, 2), ["user-1", "token-1"]);
  assert.equal(JSON.stringify(db.calls[0]).includes("errorMessage"), false);
});
