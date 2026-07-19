import assert from "node:assert/strict";
import test from "node:test";
import { legacyE2eeCapability, type LegacyGateDb } from "./e2ee-legacy-gate";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function dbWith(row: Record<string, unknown>, rowCount = 1): LegacyGateDb & { calls: Array<{ sql: string; params?: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: rowCount === 0 ? [] : [row] };
    },
  };
}

test("계정이나 E2EE 잔여 데이터가 없으면 신규 E2EE 기능을 비활성화한다", async () => {
  const db = dbWith({ has_account: false, has_rows: false, blocked: false });
  assert.equal(await legacyE2eeCapability(USER_ID, db), "disabled");
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0]?.params, [USER_ID]);
  assert.doesNotMatch(db.calls[0]?.sql ?? "", new RegExp(USER_ID));
});

test("기존 E2EE ciphertext와 blocked migration을 각각 migration/recovery로 구분한다", async () => {
  assert.equal(await legacyE2eeCapability(USER_ID, dbWith({ has_account: true, has_rows: true, blocked: false })), "migration");
  assert.equal(await legacyE2eeCapability(USER_ID, dbWith({ has_account: true, has_rows: true, blocked: true })), "recovery");
});

test("정확히 한 행의 boolean 결과가 아니면 정보 노출 없이 fail-closed한다", async () => {
  for (const db of [
    dbWith({ has_account: "false", has_rows: false, blocked: false }),
    dbWith({ has_account: true, has_rows: 1, blocked: false }),
    dbWith({ has_account: true, has_rows: true, blocked: null }),
    dbWith({ has_account: true, has_rows: true, blocked: false, extra: false }),
    dbWith({}, 0),
  ]) {
    await assert.rejects(legacyE2eeCapability(USER_ID, db), /LEGACY_E2EE_CAPABILITY_INVALID/);
  }
});
