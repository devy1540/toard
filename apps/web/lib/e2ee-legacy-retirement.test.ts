import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveLegacyRetirementState,
  parseLegacyBackupRetentionDays,
  type LegacyRetirementStateInput,
} from "./e2ee-legacy-retirement";

const now = new Date("2026-07-14T12:00:00.000Z");
const zeroObservedAt = new Date("2026-07-01T00:00:00.000Z");

function input(overrides: Partial<LegacyRetirementStateInput> = {}): LegacyRetirementStateInput {
  return {
    legacyRecords: 0,
    zeroObservedAt,
    backupConfirmedAt: null,
    keyRetiredObservedAt: null,
    retentionDays: 30,
    kekConfigured: true,
    now,
    ...overrides,
  };
}

test("백업 보존일은 미설정과 0~3650 정수만 허용한다", () => {
  assert.equal(parseLegacyBackupRetentionDays({}), null);
  assert.equal(parseLegacyBackupRetentionDays({ TOARD_LEGACY_BACKUP_RETENTION_DAYS: "0" }), 0);
  assert.equal(parseLegacyBackupRetentionDays({ TOARD_LEGACY_BACKUP_RETENTION_DAYS: "30" }), 30);
  for (const value of ["-1", "1.5", "3651", "abc", " 30 "]) {
    assert.throws(
      () => parseLegacyBackupRetentionDays({ TOARD_LEGACY_BACKUP_RETENTION_DAYS: value }),
      /TOARD_LEGACY_BACKUP_RETENTION_DAYS/,
    );
  }
});

test("legacy가 남으면 KEK 유무에 따라 migrating 또는 unsafe_key_missing이다", () => {
  assert.equal(deriveLegacyRetirementState(input({ legacyRecords: 3 })).state, "migrating");
  assert.equal(
    deriveLegacyRetirementState(input({ legacyRecords: 3, kekConfigured: false })).state,
    "unsafe_key_missing",
  );
});

test("0건 관측 뒤 보존정책 미설정과 기간 대기를 구분한다", () => {
  assert.equal(deriveLegacyRetirementState(input({ retentionDays: null })).state, "backup_policy_unconfigured");
  const waiting = deriveLegacyRetirementState(input());
  assert.equal(waiting.state, "waiting_backup_retention");
  assert.equal(waiting.eligibleAt?.toISOString(), "2026-07-31T00:00:00.000Z");
});

test("보존기간 이후 확인 전·후와 KEK 제거 상태를 구분한다", () => {
  const elapsed = { zeroObservedAt: new Date("2026-06-01T00:00:00.000Z") };
  assert.equal(deriveLegacyRetirementState(input(elapsed)).state, "backup_confirmation_required");
  assert.equal(
    deriveLegacyRetirementState(input({ ...elapsed, backupConfirmedAt: now })).state,
    "ready_to_remove_key",
  );
  assert.equal(
    deriveLegacyRetirementState(input({ ...elapsed, kekConfigured: false })).state,
    "key_removed_unconfirmed",
  );
  assert.equal(
    deriveLegacyRetirementState(input({
      ...elapsed,
      backupConfirmedAt: now,
      kekConfigured: false,
      keyRetiredObservedAt: now,
    })).state,
    "retired",
  );
});

test("0건 최초 관측 전에는 관측 상태를 반환한다", () => {
  const result = deriveLegacyRetirementState(input({ zeroObservedAt: null }));
  assert.equal(result.state, "zero_observation_required");
  assert.equal(result.eligibleAt, null);
});
