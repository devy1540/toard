import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GET as statusGet } from "../app/api/admin/content-retirement/status/route";
import { POST as confirmPost } from "../app/api/admin/content-retirement/confirm-backup/route";
import { LegacyRetirementError } from "./e2ee-legacy-retirement";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN = { id: ADMIN_ID, role: "admin" } as never;
const MEMBER = { id: "00000000-0000-4000-8000-000000000002", role: "member" } as never;
const STATUS = {
  state: "backup_confirmation_required",
  legacyRecords: 0,
  zeroObservedAt: "2026-06-01T00:00:00.000Z",
  retentionDays: 30,
  eligibleAt: "2026-07-01T00:00:00.000Z",
  backupConfirmedAt: null,
  kekConfigured: true,
  keyRetiredObservedAt: null,
} as const;

test("retirement status는 관리자만 접근하고 no-store DTO를 반환한다", async () => {
  const unauthorized = await statusGet.withDependencies({ getSessionUser: async () => null })();
  const forbidden = await statusGet.withDependencies({ getSessionUser: async () => MEMBER })();
  assert.equal(unauthorized.status, 401);
  assert.equal(forbidden.status, 403);
  const response = await statusGet.withDependencies({
    getSessionUser: async () => ADMIN,
    getLegacyRetirementStatus: async () => STATUS,
  })();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), STATUS);
});

test("backup confirm은 관리자 ID로 확인하고 준비 전 상태는 409로 반환한다", async () => {
  let actor = "";
  const success = await confirmPost.withDependencies({
    getSessionUser: async () => ADMIN,
    confirmLegacyBackupPurge: async (id) => {
      actor = id;
      return { ...STATUS, state: "ready_to_remove_key", backupConfirmedAt: "2026-07-14T00:00:00.000Z" } as never;
    },
  })(new Request("http://toard/api/admin/content-retirement/confirm-backup", { method: "POST" }));
  assert.equal(success.status, 200);
  assert.equal(actor, ADMIN_ID);
  assert.equal(success.headers.get("cache-control"), "no-store");

  const conflict = await confirmPost.withDependencies({
    getSessionUser: async () => ADMIN,
    confirmLegacyBackupPurge: async () => {
      throw new LegacyRetirementError("BACKUP_CONFIRMATION_NOT_READY");
    },
  })(new Request("http://toard/api/admin/content-retirement/confirm-backup", { method: "POST" }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "BACKUP_CONFIRMATION_NOT_READY" });
});

test("관리자 시스템 화면은 폐기 상태 패널과 한영 문구를 제공한다", () => {
  const page = readFileSync(new URL("../app/(dashboard)/admin/page.tsx", import.meta.url), "utf8");
  const ko = JSON.parse(readFileSync(new URL("../messages/ko/admin.json", import.meta.url), "utf8"));
  const en = JSON.parse(readFileSync(new URL("../messages/en/admin.json", import.meta.url), "utf8"));
  assert.match(page, /LegacyRetirementPanel/);
  assert.equal(typeof ko.system.legacyRetirementTitle, "string");
  assert.equal(typeof en.system.legacyRetirementTitle, "string");
  assert.deepEqual(Object.keys(ko.system.legacyRetirementStates), Object.keys(en.system.legacyRetirementStates));
});
