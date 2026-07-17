import assert from "node:assert/strict";
import test from "node:test";
import { LATEST_SCHEMA_VERSION } from "../packages/core/src/deployment-release";
import { insertDeploymentReleaseCompletion } from "./mark-deployment-release-complete";

const TOKEN = "B".repeat(48);
const ENV = {
  TOARD_DEPLOYMENT_ID: "toard/toard",
  TOARD_RELEASE_REVISION: "7",
  TOARD_RELEASE_TOKEN: TOKEN,
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
  assert.match(call.sql, /VALUES \(\$1, \$2, \$3, \$4/);
  assert.equal(call.sql.includes(TOKEN), false);
  assert.equal(call.params.length, 4);
  assert.equal(call.params[0], "toard/toard");
  assert.equal(call.params[1], 7);
  assert.equal(call.params[2] === TOKEN, true);
  assert.equal(call.params[3], LATEST_SCHEMA_VERSION);
});

test("marker conflict와 invalid env는 token 없이 fail-closed 한다", async () => {
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
      && !error.message.includes(TOKEN)
    ),
  );
  assert.equal(queries, 1);

  await assert.rejects(
    insertDeploymentReleaseCompletion(db, {
      ...ENV,
      TOARD_RELEASE_TOKEN: "short",
    }),
    /DEPLOYMENT_RELEASE_ENV_INVALID/,
  );
  assert.equal(queries, 1);
});
