import { assertCostReportScope, localDateKey, type CostReportScope, type FinalizedUsageEvent, type UsageCostCoverage } from "@toard/core";
import { CostPeriodAccumulator, decomposeCostChange, type CostPeriod } from "./cost-drivers";
import { explainStoredCost, getCostEvidenceRevisionIds, type CostEvidenceRevision } from "./cost-evidence";
import { getStorage } from "./storage";
import { readUtilizationCacheGeneration, type UtilizationCacheGenerationState } from "./utilization-cache-generation";
import type { ReportPeriod } from "./report-period";

export const WEEKLY_REPORT_VERSION = "weekly-report-v1";

export type ReportModelRow = {
  provider: string; model: string | null;
  current: ReportTotals; previous: ReportTotals;
  pricingRevisionIds: string[]; calculationVersions: string[];
};
export type ReportTotals = { events: number; tokens: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; coverage: UsageCostCoverage };
export type WeeklyReport = {
  version: "weekly-report-v1";
  scope: { kind: CostReportScope["kind"]; teamId?: string };
  period: Omit<ReportPeriod, "current" | "previous"> & { current: { from: string; to: string }; previous: { from: string; to: string } };
  generatedAt: string;
  updatesDuringBuild: boolean;
  current: Omit<CostPeriod, "profiles" | "incompleteModels">;
  previous: Omit<CostPeriod, "profiles" | "incompleteModels">;
  change: ReturnType<typeof decomposeCostChange>;
  models: ReportModelRow[];
  days: Array<{ date: string; totals: ReportTotals }>;
  evidence: Array<{ id: string; model: string; source: string; sourceRef: string | null; effectiveAt: string }>;
};

type Dependencies = {
  revisionIds(scope: CostReportScope, query: { from: Date; to: Date }): Promise<string[]>;
  readRevisions(ids: string[]): Promise<Map<string, CostEvidenceRevision>>;
  consume(scope: CostReportScope, query: { from: Date; to: Date }, consume: (events: FinalizedUsageEvent[]) => void | Promise<void>): Promise<void>;
  generation(userId: string | null): Promise<UtilizationCacheGenerationState>;
  now(): Date;
};

function emptyTotals(): ReportTotals {
  return { events: 0, tokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    coverage: { pricedEvents: 0, estimatedEvents: 0, unpricedEvents: 0, legacyEvents: 0 } };
}
function add(totals: ReportTotals, row: FinalizedUsageEvent) {
  totals.events++; totals.costUsd += row.costUsd;
  totals.inputTokens += row.inputTokens; totals.outputTokens += row.outputTokens;
  totals.cacheReadTokens += row.cacheReadTokens; totals.cacheCreationTokens += row.cacheCreationTokens;
  totals.tokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;
  const key = { priced: "pricedEvents", estimated: "estimatedEvents", unpriced: "unpricedEvents", legacy: "legacyEvents" } as const;
  const field = key[row.costStatus]; totals.coverage[field] = (totals.coverage[field] ?? 0) + 1;
}

export function reportGenerationKey(scope: CostReportScope, state: UtilizationCacheGenerationState): string | null {
  if (scope.kind === "user") {
    return state.personalUserPending || state.personalAllPending ? null : `${state.personalUserGeneration}:${state.personalAllGeneration}`;
  }
  return state.organizationPending ? null : String(state.organizationGeneration);
}

/** Consume a complete database statement snapshot, never a top-N sample.
 * Price evidence is loaded before holding the event cursor so a one-connection
 * pool cannot deadlock. A newly introduced revision becomes missing evidence,
 * never an invented rate. Generations signal concurrent activity for caching. */
export async function buildWeeklyReport(scope: CostReportScope, period: ReportPeriod, overrides: Partial<Dependencies> = {}): Promise<WeeklyReport> {
  assertCostReportScope(scope);
  const deps: Dependencies = {
    revisionIds: (scope, query) => getStorage().getReportPricingRevisionIds(scope, query),
    consume: (scope, query, consume) => getStorage().consumeReportCostEvidence(scope, query, consume),
    readRevisions: getCostEvidenceRevisionIds,
    generation: readUtilizationCacheGeneration,
    now: () => new Date(), ...overrides,
  };
  {
    const userId = scope.kind === "user" ? scope.userId : null;
    const beforeGeneration = reportGenerationKey(scope, await deps.generation(userId));
    const current = new CostPeriodAccumulator(), previous = new CostPeriodAccumulator();
    const models = new Map<string, ReportModelRow>();
    const days = new Map<string, ReportTotals>();
    const range = { from: period.previous.from, to: period.current.to };
    const revisions = await deps.readRevisions(await deps.revisionIds(scope, range));
    const usedRevisions = new Set<string>();
    await deps.consume(scope, range, (events) => {
      for (const event of events) {
        if (event.ts < period.previous.from || event.ts >= period.current.to || (scope.kind === "user" && event.userId !== scope.userId)) throw new Error("report_evidence_outside_scope");
        if (event.pricingRevisionId) usedRevisions.add(event.pricingRevisionId);
        const side = event.ts < period.current.from ? "previous" : "current";
        const explanation = explainStoredCost(event, event.pricingRevisionId ? revisions.get(event.pricingRevisionId) : undefined);
        (side === "current" ? current : previous).add(event, explanation?.breakdown ?? null);
        const key = JSON.stringify([event.providerKey, event.model]);
        let model = models.get(key);
        if (!model) {
          model = { provider: event.providerKey, model: event.model, current: emptyTotals(), previous: emptyTotals(), pricingRevisionIds: [], calculationVersions: [] };
          models.set(key, model);
        }
        add(model[side], event);
        const version = event.costCalculationVersion ?? "cost-v1";
        if (!model.calculationVersions.includes(version)) model.calculationVersions.push(version);
        if (event.pricingRevisionId && !model.pricingRevisionIds.includes(event.pricingRevisionId)) model.pricingRevisionIds.push(event.pricingRevisionId);
        if (side === "current") {
          const date = localDateKey(event.ts, period.timezone);
          const day = days.get(date) ?? emptyTotals(); add(day, event); days.set(date, day);
        }
      }
    });
    const afterGeneration = reportGenerationKey(scope, await deps.generation(userId));
    const currentPeriod = current.snapshot(), previousPeriod = previous.snapshot();
    const { profiles: _currentProfiles, incompleteModels: _currentIncomplete, ...currentTotals } = currentPeriod;
    const { profiles: _previousProfiles, incompleteModels: _previousIncomplete, ...previousTotals } = previousPeriod;
    return {
      version: WEEKLY_REPORT_VERSION, scope: scope.kind === "team" ? { kind: scope.kind, teamId: scope.teamId } : { kind: scope.kind }, period: { ...period,
        current: { from: period.current.from.toISOString(), to: period.current.to.toISOString() },
        previous: { from: period.previous.from.toISOString(), to: period.previous.to.toISOString() } },
      updatesDuringBuild: beforeGeneration === null || beforeGeneration !== afterGeneration, generatedAt: deps.now().toISOString(), current: currentTotals, previous: previousTotals,
      change: decomposeCostChange(previousPeriod, currentPeriod),
      models: [...models.values()].sort((a, b) => b.current.costUsd - a.current.costUsd || a.provider.localeCompare(b.provider) || (a.model ?? "").localeCompare(b.model ?? "")),
      days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ date, totals })),
      evidence: [...revisions.values()].filter(revision => usedRevisions.has(revision.id)).map(revision => ({ id: revision.id, model: revision.sourceModelId ?? revision.modelId, source: revision.source, sourceRef: revision.sourceRef, effectiveAt: revision.effectiveAt.toISOString() })),
    };
  }
}
