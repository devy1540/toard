import assert from "node:assert/strict";
import test from "node:test";
import { LATEST_SCHEMA_VERSION } from "../packages/core/src/deployment-release";
import { insertDeploymentReleaseCompletion } from "./mark-deployment-release-complete";

const COMPLETION_ID = "b".repeat(64);
const ENV = {
  TOARD_DEPLOYMENT_ID: "toard/toard",
  TOARD_RELEASE_COMPLETION_ID: COMPLETION_ID,
  TOARD_EXPECTED_SCHEMA_VERSION: String(LATEST_SCHEMA_VERSION),
};

test("release completion marker는 단일 parameterized INSERT만 실행한다", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  await insertDeploymentReleaseCompletion({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
  }, ENV);

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.match(call.sql, /^\s*INSERT INTO deployment_release_completions/);
  assert.match(call.sql, /VALUES \(\$1, \$2, \$3/);
  assert.equal(call.sql.includes(COMPLETION_ID), false);
  assert.equal(call.params.length, 3);
  assert.equal(call.params[0], "toard/toard");
  assert.equal(call.params[1] === COMPLETION_ID, true);
  assert.equal(call.params[2], LATEST_SCHEMA_VERSION);
});

test("marker conflict와 invalid env는 completion detail 없이 fail-closed 한다", async () => {
  let queries = 0;
  const db = {
    async query() {
      queries += 1;
      return { rowCount: 0 };
    },
  };

  await assert.rejects(
    insertDeploymentReleaseCompletion(db, ENV),
    (error: Error) => (
      error.message === "DEPLOYMENT_RELEASE_MARKER_CONFLICT"
      && !error.message.includes(COMPLETION_ID)
    ),
  );
  assert.equal(queries, 1);

  await assert.rejects(
    insertDeploymentReleaseCompletion(db, {
      ...ENV,
      TOARD_RELEASE_COMPLETION_ID: "short",
    }),
    /DEPLOYMENT_RELEASE_ENV_INVALID/,
  );
  assert.equal(queries, 1);
});
