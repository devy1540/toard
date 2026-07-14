import { USAGE_EVENT_LOGICAL_RETENTION_DAYS, type StorageBackend } from "@toard/core";
import { resolveCostAt, type PricingSchedule } from "@toard/pricing";
import type { Pool } from "pg";
import { getPool } from "./db";
import { getPricingSchedule } from "./pricing";
import type { RollupCoordinatorCandidate } from "./rollup-coordinator";
import type { RollupSchedulerOutcome } from "./rollup-coordinator-state";
import { sanitizeRollupError } from "./rollup-worker-state";
import { getStorage } from "./storage";

const RETENTION_MS = USAGE_EVENT_LOGICAL_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const STALE_RUNNING_MS = 5 * 60 * 1_000;
const WAITING_RETRY_MS = 60 * 60 * 1_000;

export type PricingRepairState = "idle" | "pending" | "running" | "waiting_for_catalog" | "failed";

export type PricingUnresolvedModel = {
  model: string | null;
  events: number;
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
  remainingUnpricedEvents: number;
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
  generation: Date | string | null;
  state: PricingRepairState;
  target_to: Date | null;
  processed_events: string | number;
  recovered_events: string | number;
  reconciled_events: string | number;
  remaining_unpriced_events: string | number;
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

const SELECT_FIELDS = `
  generation, state, target_to, processed_events, recovered_events, reconciled_events,
  remaining_unpriced_events, unresolved_models, last_started_at, last_succeeded_at, last_error,
  adaptive_limit, load_state, eligible_since, next_attempt_at,
  consecutive_failures, updated_at`;

function mapStatus(row: PricingRepairStatusRow): PricingRepairStatusRecord {
  return {
    generation: row.generation instanceof Date ? row.generation.toISOString() : row.generation,
    state: row.state,
    targetTo: row.target_to,
    processedEvents: Number(row.processed_events),
    recoveredEvents: Number(row.recovered_events),
    reconciledEvents: Number(row.reconciled_events),
    remainingUnpricedEvents: Number(row.remaining_unpriced_events),
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
  remaining: number;
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
       SET state = $2,
           processed_events = processed_events + $3,
           recovered_events = recovered_events + $4,
           reconciled_events = reconciled_events + $5,
           remaining_unpriced_events = $6,
           unresolved_models = $7::jsonb,
           last_succeeded_at = $8,
           last_error = NULL,
           adaptive_limit = $9,
           load_state = $10,
           eligible_since = CASE WHEN $2 = 'pending' THEN COALESCE(eligible_since, $8) ELSE NULL END,
           next_attempt_at = $11,
           consecutive_failures = 0,
           updated_at = $8
       WHERE singleton AND generation = $1::timestamptz
       RETURNING singleton`,
      [
        input.generation,
        input.state,
        input.processed,
        input.recovered,
        input.reconciled,
        input.remaining,
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
  now(): Date;
};

function supportedModels(
  diagnostics: Awaited<ReturnType<StorageBackend["getUnpricedUsageModels"]>>,
  schedule: PricingSchedule,
): string[] {
  const models = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.model) continue;
    const probe = resolveCostAt({
      model: diagnostic.model,
      occurredAt: diagnostic.firstAt,
      schedule,
      mode: "calculate",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    if (probe.status === "priced") models.add(diagnostic.model);
  }
  return [...models];
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
  diagnostics: Awaited<ReturnType<StorageBackend["getUnpricedUsageModels"]>>,
): PricingUnresolvedModel[] {
  return diagnostics.map((item) => ({
    model: item.model,
    events: item.events,
    firstAt: item.firstAt.toISOString(),
    lastAt: item.lastAt.toISOString(),
  }));
}

export async function runPricingRepairTaskWith(
  dependencies: PricingRepairTaskDependencies,
): Promise<RollupSchedulerOutcome> {
  const startedAt = dependencies.now();
  const claimed = await dependencies.repository.claim(startedAt);
  if (!claimed?.generation || !claimed.targetTo) return "superseded";
  const from = new Date(claimed.targetTo.getTime() - RETENTION_MS);
  try {
    const replay = await dependencies.storage.reconcileCodexReplayUsage({
      from,
      to: claimed.targetTo,
      limit: claimed.adaptiveLimit,
    });
    const schedule = await dependencies.getSchedule();
    let result = { scanned: 0, recovered: 0, affectedBuckets: [] as Date[], hasMore: false };
    if (!replay.hasMore) {
      const diagnostics = await dependencies.storage.getUnpricedUsageModels(from, claimed.targetTo);
      const models = supportedModels(diagnostics, schedule);
      if (models.length > 0) {
        result = await dependencies.storage.repairUnpricedUsage({
          from,
          to: claimed.targetTo,
          models,
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
    }
    const after = await dependencies.storage.getUnpricedUsageModels(from, claimed.targetTo);
    const remaining = after.reduce((sum, item) => sum + item.events, 0);
    const remainingSupported = supportedModels(after, schedule).length > 0;
    const at = dependencies.now();
    const adaptive = nextPricingRepairBatchLimit(
      claimed.adaptiveLimit,
      at.getTime() - startedAt.getTime(),
      replay.hasMore || result.scanned >= claimed.adaptiveLimit,
    );
    const state = replay.hasMore || result.hasMore || remainingSupported
      ? "pending"
      : remaining === 0
        ? "idle"
        : "waiting_for_catalog";
    const applied = await dependencies.repository.markProgress({
      generation: claimed.generation,
      state,
      processed: replay.scanned + result.scanned,
      recovered: result.recovered,
      reconciled: replay.reconciled,
      remaining,
      unresolvedModels: unresolvedModels(after),
      adaptiveLimit: adaptive.limit,
      loadState: adaptive.loadState,
      nextAttemptAt: state === "waiting_for_catalog"
        ? new Date(at.getTime() + WAITING_RETRY_MS)
        : state === "pending"
          ? at
          : null,
      at,
    });
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
    now: clock,
  });
}
