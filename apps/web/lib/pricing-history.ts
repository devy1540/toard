import { USAGE_EVENT_LOGICAL_RETENTION_DAYS } from "@toard/core";
import { resolvePricingEntry, type ModelPricing, type PricingMap } from "@toard/pricing";
import type { Pool, PoolClient } from "pg";
import { getPool } from "./db";
import { dayStartUtc, getOrgTimezone } from "./org-time";
import { invalidatePricingCache, PRICING_CACHE_VERSION_SETTING_KEY } from "./pricing";
import {
  GitHubPricingHistorySource,
  PricingSourceRateLimitError,
  type PricingHistoryCommitRef,
} from "./pricing-history-source";

const MAX_MODELS_PER_JOB = 20;
const MAX_SNAPSHOTS_PER_STEP = 4;
const SOURCE_RETRY_BASE_MS = 60_000;
const SOURCE_RETRY_MAX_MS = 60 * 60_000;
const HISTORY_SOURCE = "litellm-git-history";

export type HistoricalPricingJobState =
  | "pending"
  | "listing"
  | "fetching"
  | "promoting"
  | "completed"
  | "waiting_source"
  | "failed";

export type HistoricalPricingJob = {
  id: string;
  state: HistoricalPricingJobState;
  rangeFrom: Date;
  rangeTo: Date;
  models: string[];
  commitRefs: PricingHistoryCommitRef[];
  listPage: number;
  nextCommitIndex: number;
  nextAttemptAt: Date | null;
  rateLimitResetAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
};

export type HistoricalPricingDiagnostic = {
  model: string | null;
  events: number;
  firstAt: string;
  lastAt: string;
};

export type HistoricalPricingSnapshot = {
  ref: PricingHistoryCommitRef;
  pricing: PricingMap;
};

export interface HistoricalPricingRepository {
  getActive(): Promise<HistoricalPricingJob | null>;
  create(input: {
    rangeFrom: Date;
    rangeTo: Date;
    models: string[];
    at: Date;
  }): Promise<HistoricalPricingJob>;
  saveBaseline(id: string, refs: PricingHistoryCommitRef[], at: Date): Promise<HistoricalPricingJob>;
  saveCommitPage(
    id: string,
    refs: PricingHistoryCommitRef[],
    nextPage: number | null,
    at: Date,
  ): Promise<HistoricalPricingJob>;
  saveSnapshots(id: string, snapshots: HistoricalPricingSnapshot[], at: Date): Promise<HistoricalPricingJob>;
  promote(id: string, at: Date): Promise<{ insertedRevisions: number; evidenceFound: boolean }>;
  waitForSource(
    id: string,
    nextAttemptAt: Date,
    rateLimitResetAt: Date | null,
    error: string,
    at: Date,
  ): Promise<HistoricalPricingJob>;
  resume(
    id: string,
    state: "pending" | "listing" | "fetching",
    at: Date,
  ): Promise<HistoricalPricingJob>;
}

type HistoricalPricingSource = {
  listBaseline(until: Date): Promise<PricingHistoryCommitRef[]>;
  listChanges(from: Date, to: Date, page: number): Promise<PricingHistoryCommitRef[]>;
  fetchSnapshot(sha: string): Promise<PricingMap>;
};

type HistoricalPricingStepDependencies = {
  repository: HistoricalPricingRepository;
  source: HistoricalPricingSource;
  now(): Date;
  timezone: string;
  invalidateCache(): void;
};

export type HistoricalPricingStepResult =
  | { state: "listing" | "fetching"; nextAttemptAt: Date }
  | { state: "waiting_source"; nextAttemptAt: Date }
  | { state: "promoted"; insertedRevisions: number }
  | { state: "no_evidence"; nextAttemptAt: Date };

export type HistoricalPricingStatus = {
  state: HistoricalPricingJobState | "idle";
  rangeFrom: string | null;
  rangeTo: string | null;
  models: number;
  processedSnapshots: number;
  totalSnapshots: number;
  nextAttemptAt: string | null;
  lastError: string | null;
};

export function historicalPricingStatusFromJob(
  job: HistoricalPricingJob | null,
): HistoricalPricingStatus {
  if (!job) {
    return {
      state: "idle",
      rangeFrom: null,
      rangeTo: null,
      models: 0,
      processedSnapshots: 0,
      totalSnapshots: 0,
      nextAttemptAt: null,
      lastError: null,
    };
  }
  return {
    state: job.state,
    rangeFrom: job.rangeFrom.toISOString(),
    rangeTo: job.rangeTo.toISOString(),
    models: job.models.length,
    processedSnapshots: job.nextCommitIndex,
    totalSnapshots: job.commitRefs.length,
    nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
    lastError: job.lastError,
  };
}

type HistoricalPricingJobRow = {
  id: string;
  state: HistoricalPricingJobState;
  range_from: Date | string;
  range_to: Date | string;
  models: unknown;
  commit_refs: unknown;
  list_page: string | number;
  next_commit_index: string | number;
  next_attempt_at: Date | string | null;
  rate_limit_reset_at: Date | string | null;
  consecutive_failures: string | number;
  last_error: string | null;
};

type OpenCandidateRow = {
  model_id: string;
  source_model_id: string;
  effective_at: Date | string;
  input_price_per_mtok: string | number;
  output_price_per_mtok: string | number;
  cache_read_price_per_mtok: string | number | null;
  cache_creation_price_per_mtok: string | number | null;
  input_price_above_200k_per_mtok: string | number | null;
  output_price_above_200k_per_mtok: string | number | null;
  fast_multiplier: string | number;
  source_commit_sha: string;
  source_committed_at: Date | string;
};

function parseCommitRefs(value: unknown): PricingHistoryCommitRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item == null || typeof item !== "object") return [];
    const sha = Reflect.get(item, "sha");
    const committedAt = Reflect.get(item, "committedAt");
    return typeof sha === "string" && typeof committedAt === "string"
      ? [{ sha, committedAt }]
      : [];
  });
}

function mapJob(row: HistoricalPricingJobRow): HistoricalPricingJob {
  const models = Array.isArray(row.models)
    ? row.models.filter((model): model is string => typeof model === "string")
    : [];
  return {
    id: row.id,
    state: row.state,
    rangeFrom: new Date(row.range_from),
    rangeTo: new Date(row.range_to),
    models,
    commitRefs: parseCommitRefs(row.commit_refs),
    listPage: Number(row.list_page),
    nextCommitIndex: Number(row.next_commit_index),
    nextAttemptAt: row.next_attempt_at == null ? null : new Date(row.next_attempt_at),
    rateLimitResetAt: row.rate_limit_reset_at == null ? null : new Date(row.rate_limit_reset_at),
    consecutiveFailures: Number(row.consecutive_failures),
    lastError: row.last_error,
  };
}

function localDate(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function nextDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function jobInput(
  diagnostics: HistoricalPricingDiagnostic[],
  now: Date,
  timezone: string,
): { rangeFrom: Date; rangeTo: Date; models: string[] } | null {
  const usable = diagnostics
    .filter((item): item is HistoricalPricingDiagnostic & { model: string } =>
      typeof item.model === "string" && item.model.trim() !== "" &&
      Number.isFinite(new Date(item.firstAt).getTime()) &&
      Number.isFinite(new Date(item.lastAt).getTime()))
    .sort((left, right) => left.firstAt.localeCompare(right.firstAt));
  const models = [...new Set(usable.map((item) => item.model))].slice(0, MAX_MODELS_PER_JOB);
  if (models.length === 0) return null;
  const selected = usable.filter((item) => models.includes(item.model));
  const firstAt = new Date(Math.min(...selected.map((item) => new Date(item.firstAt).getTime())));
  const lastAt = new Date(Math.max(...selected.map((item) => new Date(item.lastAt).getTime())));
  const retentionAt = new Date(
    now.getTime() - USAGE_EVENT_LOGICAL_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  );
  const rangeFrom = dayStartUtc(
    localDate(firstAt < retentionAt ? retentionAt : firstAt, timezone),
    timezone,
  );
  const rangeTo = dayStartUtc(nextDate(localDate(lastAt, timezone)), timezone);
  return rangeTo > rangeFrom ? { rangeFrom, rangeTo, models } : null;
}

function appendUnique(
  current: PricingHistoryCommitRef[],
  next: PricingHistoryCommitRef[],
): PricingHistoryCommitRef[] {
  const seen = new Set<string>();
  return [...current, ...next].filter((ref) => {
    if (seen.has(ref.sha)) return false;
    seen.add(ref.sha);
    return true;
  });
}

/** GitHub changes API의 newest-first page들을 baseline 뒤 oldest-first 실행 순서로 바꾼다. */
function executionOrder(refs: PricingHistoryCommitRef[]): PricingHistoryCommitRef[] {
  const baseline = refs[0];
  if (!baseline) return [];
  const changes = refs.slice(1).reverse().filter((ref) => ref.sha !== baseline.sha);
  return appendUnique([baseline], changes);
}

function resumeState(job: HistoricalPricingJob): "pending" | "listing" | "fetching" {
  if (job.listPage > 0) return "listing";
  if (job.commitRefs.length > 0) return "fetching";
  return "pending";
}

function sanitizedSourceError(error: unknown): string {
  if (error instanceof PricingSourceRateLimitError) return error.message;
  if (error instanceof Error) {
    const known = error.message.match(/^pricing (?:commit list|snapshot fetch) failed: \d{3}$/)?.[0];
    if (known) return known;
  }
  return "pricing history source unavailable";
}

function retryAt(job: HistoricalPricingJob, now: Date): Date {
  const exponent = Math.min(10, job.consecutiveFailures);
  return new Date(now.getTime() + Math.min(SOURCE_RETRY_MAX_MS, SOURCE_RETRY_BASE_MS * 2 ** exponent));
}

export async function runHistoricalPricingStepWith(
  dependencies: HistoricalPricingStepDependencies,
  diagnostics: HistoricalPricingDiagnostic[],
): Promise<HistoricalPricingStepResult> {
  const now = dependencies.now();
  let job = await dependencies.repository.getActive();
  if (!job) {
    const input = jobInput(diagnostics, now, dependencies.timezone);
    if (!input) return { state: "no_evidence", nextAttemptAt: new Date(now.getTime() + SOURCE_RETRY_MAX_MS) };
    await dependencies.repository.create({ ...input, at: now });
    return { state: "listing", nextAttemptAt: now };
  }

  if (job.state === "waiting_source") {
    if (job.nextAttemptAt && job.nextAttemptAt > now) {
      return { state: "waiting_source", nextAttemptAt: job.nextAttemptAt };
    }
    const state = resumeState(job);
    job = await dependencies.repository.resume(job.id, state, now);
    return { state: state === "pending" ? "listing" : state, nextAttemptAt: now };
  }

  try {
    if (job.state === "pending") {
      const baseline = await dependencies.source.listBaseline(job.rangeFrom);
      if (baseline.length === 0) {
        const nextAttemptAt = retryAt(job, now);
        await dependencies.repository.waitForSource(
          job.id,
          nextAttemptAt,
          null,
          "pricing history baseline unavailable",
          now,
        );
        return { state: "no_evidence", nextAttemptAt };
      }
      await dependencies.repository.saveBaseline(job.id, baseline.slice(0, 1), now);
      return { state: "listing", nextAttemptAt: now };
    }

    if (job.state === "listing") {
      const page = await dependencies.source.listChanges(
        job.rangeFrom,
        job.rangeTo,
        job.listPage,
      );
      const refs = appendUnique(job.commitRefs, page);
      const finished = page.length < 100;
      await dependencies.repository.saveCommitPage(
        job.id,
        finished ? executionOrder(refs) : refs,
        finished ? null : job.listPage + 1,
        now,
      );
      return { state: finished ? "fetching" : "listing", nextAttemptAt: now };
    }

    if (job.state === "fetching") {
      const refs = job.commitRefs.slice(
        job.nextCommitIndex,
        job.nextCommitIndex + MAX_SNAPSHOTS_PER_STEP,
      );
      if (refs.length === 0) {
        throw new Error("pricing history cursor is invalid");
      }
      const snapshots: HistoricalPricingSnapshot[] = [];
      for (const ref of refs) {
        snapshots.push({ ref, pricing: await dependencies.source.fetchSnapshot(ref.sha) });
      }
      await dependencies.repository.saveSnapshots(job.id, snapshots, now);
      return { state: "fetching", nextAttemptAt: now };
    }

    if (job.state === "promoting") {
      const promoted = await dependencies.repository.promote(job.id, now);
      if (!promoted.evidenceFound) {
        return { state: "no_evidence", nextAttemptAt: new Date(now.getTime() + SOURCE_RETRY_MAX_MS) };
      }
      dependencies.invalidateCache();
      return { state: "promoted", insertedRevisions: promoted.insertedRevisions };
    }

    return { state: "no_evidence", nextAttemptAt: new Date(now.getTime() + SOURCE_RETRY_MAX_MS) };
  } catch (error) {
    const nextAttemptAt = error instanceof PricingSourceRateLimitError
      ? error.resetAt
      : retryAt(job, now);
    await dependencies.repository.waitForSource(
      job.id,
      nextAttemptAt,
      error instanceof PricingSourceRateLimitError ? error.resetAt : null,
      sanitizedSourceError(error),
      now,
    );
    return { state: "waiting_source", nextAttemptAt };
  }
}

function samePricing(left: ModelPricing, right: ModelPricing): boolean {
  return left.inputPerM === right.inputPerM &&
    left.outputPerM === right.outputPerM &&
    (left.cacheReadPerM ?? null) === (right.cacheReadPerM ?? null) &&
    (left.cacheCreatePerM ?? null) === (right.cacheCreatePerM ?? null) &&
    (left.inputAbove200kPerM ?? null) === (right.inputAbove200kPerM ?? null) &&
    (left.outputAbove200kPerM ?? null) === (right.outputAbove200kPerM ?? null) &&
    (left.fastMultiplier ?? 1) === (right.fastMultiplier ?? 1);
}

function candidatePricing(row: OpenCandidateRow): ModelPricing {
  const value: ModelPricing = {
    inputPerM: Number(row.input_price_per_mtok),
    outputPerM: Number(row.output_price_per_mtok),
  };
  if (row.cache_read_price_per_mtok != null) value.cacheReadPerM = Number(row.cache_read_price_per_mtok);
  if (row.cache_creation_price_per_mtok != null) value.cacheCreatePerM = Number(row.cache_creation_price_per_mtok);
  if (row.input_price_above_200k_per_mtok != null) value.inputAbove200kPerM = Number(row.input_price_above_200k_per_mtok);
  if (row.output_price_above_200k_per_mtok != null) value.outputAbove200kPerM = Number(row.output_price_above_200k_per_mtok);
  value.fastMultiplier = Number(row.fast_multiplier);
  return value;
}

const JOB_FIELDS = `id, state, range_from, range_to, models, commit_refs, list_page,
  next_commit_index, next_attempt_at, rate_limit_reset_at, consecutive_failures, last_error`;

async function updatedJob(client: Pool | PoolClient, sql: string, params: unknown[]): Promise<HistoricalPricingJob> {
  const result = await client.query<HistoricalPricingJobRow>(sql, params);
  if (!result.rows[0]) throw new Error("historical pricing job update was superseded");
  return mapJob(result.rows[0]);
}

export class PgPricingHistoryRepository implements HistoricalPricingRepository {
  constructor(private readonly pool: Pool) {}

  async getActive(): Promise<HistoricalPricingJob | null> {
    const result = await this.pool.query<HistoricalPricingJobRow>(
      `SELECT ${JOB_FIELDS} FROM pricing_history_jobs
       WHERE state <> 'completed'
       ORDER BY created_at ASC
       LIMIT 1`,
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async getStatus(): Promise<HistoricalPricingStatus> {
    const result = await this.pool.query<HistoricalPricingJobRow>(
      `SELECT ${JOB_FIELDS} FROM pricing_history_jobs
       ORDER BY CASE WHEN state = 'completed' THEN 1 ELSE 0 END, created_at DESC
       LIMIT 1`,
    );
    return historicalPricingStatusFromJob(result.rows[0] ? mapJob(result.rows[0]) : null);
  }

  async create(input: { rangeFrom: Date; rangeTo: Date; models: string[]; at: Date }): Promise<HistoricalPricingJob> {
    const result = await this.pool.query<HistoricalPricingJobRow>(
      `INSERT INTO pricing_history_jobs (
         state, range_from, range_to, models, last_started_at, updated_at
       ) VALUES ('pending', $1, $2, $3::jsonb, $4, $4)
       ON CONFLICT DO NOTHING
       RETURNING ${JOB_FIELDS}`,
      [input.rangeFrom, input.rangeTo, JSON.stringify(input.models), input.at],
    );
    if (result.rows[0]) return mapJob(result.rows[0]);
    const active = await this.getActive();
    if (!active) throw new Error("historical pricing job was not created");
    return active;
  }

  async saveBaseline(id: string, refs: PricingHistoryCommitRef[], at: Date): Promise<HistoricalPricingJob> {
    return updatedJob(
      this.pool,
      `UPDATE pricing_history_jobs
       SET state = 'listing', commit_refs = $2::jsonb, list_page = 1,
           next_attempt_at = NULL, rate_limit_reset_at = NULL,
           consecutive_failures = 0, last_error = NULL, updated_at = $3
       WHERE id = $1 AND state = 'pending'
       RETURNING ${JOB_FIELDS}`,
      [id, JSON.stringify(refs), at],
    );
  }

  async saveCommitPage(
    id: string,
    refs: PricingHistoryCommitRef[],
    nextPage: number | null,
    at: Date,
  ): Promise<HistoricalPricingJob> {
    return updatedJob(
      this.pool,
      `UPDATE pricing_history_jobs
       SET state = CASE WHEN $3::integer IS NULL THEN 'fetching' ELSE 'listing' END,
           commit_refs = $2::jsonb, list_page = COALESCE($3, 0), next_commit_index = 0,
           next_attempt_at = NULL, rate_limit_reset_at = NULL,
           consecutive_failures = 0, last_error = NULL, updated_at = $4
       WHERE id = $1 AND state = 'listing'
       RETURNING ${JOB_FIELDS}`,
      [id, JSON.stringify(refs), nextPage, at],
    );
  }

  private async applySnapshot(
    client: PoolClient,
    job: HistoricalPricingJob,
    snapshot: HistoricalPricingSnapshot,
    open: Map<string, OpenCandidateRow>,
  ): Promise<void> {
    const committedAt = new Date(snapshot.ref.committedAt);
    if (!Number.isFinite(committedAt.getTime())) throw new Error("invalid pricing history commit time");
    const boundary = committedAt < job.rangeFrom ? job.rangeFrom : committedAt;
    for (const model of job.models) {
      const previous = open.get(model);
      const resolved = resolvePricingEntry(model, snapshot.pricing);
      if (previous && resolved && previous.source_model_id === resolved.modelId &&
        samePricing(candidatePricing(previous), resolved.pricing)) {
        continue;
      }
      if (previous) {
        const effectiveAt = new Date(previous.effective_at);
        if (boundary > effectiveAt) {
          await client.query(
            `UPDATE pricing_history_candidates
             SET valid_until = $3
             WHERE job_id = $1 AND model_id = $2 AND effective_at = $4`,
            [job.id, model, boundary, effectiveAt],
          );
        } else {
          await client.query(
            `DELETE FROM pricing_history_candidates
             WHERE job_id = $1 AND model_id = $2 AND effective_at = $3`,
            [job.id, model, effectiveAt],
          );
        }
        open.delete(model);
      }
      if (!resolved || boundary >= job.rangeTo) continue;
      const value = resolved.pricing;
      await client.query(
        `INSERT INTO pricing_history_candidates (
           job_id, model_id, source_model_id, effective_at,
           input_price_per_mtok, output_price_per_mtok,
           cache_read_price_per_mtok, cache_creation_price_per_mtok,
           input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
           fast_multiplier, source_commit_sha, source_committed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (job_id, model_id, effective_at) DO UPDATE SET
           source_model_id = EXCLUDED.source_model_id,
           input_price_per_mtok = EXCLUDED.input_price_per_mtok,
           output_price_per_mtok = EXCLUDED.output_price_per_mtok,
           cache_read_price_per_mtok = EXCLUDED.cache_read_price_per_mtok,
           cache_creation_price_per_mtok = EXCLUDED.cache_creation_price_per_mtok,
           input_price_above_200k_per_mtok = EXCLUDED.input_price_above_200k_per_mtok,
           output_price_above_200k_per_mtok = EXCLUDED.output_price_above_200k_per_mtok,
           fast_multiplier = EXCLUDED.fast_multiplier,
           source_commit_sha = EXCLUDED.source_commit_sha,
           source_committed_at = EXCLUDED.source_committed_at,
           valid_until = NULL`,
        [
          job.id,
          model,
          resolved.modelId,
          boundary,
          value.inputPerM,
          value.outputPerM,
          value.cacheReadPerM ?? null,
          value.cacheCreatePerM ?? null,
          value.inputAbove200kPerM ?? null,
          value.outputAbove200kPerM ?? null,
          value.fastMultiplier ?? 1,
          snapshot.ref.sha,
          committedAt,
        ],
      );
      open.set(model, {
        model_id: model,
        source_model_id: resolved.modelId,
        effective_at: boundary,
        input_price_per_mtok: value.inputPerM,
        output_price_per_mtok: value.outputPerM,
        cache_read_price_per_mtok: value.cacheReadPerM ?? null,
        cache_creation_price_per_mtok: value.cacheCreatePerM ?? null,
        input_price_above_200k_per_mtok: value.inputAbove200kPerM ?? null,
        output_price_above_200k_per_mtok: value.outputAbove200kPerM ?? null,
        fast_multiplier: value.fastMultiplier ?? 1,
        source_commit_sha: snapshot.ref.sha,
        source_committed_at: committedAt,
      });
    }
  }

  async saveSnapshots(id: string, snapshots: HistoricalPricingSnapshot[], at: Date): Promise<HistoricalPricingJob> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<HistoricalPricingJobRow>(
        `SELECT ${JOB_FIELDS} FROM pricing_history_jobs
         WHERE id = $1 AND state = 'fetching'
         FOR UPDATE`,
        [id],
      );
      if (!locked.rows[0]) throw new Error("historical pricing job was superseded");
      const job = mapJob(locked.rows[0]);
      const expected = job.commitRefs.slice(job.nextCommitIndex, job.nextCommitIndex + snapshots.length);
      if (expected.length !== snapshots.length || expected.some((ref, index) => ref.sha !== snapshots[index]?.ref.sha)) {
        throw new Error("historical pricing snapshot cursor mismatch");
      }
      const rows = await client.query<OpenCandidateRow>(
        `SELECT model_id, source_model_id, effective_at,
           input_price_per_mtok, output_price_per_mtok,
           cache_read_price_per_mtok, cache_creation_price_per_mtok,
           input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
           fast_multiplier, source_commit_sha, source_committed_at
         FROM pricing_history_candidates
         WHERE job_id = $1 AND valid_until IS NULL
         FOR UPDATE`,
        [id],
      );
      const open = new Map(rows.rows.map((row) => [row.model_id, row]));
      for (const snapshot of snapshots) await this.applySnapshot(client, job, snapshot, open);
      const nextIndex = job.nextCommitIndex + snapshots.length;
      const finished = nextIndex === job.commitRefs.length;
      if (finished) {
        await client.query(
          `UPDATE pricing_history_candidates
           SET valid_until = $2
           WHERE job_id = $1 AND valid_until IS NULL AND effective_at < $2`,
          [id, job.rangeTo],
        );
        await client.query(
          `DELETE FROM pricing_history_candidates
           WHERE job_id = $1 AND valid_until IS NULL`,
          [id],
        );
      }
      const result = await client.query<HistoricalPricingJobRow>(
        `UPDATE pricing_history_jobs
         SET state = CASE WHEN $3 THEN 'promoting' ELSE 'fetching' END,
             next_commit_index = $2, consecutive_failures = 0, last_error = NULL,
             next_attempt_at = NULL, rate_limit_reset_at = NULL, updated_at = $4
         WHERE id = $1 AND state = 'fetching'
         RETURNING ${JOB_FIELDS}`,
        [id, nextIndex, finished, at],
      );
      if (!result.rows[0]) throw new Error("historical pricing job update was superseded");
      await client.query("COMMIT");
      return mapJob(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async promote(id: string, at: Date): Promise<{ insertedRevisions: number; evidenceFound: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT id FROM pricing_history_jobs WHERE id = $1 AND state = 'promoting' FOR UPDATE`,
        [id],
      );
      if (!locked.rows[0]) throw new Error("historical pricing promotion was superseded");
      const evidence = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pricing_history_candidates
         WHERE job_id = $1 AND valid_until IS NOT NULL`,
        [id],
      );
      const evidenceFound = Number(evidence.rows[0]?.count ?? 0) > 0;
      let insertedRevisions = 0;
      if (evidenceFound) {
        const inserted = await client.query(
          `INSERT INTO pricing_revisions (
             model_id, effective_at, valid_until,
             input_price_per_mtok, output_price_per_mtok,
             cache_read_price_per_mtok, cache_creation_price_per_mtok,
             input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
             fast_multiplier, source, authoritative, source_ref, source_model_id, observed_at
           )
           SELECT model_id, effective_at, valid_until,
             input_price_per_mtok, output_price_per_mtok,
             cache_read_price_per_mtok, cache_creation_price_per_mtok,
             input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
             fast_multiplier, $2, TRUE, source_commit_sha, source_model_id, $3
           FROM pricing_history_candidates
           WHERE job_id = $1 AND valid_until IS NOT NULL
           ORDER BY model_id, effective_at
           ON CONFLICT (model_id, effective_at, source) DO NOTHING
           RETURNING id`,
          [id, HISTORY_SOURCE, at],
        );
        insertedRevisions = inserted.rows.length;
        await client.query(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [PRICING_CACHE_VERSION_SETTING_KEY, JSON.stringify({ updatedAt: at.toISOString() }), at],
        );
        await client.query(
          `UPDATE pricing_repair_status
           SET generation = $1, state = 'pending', target_to = $2,
               processed_events = 0, recovered_events = 0, reconciled_events = 0,
               remaining_unpriced_events = 0, unresolved_models = '[]'::jsonb,
               eligible_since = $1, next_attempt_at = $1,
               consecutive_failures = 0, last_error = NULL, updated_at = $1
           WHERE singleton`,
          [at, at],
        );
      }
      await client.query(
        `UPDATE pricing_history_jobs
         SET state = 'completed', completed_at = $2, next_attempt_at = NULL,
             rate_limit_reset_at = NULL, last_error = NULL, updated_at = $2
         WHERE id = $1 AND state = 'promoting'`,
        [id, at],
      );
      await client.query("COMMIT");
      return { insertedRevisions, evidenceFound };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async waitForSource(
    id: string,
    nextAttemptAt: Date,
    rateLimitResetAt: Date | null,
    error: string,
    at: Date,
  ): Promise<HistoricalPricingJob> {
    return updatedJob(
      this.pool,
      `UPDATE pricing_history_jobs
       SET state = 'waiting_source', next_attempt_at = $2, rate_limit_reset_at = $3,
           consecutive_failures = consecutive_failures + 1, last_error = $4, updated_at = $5
       WHERE id = $1 AND state IN ('pending', 'listing', 'fetching')
       RETURNING ${JOB_FIELDS}`,
      [id, nextAttemptAt, rateLimitResetAt, error.slice(0, 200), at],
    );
  }

  async resume(
    id: string,
    state: "pending" | "listing" | "fetching",
    at: Date,
  ): Promise<HistoricalPricingJob> {
    return updatedJob(
      this.pool,
      `UPDATE pricing_history_jobs
       SET state = $2, next_attempt_at = NULL, rate_limit_reset_at = NULL, updated_at = $3
       WHERE id = $1 AND state = 'waiting_source'
       RETURNING ${JOB_FIELDS}`,
      [id, state, at],
    );
  }
}

export async function runHistoricalPricingStep(
  diagnostics: HistoricalPricingDiagnostic[],
): Promise<HistoricalPricingStepResult> {
  return runHistoricalPricingStepWith({
    repository: new PgPricingHistoryRepository(getPool()),
    source: new GitHubPricingHistorySource(),
    now: () => new Date(),
    timezone: getOrgTimezone(),
    invalidateCache: invalidatePricingCache,
  }, diagnostics);
}
