import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Surface } from "@/components/ui/surface";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDashboardViewer } from "@/lib/session-user";
import { getViewerTimezone } from "@/lib/viewer-time";
import { reportContext, reportScopeOptions, reportWeekOptions } from "@/lib/report-context";
import { ReportAccessError } from "@/lib/report-access";
import { getWeeklyReport } from "@/lib/weekly-report-cache";
import { getReportHealth } from "@/lib/report-health";
import { displayCostDrivers } from "@/lib/cost-drivers";
import type { ReportTotals } from "@/lib/weekly-report";

export const dynamic = "force-dynamic";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ scope?: string; week?: string }> }) {
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");
  const [t, locale, timezone, query, teams] = await Promise.all([getTranslations("reports"), getLocale(), getViewerTimezone(), searchParams, reportScopeOptions(viewer)]);
  let context;
  try { context = await reportContext(viewer, query, timezone); }
  catch (error) {
    return <Surface padding="lg" role="alert"><p>{t(error instanceof ReportAccessError && error.status === 403 ? "errors.denied" : "errors.period")}</p><Button asChild variant="outline" className="mt-3"><Link href="/reports">{t("reset")}</Link></Button></Surface>;
  }
  const [report, health] = await Promise.all([
    getWeeklyReport(context.scope, context.period),
    getReportHealth(context.scope, { from: context.period.previous.from, to: context.period.current.to }),
  ]).catch(() => [null, null] as const);
  const options = reportWeekOptions(context.period.timezone);
  const exportParams = new URLSearchParams({ scope: context.scopeValue, week: context.period.week });
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
  const when = (value: string) => new Intl.DateTimeFormat(locale, { timeZone: context.period.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const change = report ? displayCostDrivers(report.change) : null;
  const unpriced = Boolean(report && (report.current.coverage.unpricedEvents + report.previous.coverage.unpricedEvents > 0));
  const partial = unpriced || (health?.outboxPending ?? 0) > 0;
  const modelAmount = (totals: ReportTotals) => {
    if (!totals.events) return "—";
    if (totals.coverage.unpricedEvents === totals.events) return t("unpricedAmount");
    return money(totals.costUsd) + (totals.coverage.unpricedEvents ? ` · ${t("partial")}` : "");
  };
  return (
    <div className="space-y-5" data-weekly-report={context.scope.kind}>
      <header className="space-y-2"><h1 className="text-2xl font-semibold">{t("title")}</h1><p className="text-muted-foreground text-sm">{t("description")}</p></header>
      <form className="flex flex-wrap items-end gap-3" action="/reports">
        <Field className="w-full sm:w-64"><FieldLabel htmlFor="report-scope">{t("scope.label")}</FieldLabel>
          <NativeSelect id="report-scope" name="scope" defaultValue={context.scopeValue}>
            <NativeSelectOption value="personal">{t("scope.personal")}</NativeSelectOption>
            {viewer.role === "admin" ? <NativeSelectOption value="organization">{t("scope.organization")}</NativeSelectOption> : null}
            {teams.map(team => <NativeSelectOption key={team.value} value={team.value}>{t("scope.team", { name: team.name })}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field className="w-full sm:w-64"><FieldLabel htmlFor="report-week">{t("week")}</FieldLabel>
          <NativeSelect id="report-week" name="week" defaultValue={context.period.week}>{options.map(week => <NativeSelectOption key={week} value={week}>{week}</NativeSelectOption>)}</NativeSelect>
        </Field>
        <Button type="submit">{t("show")}</Button>
        {report ? <Button asChild variant="outline"><a href={`/api/reports/weekly?${exportParams}`}>{t("download")}</a></Button> : null}
      </form>
      <p className="text-muted-foreground text-xs">{t("range", { from: context.period.week, to: context.period.lastDate, previous: context.period.previousWeek, timezone: context.period.timezone })}</p>
      {!report || !health || !change ? <Surface padding="lg" role="alert">{t("errors.unavailable")}</Surface> : <>
        <p className="text-muted-foreground text-xs">{t("generated", { time: when(report.generatedAt) })}</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Metric title={t("amount")} value={`${money(report.current.costUsd)}${partial ? ` · ${t("partial")}` : ""}`} detail={t("previous", { value: money(report.previous.costUsd) })} />
          <Metric title={t("change")} value={`${money(change.delta)}${partial ? ` · ${t("partial")}` : ""}`} detail={t("observedOnly")} />
          <Metric title={t("tokens")} value={number(report.current.tokens)} detail={t("previous", { value: number(report.previous.tokens) })} />
        </div>
        <Surface variant="muted" padding="md" className="space-y-2 text-sm">
          <p>{t("basis")}</p>
          <p>{t("coverage", { unpriced: number(report.current.coverage.unpricedEvents), estimated: number(report.current.coverage.estimatedEvents ?? 0), legacy: number(report.current.legacyEvidenceEvents), excluded: number(report.change.excludedEvents) })}</p>
          {unpriced ? <p className="font-medium">{t("unpricedNotice")}</p> : null}
          {health.outboxPending > 0 ? <p className="font-medium">{t("outboxNotice", { count: number(health.outboxPending) })}</p> : null}
          {report.updatesDuringBuild ? <p>{t("updating")}</p> : null}
          {report.previous.events === 0 && report.current.events > 0 ? <p>{t("noBaseline")}</p> : null}
        </Surface>
        {report.current.events + report.previous.events === 0 ? <p>{t("empty")}</p> : null}
        <Card><CardHeader><CardTitle>{t("drivers.title")}</CardTitle><CardDescription>{t("drivers.description")}</CardDescription></CardHeader><CardContent>
          <Table><TableHeader><TableRow><TableHead>{t("drivers.factor")}</TableHead><TableHead className="text-right">{t("drivers.contribution")}</TableHead></TableRow></TableHeader><TableBody>
            {change.drivers.map(row => <TableRow key={row.key}><TableCell>{t(`drivers.${row.key}`)}</TableCell><TableCell className="text-right tabular-nums" data-cost-driver={row.key}>{money(row.usd)}</TableCell></TableRow>)}
            <TableRow><TableCell>{t("drivers.unclassified")}</TableCell><TableCell className="text-right tabular-nums" data-cost-driver="unclassified">{money(change.residual)}</TableCell></TableRow>
            <TableRow className="font-medium"><TableCell>{t("drivers.total")}</TableCell><TableCell className="text-right tabular-nums">{money(change.delta)}</TableCell></TableRow>
          </TableBody></Table>
          <p className="text-muted-foreground mt-3 text-xs">{t("drivers.evidence", { previous: money(report.change.analyzedPreviousUsd), current: money(report.change.analyzedCurrentUsd) })}</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t("models.title")}</CardTitle></CardHeader><CardContent>
          <Table><TableHeader><TableRow><TableHead>{t("models.model")}</TableHead><TableHead>{t("models.provider")}</TableHead><TableHead className="text-right">{t("models.previous")}</TableHead><TableHead className="text-right">{t("models.current")}</TableHead><TableHead className="text-right">{t("models.delta")}</TableHead><TableHead className="text-right">{t("models.coverage")}</TableHead></TableRow></TableHeader><TableBody>
            {report.models.map(row => <TableRow key={JSON.stringify([row.provider, row.model])}><TableCell className="max-w-72 break-words">{row.model ?? t("unknownModel")}</TableCell><TableCell>{row.provider}</TableCell><TableCell className="text-right tabular-nums">{modelAmount(row.previous)}</TableCell><TableCell className="text-right tabular-nums">{modelAmount(row.current)}</TableCell><TableCell className="text-right tabular-nums">{row.current.coverage.unpricedEvents || row.previous.coverage.unpricedEvents ? "—" : money(row.current.costUsd - row.previous.costUsd)}</TableCell><TableCell className="text-right">{number(row.current.coverage.unpricedEvents)} / {number(row.current.coverage.estimatedEvents ?? 0)}</TableCell></TableRow>)}
          </TableBody></Table>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t("health.title")}</CardTitle><CardDescription>{t("health.description", { time: when(health.checkedAt) })}</CardDescription></CardHeader><CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {(["connections", "unconfirmed", "noReport", "errors", "paused", "stale", "pendingEvents", "outboxPending"] as const).map(key => <p key={key}>{t(`health.${key}`)}: <strong>{health[key] == null ? "—" : number(health[key])}</strong></p>)}
          <p className="text-muted-foreground sm:col-span-2 lg:col-span-4">{t("health.caution")}</p>
        </CardContent></Card>
        <Surface asChild padding="md"><Disclosure trigger={t("methodology.title")}>
          <div className="space-y-3 pt-3 text-sm"><p>{t("methodology.average")}</p><p>{t("methodology.missing")}</p><p>{t("methodology.rates")}</p><p>{t("methodology.scope")}</p><p className="text-muted-foreground text-xs">{report.version} · {report.change.version}</p>
            {context.scope.kind === "user" ? <Link href={`/costs?period=custom&from=${context.period.previousWeek}&to=${context.period.lastDate}`} className="underline">{t("methodology.ledger")}</Link> : null}
            {report.evidence.map(item => <p key={item.id} className="break-all text-xs"><strong>{item.model}</strong> · {item.source}<br />{item.id} · {item.effectiveAt}</p>)}
          </div>
        </Disclosure></Surface>
      </>}
    </div>
  );
}

function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <Card><CardHeader><CardDescription>{title}</CardDescription><CardTitle className="text-2xl tabular-nums">{value}</CardTitle></CardHeader><CardContent className="text-muted-foreground text-xs">{detail}</CardContent></Card>;
}
