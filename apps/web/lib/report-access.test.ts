import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "./session-user";
import { ReportAccessError, resolveReportScope } from "./report-access";
const team = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
const user: SessionUser = { id: "owner", email: "fixture@example.test", role: "member", teamRole: "member", teamId: team, teamName: "Fixture", teamOnboardingCompletedAt: null };
test("personal reports bind the authenticated identity and reject wider member access", () => {
  assert.deepEqual(resolveReportScope(user, undefined), { kind: "user", userId: "owner" });
  for (const requested of ["organization", `team:${team}`, `team:${other}`]) assert.throws(() => resolveReportScope(user, requested), (error) => error instanceof ReportAccessError && error.status === 403);
  assert.throws(() => resolveReportScope(null, "personal"), (error) => error instanceof ReportAccessError && error.status === 401);
});
test("leaders get their own team and admins can select an organization or team", () => {
  const leader = { ...user, teamRole: "leader" as const };
  assert.deepEqual(resolveReportScope(leader, `team:${team}`), { kind: "team", teamId: team });
  assert.throws(() => resolveReportScope(leader, `team:${other}`), /report_scope_denied/);
  assert.deepEqual(resolveReportScope({ ...user, role: "admin" }, "organization"), { kind: "organization" });
  assert.deepEqual(resolveReportScope({ ...user, role: "admin" }, `team:${other}`), { kind: "team", teamId: other });
  assert.throws(() => resolveReportScope(user, "user:someone-else"), /invalid_report_scope/);
});
