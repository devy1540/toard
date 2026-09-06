import { COST_DRIVERS } from "./cost-drivers";
import type { ReportHealth } from "./report-health";
import type { WeeklyReport } from "./weekly-report";

/** Text remains text when opened by a spreadsheet; numeric negative deltas are
 * deliberately numbers. Quotes/newlines are escaped according to CSV rules. */
export function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_csv_value");
    return String(value);
  }
  const text = /^[\s\x00-\x1f\uFEFF]|^[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
}

/** A single rectangular workbook-ready table: model comparisons, cost drivers,
 * provenance and current collector condition. No user/session/host identities. */
export function weeklyReportCsv(report: WeeklyReport, health: ReportHealth): string {
  const rows: Array<Array<string | number | null>> = [["section", "provider", "model_or_label", "metric", "previous", "current", "change", "unit", "evidence"]];
  rows.push(["report", "", "week", "period", report.period.previousWeek, report.period.week, null, report.period.timezone, report.version],
    ["report", "", report.scope.kind, "scope", null, report.scope.teamId ?? report.scope.kind, null, "scope", "authorized_at_request"],
    ["report", "", "generated_at", "time", null, report.generatedAt, null, "UTC", report.change.version],
    ["total", "", "all", "recorded_cost", report.previous.costUsd, report.current.costUsd, report.change.deltaUsd, "USD_API_EQUIVALENT", "stored_records"],
    ["total", "", "all", "tokens", report.previous.tokens, report.current.tokens, report.current.tokens - report.previous.tokens, "tokens", "stored_records"],
    ["total", "", "all", "events", report.previous.events, report.current.events, report.current.events - report.previous.events, "events", "stored_records"],
    ["coverage", "", "all", "unpriced_events", report.previous.coverage.unpricedEvents, report.current.coverage.unpricedEvents, null, "events", "not_a_zero_cost_claim"],
    ["coverage", "", "all", "estimated_events", report.previous.coverage.estimatedEvents ?? 0, report.current.coverage.estimatedEvents ?? 0, null, "events", "inferred_model_or_billing_context"]);
  rows.push(["coverage", "", "all", "legacy_evidence_events", report.previous.legacyEvidenceEvents, report.current.legacyEvidenceEvents, null, "events", "legacy_value_or_calculation_version"]);
  for (const model of report.models) {
    for (const [metric, unit] of [["costUsd", "USD_API_EQUIVALENT"], ["tokens", "tokens"], ["events", "events"], ["inputTokens", "tokens"], ["outputTokens", "tokens"], ["cacheReadTokens", "tokens"], ["cacheCreationTokens", "tokens"]] as const) {
      const unpriced = model.current.coverage.unpricedEvents + model.previous.coverage.unpricedEvents > 0;
      const costValue = (side: typeof model.current) => !side.events || side.coverage.unpricedEvents === side.events ? null : side.costUsd;
      rows.push(["model", model.provider, model.model, metric,
        metric === "costUsd" ? costValue(model.previous) : model.previous[metric],
        metric === "costUsd" ? costValue(model.current) : model.current[metric],
        metric === "costUsd" && unpriced ? null : model.current[metric] - model.previous[metric], unit,
        [`unpriced_previous=${model.previous.coverage.unpricedEvents}`, `unpriced_current=${model.current.coverage.unpricedEvents}`,
          `estimated_previous=${model.previous.coverage.estimatedEvents ?? 0}`, `estimated_current=${model.current.coverage.estimatedEvents ?? 0}`,
          ...model.calculationVersions, ...model.pricingRevisionIds].join(";")]);
    }
  }
  for (const key of COST_DRIVERS) rows.push(["cost_driver", "", key, "contribution", null, null, report.change.driversUsd[key], "USD_API_EQUIVALENT", "complete_evidence_model_groups"]);
  rows.push(["cost_driver", "", "unclassified", "contribution", null, null, report.change.unexplainedUsd, "USD_API_EQUIVALENT", "missing_evidence_and_rounding"],
    ["coverage", "", "all", "excluded_from_decomposition", null, report.change.excludedEvents, null, "events", "whole_model_group_if_either_period_has_missing_evidence"]);
  for (const day of report.days) rows.push(["daily", "", day.date, "recorded_cost", null, day.totals.costUsd, null, "USD_API_EQUIVALENT", `unpriced=${day.totals.coverage.unpricedEvents};estimated=${day.totals.coverage.estimatedEvents ?? 0}`]);
  for (const evidence of report.evidence) rows.push(["pricing_source", "", evidence.model, evidence.id, evidence.effectiveAt, evidence.sourceRef ?? evidence.source, null, "revision", evidence.source]);
  for (const metric of ["connections", "unconfirmed", "noReport", "errors", "paused", "stale", "pendingEvents", "outboxPending"] as const) {
    rows.push(["current_collection", "", "all", metric, null, health[metric], null, "count", health.checkedAt]);
  }
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
