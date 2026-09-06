import { getDashboardViewer } from "@/lib/session-user";
import { getViewerTimezone } from "@/lib/viewer-time";
import { reportContext } from "@/lib/report-context";
import { ReportAccessError } from "@/lib/report-access";
import { getWeeklyReport } from "@/lib/weekly-report-cache";
import { getReportHealth } from "@/lib/report-health";
import { weeklyReportCsv } from "@/lib/report-csv";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const context = await reportContext(await getDashboardViewer(), { scope: params.get("scope") ?? undefined, week: params.get("week") ?? undefined }, await getViewerTimezone());
    const [report, health] = await Promise.all([
      getWeeklyReport(context.scope, context.period),
      getReportHealth(context.scope, { from: context.period.previous.from, to: context.period.current.to }),
    ]);
    return new Response(weeklyReportCsv(report, health), { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="toard-${context.scope.kind}-${context.period.week}.csv"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    const status = error instanceof ReportAccessError ? error.status : 503;
    const code = error instanceof ReportAccessError ? error.message : "report_unavailable";
    return Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
