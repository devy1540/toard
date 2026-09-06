import type { CostReportScope } from "@toard/core";
import type { SessionUser } from "./session-user";

export class ReportAccessError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404, code: string) { super(code); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveReportScope(viewer: SessionUser | null, requested: string | undefined): CostReportScope {
  if (!viewer) throw new ReportAccessError(401, "report_login_required");
  if (!requested || requested === "personal") return { kind: "user", userId: viewer.id };
  if (requested === "organization") {
    if (viewer.role !== "admin") throw new ReportAccessError(403, "report_scope_denied");
    return { kind: "organization" };
  }
  const teamId = requested.startsWith("team:") ? requested.slice(5) : "";
  if (!UUID.test(teamId)) throw new ReportAccessError(400, "invalid_report_scope");
  if (viewer.role !== "admin" && (viewer.teamRole !== "leader" || viewer.teamId !== teamId)) throw new ReportAccessError(403, "report_scope_denied");
  return { kind: "team", teamId };
}
