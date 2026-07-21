import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { changeTeamRole, type TeamRoleDependencies } from "./team-tool-role";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("상세 화면은 개인 설치를 기본 CTA로 두고 leader에게만 팀 기본 배포를 보인다", () => {
  const page = source("app/(dashboard)/library/[slug]/page.tsx");
  assert.match(page, /ToolInstallPanel/);
  assert.match(page, /viewer\.teamRole === "leader"/);
  assert.match(page, /TeamDeploymentPanel/);
});

test("설치 panel은 모든 기기 기본값, 고급 기기 선택, 제외와 상태별 다음 행동을 제공한다", () => {
  const panel = source("app/(dashboard)/library/[slug]/tool-install-panel.tsx");
  for (const text of ["installAllDevices", "advancedDeviceSelection", "excludeTeamDefault", "settingsRequiredCommand", "nextShimRun"]) {
    assert.match(panel, new RegExp(text));
  }
});

test("team role 변경은 admin만 수행하고 team 없는 leader를 거부한다", async () => {
  const updates: unknown[] = [];
  const deps: TeamRoleDependencies = {
    async getTarget(userId) {
      return { userId, teamId: userId === "teamless" ? null : "team-1", teamRole: "member" };
    },
    async save(value) { updates.push(value); },
  };
  const member = { id: "u1", role: "member" };
  const admin = { id: "admin", role: "admin" };
  assert.deepEqual(await changeTeamRole(member, { userId: "u2", teamRole: "leader" }, deps), { ok: false, reason: "forbidden" });
  assert.deepEqual(await changeTeamRole(admin, { userId: "teamless", teamRole: "leader" }, deps), { ok: false, reason: "team-required" });
  assert.deepEqual(await changeTeamRole(admin, { userId: "u2", teamRole: "leader" }, deps), { ok: true });
  assert.equal(updates.length, 1);
});
