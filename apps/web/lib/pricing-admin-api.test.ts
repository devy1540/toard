import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { GET as statusGet } from "../app/api/admin/pricing/status/route";

const ADMIN = { role: "admin" } as never;
const MEMBER = { role: "member" } as never;

test("가격 상태 API는 비로그인과 비관리자를 차단하고 no-store를 유지한다", async () => {
  const unauthorized = await statusGet.withDependencies({ getSessionUser: async () => null })();
  const forbidden = await statusGet.withDependencies({ getSessionUser: async () => MEMBER })();

  assert.equal(unauthorized.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
  assert.equal(forbidden.headers.get("cache-control"), "no-store");
});

test("관리자 가격 상태 API는 자동 복구 DTO만 반환한다", async () => {
  const dto = {
    models: 2476,
    lastDay: "2026-07-14",
    repair: {
      state: "running",
      recoveredEvents: 120,
      reconciledEvents: 12533,
      remainingUnpricedEvents: 8,
      lastSucceededAt: "2026-07-14T00:10:00.000Z",
    },
    history: {
      state: "fetching",
      rangeFrom: "2026-07-07T00:00:00.000Z",
      rangeTo: "2026-07-08T00:00:00.000Z",
      models: 1,
      processedSnapshots: 2,
      totalSnapshots: 5,
      nextAttemptAt: null,
      lastError: null,
    },
    unresolvedModels: [{
      model: "unknown-model",
      events: 8,
      firstAt: "2026-07-13T00:00:00.000Z",
      lastAt: "2026-07-14T00:00:00.000Z",
    }],
  };
  const response = await statusGet.withDependencies({
    getSessionUser: async () => ADMIN,
    getPricingAdminStatus: async () => dto as never,
  })();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), dto);
});

test("가격 상태 내부 오류는 상세를 노출하지 않는다", async () => {
  const response = await statusGet.withDependencies({
    getSessionUser: async () => ADMIN,
    getPricingAdminStatus: async () => {
      throw new Error("password=hunter2 SELECT pricing_revisions stack internal.ts:10");
    },
  })();
  const text = await response.text();

  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(text), { error: "internal error" });
  assert.doesNotMatch(text, /hunter2|SELECT|stack|internal\.ts/);
});

test("관리자 가격 화면은 수동 action과 DB 토글 없이 읽기 전용 자동 상태만 표시한다", () => {
  const root = new URL("../", import.meta.url);
  const panel = readFileSync(new URL("app/(dashboard)/admin/pricing-panel.tsx", root), "utf8");
  const autoSync = readFileSync(new URL("lib/pricing-auto-sync.ts", root), "utf8");
  const notice = readFileSync(new URL("components/dashboard/pricing-notice.tsx", root), "utf8");
  const ko = JSON.parse(readFileSync(new URL("messages/ko/dashboard.json", root), "utf8"));
  const en = JSON.parse(readFileSync(new URL("messages/en/dashboard.json", root), "utf8"));
  const koAdmin = JSON.parse(readFileSync(new URL("messages/ko/admin.json", root), "utf8"));
  const enAdmin = JSON.parse(readFileSync(new URL("messages/en/admin.json", root), "utf8"));

  assert.equal(existsSync(new URL("app/(dashboard)/admin/pricing-actions.ts", root)), false);
  assert.doesNotMatch(panel, /syncPricingAction|setPricingAutoSyncAction|useActionState|<Switch|syncNow/);
  assert.match(panel, /setInterval[\s\S]*30_000/);
  assert.doesNotMatch(autoSync, /getAppSetting|setAppSetting|isAutoSyncEnabled/);
  assert.doesNotMatch(notice, /getSessionUser|href="\/admin|<Link/);
  assert.match(ko.pricingNotice.unpricedAction, /자동|별도 조작 없이/);
  assert.match(en.pricingNotice.unpricedAction, /automatic|without.*action/i);
  assert.match(panel, /status\.history\.state/);
  assert.equal(
    koAdmin.system.unresolvedModels,
    "해당 사용 날짜의 가격 이력이 확인되지 않은 모델",
  );
  assert.equal(
    enAdmin.system.unresolvedModels,
    "Models without confirmed pricing history for the usage date",
  );
});
