import type { StorageBackend } from "@toard/core";
import { resolveCostAt, type PricingSchedule } from "@toard/pricing";
import { revalidateTag } from "next/cache";
import type { Pool } from "pg";
import { getPool } from "./db";
import { getPricingSchedule } from "./pricing";
import {
  runHistoricalPricingStep,
  type HistoricalPricingDiagnostic,
  type HistoricalPricingStepResult,
} from "./pricing-history";
import { dayStartUtc, getOrgTimezone } from "./org-time";
import type { RollupCoordinatorCandidate } from "./rollup-coordinator";
import type { RollupSchedulerOutcome } from "./rollup-coordinator-state";
import { sanitizeRollupError } from "./rollup-worker-state";
import { getStorage } from "./storage";

const STALE_RUNNING_MS = 5 * 60 * 1_000;
const WAITING_RETRY_MS = 60 * 60 * 1_000;
const PRICING_ROLLUP_RECONCILIATION_LIMIT = 10_000;

export type PricingRepairState = "idle" | "pending" | "running" | "waiting_for_catalog" | "failed";

export type PricingUnresolvedModel = {
  model: string | null;
  events: number;
  unpricedEvents: number;
  legacyEvents: number;
  firstAt: string;
  lastAt: string;
};

export type PricingRepairStatusRecord = {
  generation: string | null;
  state: PricingRepairState;
  targetTo: Date | null;
  processedEvents: number;
  recoveredEvents: number;
  reconciledEvents: number;
  repricedLegacyEvents: number;
  remainingUnpricedEvents: number;
  remainingLegacyEvents: number;
  unresolvedModels: PricingUnresolvedModel[];
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lastError: string | null;
  adaptiveLimit: number;
  loadState: "normal" | "throttled";
  eligibleSince: Date | null;
  nextAttemptAt: Date | null;
  consecutiveFailures: number;
  updatedAt: Date;
};

type PricingRepairStatusRow = {
  generation: string | null;
  state: PricingRepairState;
  target_to: Date | null;
  processed_events: string | number;
  recovered_events: string | number;
  reconciled_events: string | number;
  repriced_legacy_events: string | number;
  remaining_unpriced_events: string | number;
  remaining_legacy_events: string | number;
  unresolved_models: PricingUnresolvedModel[] | null;
  last_started_at: Date | null;
  last_succeeded_at: Date | null;
  last_error: string | null;
  adaptive_limit: string | number;
  load_state: "normal" | "throttled";
  eligible_since: Date | null;
  next_attempt_at: Date | null;
  consecutive_failures: string | number;
  updated_at: Date;
};

// pg의 기본 TIMESTAMPTZ parser는 마이크로초를 Date의 밀리초로 잘라 generation exact match를 깨뜨린다.
const SELECT_FIELDS = `
  generation::text AS generation, state, target_to, processed_events, recovered_events, reconciled_events,
  repriced_legacy_events, remaining_unpriced_events, remaining_legacy_events,
  unresolved_models, last_started_at, last_succeeded_at, last_error,
  adaptive_limit, load_state, eligible_since, next_attempt_at,
  consecutive_failures, updated_at`;

function mapStatus(row: PricingRepairStatusRow): PricingRepairStatusRecord {
  return {
    generation: row.generation,
    state: row.state,
    targetTo: row.target_to,
    processedEvents: Number(row.processed_events),
    recoveredEvents: Number(row.recovered_events),
    reconciledEvents: Number(row.reconciled_events),
    repricedLegacyEvents: Number(row.repriced_legacy_events),
    remainingUnpricedEvents: Number(row.remaining_unpriced_events),
    remainingLegacyEvents: Number(row.remaining_legacy_events),
    unresolvedModels: row.unresolved_models ?? [],
    lastStartedAt: row.last_started_at,
    lastSucceededAt: row.last_succeeded_at,
    lastError: row.last_error,
    adaptiveLimit: Number(row.adaptive_limit),
    loadState: row.load_state,
    eligibleSince: row.eligible_since,
    nextAttemptAt: row.next_attempt_at,
    consecutiveFailures: Number(row.consecutive_failures),
    updatedAt: row.updated_at,
  };
}

function requireStatus(row: PricingRepairStatusRow | undefined): PricingRepairStatusRecord {
  if (!row) throw new Error("Pricing repair status not found");
  return mapStatus(row);
}

export type PricingRepairProgress = {
  generation: string;
  state: Exclude<PricingRepairState, "running" | "failed">;
  processed: number;
  recovered: number;
  reconciled: number;
  repricedLegacy: number;
  remaining: number;
  remainingLegacy: number;
  unresolvedModels: PricingUnresolvedModel[];
  adaptiveLimit: number;
  loadState: "normal" | "throttled";
  nextAttemptAt: Date | null;
  at: Date;
};

export interface PricingRepairRepository {
  get(): Promise<PricingRepairStatusRecord>;
  claim(at: Date): Promise<PricingRepairStatusRecord | null>;
  markProgress(input: PricingRepairProgress): Promise<boolean>;
  markFailed(generation: string, at: Date, error: string): Promise<boolean>;
}

export class PgPricingRepairRepository implements PricingRepairRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<PricingRepairStatusRecord> {
    const result = await this.pool.query<PricingRepairStatusRow>(
      `SELECT ${SELECT_FIELDS} FROM pricing_repair_status WHERE singleton`,
    );
    return requireStatus(result.rows[0]);
  }

  async claim(at: Date): Promise<PricingRepairStatusRecord | null> {
    const result = await this.pool.query<PricingRepairStatusRow>(
      `UPDATE pricing_repair_status
       SET state = 'running',
           target_to = GREATEST(target_to, queued_target_to),
           queued_target_to = NULL,
           last_started_at = $1,
           eligible_since = COALESCE(eligible_since, $1),
           updated_at = $1
       WHERE singleton
         AND generation IS NOT NULL
         AND target_to IS NOT NULL
         AND (
           state = 'pending'
           OR (
             state IN ('failed', 'waiting_for_catalog')
             AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
           )
           OR (
             state = 'running'
             AND last_started_at <= $1 - INTERVAL '5 minutes'
           )
         )
       RETURNING ${SELECT_FIELDS}`,
      [at],
    );
    return result.rows[0] ? mapStatus(result.rows[0]) : null;
  }

  async markProgress(input: PricingRepairProgress): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pricing_repair_status
       SET state = CASE WHEN queued_target_to IS NOT NULL THEN 'pending' ELSE $2 END,
           target_to = GREATEST(target_to, queued_target_to),
           processed_events = processed_events + $3,
           recovered_events = recovered_events + $4,
           reconciled_events = reconciled_events + $5,
           repriced_legacy_events = repriced_legacy_events + $6,
           remaining_unpriced_events = $7,
           remaining_legacy_events = $8,
           unresolved_models = $9::jsonb,
           last_succeeded_at = $10,
           last_error = NULL,
           adaptive_limit = $11,
           load_state = $12,
           eligible_since = CASE
             WHEN queued_target_to IS NOT NULL OR $2 = 'pending' THEN COALESCE(eligible_since, $10)
             ELSE NULL
           END,
           next_attempt_at = CASE WHEN queued_target_to IS NOT NULL THEN $10 ELSE $13 END,
           queued_target_to = NULL,
           consecutive_failures = 0,
           updated_at = $10
       WHERE singleton AND generation = $1::timestamptz
       RETURNING singleton`,
      [
        input.generation,
        input.state,
        input.processed,
        input.recovered,
        input.reconciled,
        input.repricedLegacy,
        input.remaining,
        input.remainingLegacy,
        JSON.stringify(input.unresolvedModels),
        input.at,
        input.adaptiveLimit,
        input.loadState,
        input.nextAttemptAt,
      ],
    );
    return result.rowCount === 1;
  }

  async markFailed(generation: string, at: Date, error: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pricing_repair_status
       SET state = 'failed',
           last_error = $3,
           consecutive_failures = consecutive_failures + 1,
           next_attempt_at = $2 + make_interval(
             secs => LEAST(300, 60 * power(2, consecutive_failures)::integer)
           ),
           updated_at = $2
       WHERE singleton AND generation = $1::timestamptz
       RETURNING singleton`,
      [generation, at, sanitizeRollupError(error)],
    );
    return result.rowCount === 1;
  }
}

export function pricingRepairCandidateFromStatus(
  status: PricingRepairStatusRecord,
  now: Date,
): RollupCoordinatorCandidate | null {
  const retryDue = status.nextAttemptAt == null || status.nextAttemptAt <= now;
  const stalled = status.state === "running"
    && status.lastStartedAt != null
    && now.getTime() - status.lastStartedAt.getTime() >= STALE_RUNNING_MS;
  const due = status.state === "pending"
    || ((status.state === "failed" || status.state === "waiting_for_catalog") && retryDue)
    || stalled;
  if (!due) return null;
  return {
    task: "pricing_repair",
    due: true,
    eligibleSince: status.eligibleSince ?? now,
    lastStartedAt: status.lastStartedAt,
    nextAttemptAt: status.nextAttemptAt,
  };
}

export async function pricingRepairCandidate(now: Date): Promise<RollupCoordinatorCandidate | null> {
  return pricingRepairCandidateFromStatus(
    await new PgPricingRepairRepository(getPool()).get(),
    now,
  );
}

type PricingRepairTaskDependencies = {
  repository: PricingRepairRepository;
  storage: StorageBackend;
  getSchedule(): Promise<PricingSchedule>;
  getNonAuthoritativeRevisionIds?(): Promise<string[]>;
  runHistoricalPricingStep?(
    diagnostics: HistoricalPricingDiagnostic[],
  ): Promise<HistoricalPricingStepResult>;
  invalidateInsightCache?(): void;
  now(): Date;
};

async function loadNonAuthoritativeRevisionIds(): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM pricing_revisions WHERE NOT authoritative ORDER BY id`,
  );
  return result.rows.map((row) => row.id);
}

function localDate(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

type SupportedPricingTargets = {
  models: string[];
  includeCodexModelFallback: boolean;
};

function supportedPricingTargets(
  diagnostics: Awaited<ReturnType<StorageBackend["getPricingRecoveryModels"]>>,
  schedule: PricingSchedule,
): SupportedPricingTargets {
  const models = new Set<string>();
  let includeCodexModelFallback = false;
  for (const diagnostic of diagnostics) {
    const probe = resolveCostAt({
      model: diagnostic.model,
      providerKey: diagnostic.providerKey,
      logAdapter: diagnostic.logAdapter,
      occurredAt: diagnostic.firstAt,
      schedule,
      mode: "calculate",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    if (probe.status !== "priced") continue;
    if (diagnostic.model) models.add(diagnostic.model);
    else if (diagnostic.providerKey === "codex" && diagnostic.logAdapter === "codex") {
      includeCodexModelFallback = true;
    }
  }
  return { models: [...models], includeCodexModelFallback };
}

export function nextPricingRepairBatchLimit(
  current: number,
  durationMs: number,
  fullBatch: boolean,
): { limit: number; loadState: "normal" | "throttled" } {
  if (durationMs >= 10_000) {
    return { limit: Math.max(25, Math.floor(current / 2)), loadState: "throttled" };
  }
  if (fullBatch && durationMs <= 2_000) {
    return {
      limit: Math.min(500, Math.max(25, Math.ceil(current * 1.25))),
      loadState: "normal",
    };
  }
  return { limit: Math.min(500, Math.max(25, current)), loadState: "normal" };
}

function unresolvedModels(
  diagnostics: Awaited<ReturnType<StorageBackend["getPricingRecoveryModels"]>>,
): PricingUnresolvedModel[] {
  return diagnostics.map((item) => ({
    model: item.model,
    events: item.events,
    unpricedEvents: item.unpricedEvents,
    legacyEvents: item.legacyEvents,
    firstAt: item.firstAt.toISOString(),
    lastAt: item.lastAt.toISOString(),
  }));
}

function completedHistoricalDiagnostics(
  diagnostics: Awaited<ReturnType<StorageBackend["getPricingRecoveryModels"]>>,
  todayStart: Date,
): HistoricalPricingDiagnostic[] {
  const historicalEnd = new Date(todayStart.getTime() - 1);
  return diagnostics.flatMap((item) => {
    if (item.firstAt >= todayStart) return [];
    return [{
      model: item.model,
      events: item.events,
      firstAt: item.firstAt.toISOString(),
      lastAt: (item.lastAt < todayStart ? item.lastAt : historicalEnd).toISOString(),
    }];
  });
}

export async function runPricingRepairTaskWith(
  dependencies: PricingRepairTaskDependencies,
): Promise<RollupSchedulerOutcome> {
  const startedAt = dependencies.now();
  const claimed = await dependencies.repository.claim(startedAt);
  if (!claimed?.generation || !claimed.targetTo) return "superseded";
  const from = new Date(0);
  try {
    const replay = await dependencies.storage.reconcileCodexReplayUsage({
      from,
      to: claimed.targetTo,
      limit: claimed.adaptiveLimit,
    });
    if (replay.scanned > 0) {
      const at = dependencies.now();
      const adaptive = nextPricingRepairBatchLimit(
        claimed.adaptiveLimit,
        at.getTime() - startedAt.getTime(),
        replay.hasMore || replay.scanned >= claimed.adaptiveLimit,
      );
      const applied = await dependencies.repository.markProgress({
        generation: claimed.generation,
        state: "pending",
        processed: replay.scanned,
        recovered: 0,
        reconciled: replay.reconciled,
        repricedLegacy: 0,
        remaining: replay.remainingUnpriced,
        remainingLegacy: claimed.remainingLegacyEvents,
        unresolvedModels: claimed.unresolvedModels,
        adaptiveLimit: adaptive.limit,
        loadState: adaptive.loadState,
        nextAttemptAt: at,
        at,
      });
      return applied ? "success" : "superseded";
    }

    const schedule = await dependencies.getSchedule();
    const replaceRevisionIds = await (dependencies.getNonAuthoritativeRevisionIds?.() ?? Promise.resolve([]));
    const diagnostics = await dependencies.storage.getPricingRecoveryModels(
      from,
      claimed.targetTo,
      replaceRevisionIds,
    );
    const targets = supportedPricingTargets(diagnostics, schedule);
    let result = {
      scanned: 0,
      recovered: 0,
      repricedLegacy: 0,
      affectedBuckets: [] as Date[],
      hasMore: false,
    };
    if (targets.models.length > 0 || targets.includeCodexModelFallback) {
      result = await dependencies.storage.repairPricingUsage({
        from,
        to: claimed.targetTo,
        models: targets.models,
        includeCodexModelFallback: targets.includeCodexModelFallback,
        replaceRevisionIds,
        limit: claimed.adaptiveLimit,
        generation: claimed.generation,
      }, (event) => {
        const resolved = resolveCostAt({
          ...event,
          occurredAt: event.ts,
          schedule,
          mode: "calculate",
        });
        return resolved.status === "priced" && resolved.pricingRevisionId
          ? { costUsd: resolved.costUsd, pricingRevisionId: resolved.pricingRevisionId }
          : null;
      });
    }
    const remaining = Math.max(
      0,
      diagnostics.reduce((sum, item) => sum + item.unpricedEvents, 0) - result.recovered,
    );
    const remainingLegacy = Math.max(
      0,
      diagnostics.reduce((sum, item) => sum + item.legacyEvents, 0) - result.repricedLegacy,
    );
    const remainingTotal = Math.max(
      0,
      diagnostics.reduce((sum, item) => sum + item.events, 0) - result.recovered - result.repricedLegacy,
    );
    const remainingSupported = result.hasMore || result.scanned > result.recovered + result.repricedLegacy;
    const resolvedModelSet = new Set(targets.models);
    const remainingDiagnostics = !result.hasMore &&
        result.scanned === result.recovered + result.repricedLegacy
      ? diagnostics.filter((item) => item.model
        ? !resolvedModelSet.has(item.model)
        : !(
          targets.includeCodexModelFallback
          && item.providerKey === "codex"
          && item.logAdapter === "codex"
        ))
      : diagnostics;
    const rollupReconciliation = !result.hasMore && !remainingSupported && remainingTotal === 0
      ? await dependencies.storage.reconcilePricingRollupUsage?.({
          from,
          to: claimed.targetTo,
          limit: PRICING_ROLLUP_RECONCILIATION_LIMIT,
        }) ?? { dirtied: 0, affectedBuckets: [], hasMore: false }
      : { dirtied: 0, affectedBuckets: [], hasMore: false };
    const at = dependencies.now();
    const adaptive = nextPricingRepairBatchLimit(
      claimed.adaptiveLimit,
      at.getTime() - startedAt.getTime(),
      result.scanned >= claimed.adaptiveLimit,
    );
    let state: PricingRepairProgress["state"] = result.hasMore || remainingSupported || rollupReconciliation.hasMore
      ? "pending"
      : remainingTotal === 0
        ? "idle"
        : "waiting_for_catalog";
    let nextAttemptAt: Date | null = state === "waiting_for_catalog"
      ? new Date(at.getTime() + WAITING_RETRY_MS)
      : state === "pending"
        ? at
        : null;
    const timezone = getOrgTimezone();
    const todayStart = dayStartUtc(localDate(at, timezone), timezone);
    const historicalDiagnostics = completedHistoricalDiagnostics(remainingDiagnostics, todayStart);
    if (!result.hasMore && !remainingSupported && remainingTotal > 0 && historicalDiagnostics.length > 0 &&
      dependencies.runHistoricalPricingStep) {
      const history = await dependencies.runHistoricalPricingStep(historicalDiagnostics);
      if (history.state === "promoted") {
        state = "pending";
        nextAttemptAt = at;
      } else if (history.state === "listing" || history.state === "fetching" || history.state === "waiting_source") {
        state = "pending";
        nextAttemptAt = history.nextAttemptAt;
      } else {
        state = "waiting_for_catalog";
        nextAttemptAt = history.nextAttemptAt;
      }
    }
    const applied = await dependencies.repository.markProgress({
      generation: claimed.generation,
      state,
      processed: replay.scanned + result.scanned,
      recovered: result.recovered,
      reconciled: replay.reconciled,
      repricedLegacy: result.repricedLegacy,
      remaining,
      remainingLegacy,
      unresolvedModels: unresolvedModels(remainingDiagnostics),
      adaptiveLimit: adaptive.limit,
      loadState: adaptive.loadState,
      nextAttemptAt,
      at,
    });
    if (applied && (state === "idle" || state === "waiting_for_catalog")) {
      try {
        dependencies.invalidateInsightCache?.();
      } catch {
        // 복구 상태는 이미 확정됐으므로 cache 무효화 실패가 generation을 되돌리면 안 된다.
      }
    }
    return applied ? "success" : "superseded";
  } catch (error) {
    const applied = await dependencies.repository.markFailed(
      claimed.generation,
      dependencies.now(),
      String(error),
    );
    return applied ? "failed" : "superseded";
  }
}

export async function runPricingRepairTask(now?: Date): Promise<RollupSchedulerOutcome> {
  const clock = now ? () => now : () => new Date();
  return runPricingRepairTaskWith({
    repository: new PgPricingRepairRepository(getPool()),
    storage: getStorage(),
    getSchedule: getPricingSchedule,
    getNonAuthoritativeRevisionIds: loadNonAuthoritativeRevisionIds,
    runHistoricalPricingStep,
    invalidateInsightCache: () => revalidateTag("user-insights"),
    now: clock,
  });
}
