import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLegacyContentKeyReady,
  LegacyContentReadinessError,
  legacyKekConfigured,
} from "./legacy-content-readiness";

function db(count: number) {
  return { query: async () => ({ rows: [{ legacy_records: String(count) }] }) };
}

const validKek = Buffer.alloc(32, 7).toString("base64");

test("legacy KEK는 정확히 base64 32바이트일 때만 설정된 것으로 본다", () => {
  assert.equal(legacyKekConfigured({}), false);
  assert.equal(legacyKekConfigured({ TOARD_CONTENT_KEK_B64: "not-base64" }), false);
  assert.equal(legacyKekConfigured({ TOARD_CONTENT_KEK_B64: Buffer.alloc(31).toString("base64") }), false);
  assert.equal(legacyKekConfigured({ TOARD_CONTENT_KEK_B64: validKek }), true);
});

test("legacy 0건이면 KEK가 없어도 readiness를 통과한다", async () => {
  let sql = "";
  await assert.doesNotReject(assertLegacyContentKeyReady({
    query: async (query) => {
      sql = query;
      return { rows: [{ legacy_records: "0" }] };
    },
  }, {}));
  assert.match(sql, /content_legacy_retirement/);
  assert.doesNotMatch(sql, /FROM prompt_records/);
});

test("legacy가 남아 있어도 유효한 KEK가 있으면 readiness를 통과한다", async () => {
  await assert.doesNotReject(assertLegacyContentKeyReady(db(2), { TOARD_CONTENT_KEK_B64: validKek }));
});

test("legacy가 남았는데 KEK가 없거나 잘못되면 fail-closed한다", async () => {
  for (const env of [{}, { TOARD_CONTENT_KEK_B64: "invalid" }]) {
    await assert.rejects(
      assertLegacyContentKeyReady(db(1), env),
      (error) => error instanceof LegacyContentReadinessError
        && error.code === "LEGACY_CONTENT_KEY_MISSING"
        && error.legacyRecords === 1,
    );
  }
});
