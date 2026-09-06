import { addLocalCalendarDays } from "@toard/core";
import { getPool } from "./db";
import { resolveReportScope, ReportAccessError } from "./report-access";
import { reportPeriod } from "./report-period";
import type { SessionUser } from "./session-user";
import { getOrgTimezone } from "./org-time";

export async function reportContext(viewer: SessionUser | null, query: { scope?: string; week?: string }, viewerTimezone: string) {
  const scope = resolveReportScope(viewer, query.scope);
  let teamName: string | null = null;
  if (scope.kind === "team") {
    const team = await getPool().query<{ name: string }>("SELECT name FROM teams WHERE id=$1", [scope.teamId]);
    if (!team.rows.length) throw new ReportAccessError(404, "report_team_not_found");
    teamName = team.rows[0]!.name;
  }
  const timezone = scope.kind === "user" ? viewerTimezone : getOrgTimezone();
  try {
    return { scope, teamName, period: reportPeriod(query.week, timezone), scopeValue: query.scope ?? "personal" };
  } catch { throw new ReportAccessError(400, "invalid_report_period"); }
}

export async function reportScopeOptions(viewer: SessionUser) {
  const teams = viewer.role === "admin"
    ? (await getPool().query<{ id: string; name: string }>("SELECT id,name FROM teams ORDER BY name,id")).rows
    : viewer.teamRole === "leader" && viewer.teamId ? [{ id: viewer.teamId, name: viewer.teamName ?? "" }] : [];
  return teams.map(team => ({ value: `team:${team.id}`, name: team.name }));
}

export function reportWeekOptions(timezone: string) {
  const latest = reportPeriod(undefined, timezone).latestWeek;
  const weeks: string[] = [];
  for (let offset = 0; offset < 14; offset++) {
    const week = addLocalCalendarDays(latest, -offset * 7);
    try { reportPeriod(week, timezone); weeks.push(week); } catch { break; }
  }
  return weeks;
}
