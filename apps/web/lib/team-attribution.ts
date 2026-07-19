import type { StorageBackend, TeamAttributionBatchResult } from "@toard/core";
import type { Pool, PoolClient } from "pg";
import { getPool } from "./db";
import { getStorage } from "./storage";

const STARTUP_DELAY_MS = 15_000;
const TICK_MS = 10_000;
const DEFAULT_LIMIT = 250;

export type TeamAttributionJobKind = "initial_backfill" | "legacy_adoption";
export type TeamAttributionJobState = "pending" | "running" | "succeeded" | "failed";

export type ClaimedTeamAttributionJob = {
  id: string;
  assignmentId: string;
  userId: string;
  teamId: string;
  kind: TeamAttributionJobKind;
  from: Date | null;
  to: Date | null;
  matchedEvents: number;
  processedEvents: number;
  updatedEvents: number;
  attempts: number;
};

export type TeamAttributionProgress = Pick<
  TeamAttributionBatchResult,
  "processed" | "updated" | "hasMore"
> & { at: Date };

export type TeamAttributionStatus = {
  jobId: string;
  kind: TeamAttributionJobKind;
  state: TeamAttributionJobState;
  matchedEvents: number;
  processedEvents: number;
  updatedEvents: number;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  finishedAt: Date | null;
};

export interface TeamAttributionRepository {
  claim(at: Date): Promise<ClaimedTeamAttributionJob | null>;
  recordMatched(jobId: string, events: number): Promise<void>;
  markProgress(jobId: string, result: TeamAttributionProgress): Promise<void>;
  markFailed(jobId: string, code: string, at: Date): Promise<void>;
}

type ClaimedJobRow = {
  id: string;
  assignment_id: string;
  user_id: string;
  team_id: string;
  kind: TeamAttributionJobKind;
  from_ts: Date | string;
  assignment_to: Date | null;
  matched_events: string | number;
  processed_events: string | number;
  updated_events: string | number;
  attempts: string | number;
};

type StatusRow = {
  id: string;
  user_id: string;
  kind: TeamAttributionJobKind;
  status: TeamAttributionJobState;
  matched_events: string | number;
  processed_events: string | number;
  updated_events: string | number;
  attempts: string | number;
  last_error: string | null;
  next_attempt_at: Date | null;
  finished_at: Date | null;
};

function finiteCount(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function boundedFrom(value: Date | string): Date | null {
  if (typeof value === "string" && value.toLowerCase().includes("infinity")) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function mapClaimedJob(row: ClaimedJobRow): ClaimedTeamAttributionJob {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    userId: row.user_id,
    teamId: row.team_id,
    kind: row.kind,
    from: boundedFrom(row.from_ts),
    to: row.assignment_to,
    matchedEvents: finiteCount(row.matched_events),
    processedEvents: finiteCount(row.processed_events),
    updatedEvents: finiteCount(row.updated_events),
    attempts: finiteCount(row.attempts) + 1,
  };
}

function mapStatus(row: StatusRow): TeamAttributionStatus {
  return {
    jobId: row.id,
    kind: row.kind,
    state: row.status,
    matchedEvents: finiteCount(row.matched_events),
    processedEvents: finiteCount(row.processed_events),
    updatedEvents: finiteCount(row.updated_events),
    attempts: finiteCount(row.attempts),
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    finishedAt: row.finished_at,
  };
}

export class PgTeamAttributionRepository implements TeamAttributionRepository {
  constructor(private readonly pool: Pool) {}

  async claim(at: Date): Promise<ClaimedTeamAttributionJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<ClaimedJobRow>(
        `SELECT job.id::text,
                job.assignment_id::text,
                job.user_id::text,
                job.team_id::text,
                job.kind,
                job.from_ts,
                assignment.effective_to AS assignment_to,
                job.matched_events,
                job.processed_events,
                job.updated_events,
                job.attempts
           FROM team_attribution_jobs AS job
           JOIN user_team_assignments AS assignment ON assignment.id = job.assignment_id
          WHERE (
              job.status IN ('pending', 'failed')
              AND job.next_attempt_at <= $1
            ) OR (
              job.status = 'running'
              AND job.updated_at <= $1 - INTERVAL '5 minutes'
            )
          ORDER BY job.created_at, job.id
          LIMIT 1
          FOR UPDATE OF job SKIP LOCKED`,
        [at],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE team_attribution_jobs
            SET status = 'running',
                to_ts = $2,
                attempts = attempts + 1,
                started_at = COALESCE(started_at, $3),
                last_error = NULL,
                updated_at = $3
          WHERE id = $1`,
        [row.id, row.assignment_to, at],
      );
      await client.query("COMMIT");
      return mapClaimedJob(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMatched(jobId: string, events: number): Promise<void> {
    await this.pool.query(
      `UPDATE team_attribution_jobs
          SET matched_events = GREATEST(matched_events, $2),
              updated_at = now()
        WHERE id = $1`,
      [jobId, Math.max(0, Math.trunc(events))],
    );
  }

  async markProgress(jobId: string, result: TeamAttributionProgress): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE team_attribution_jobs
            SET status = CASE WHEN $4 THEN 'pending' ELSE 'succeeded' END,
                processed_events = processed_events + $2,
                updated_events = updated_events + $3,
                next_attempt_at = $5,
                last_error = NULL,
                finished_at = CASE WHEN $4 THEN NULL ELSE $5 END,
                updated_at = $5
          WHERE id = $1`,
        [jobId, result.processed, result.updated, result.hasMore, result.at],
      );
      if (!result.hasMore) {
        await client.query("SELECT complete_team_attribution_fence($1::uuid)", [jobId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markFailed(jobId: string, code: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE team_attribution_jobs
          SET status = 'failed',
              last_error = $2,
              next_attempt_at = $3 + make_interval(
                secs => LEAST(300, 5 * power(2, GREATEST(attempts - 1, 0))::integer)
              ),
              updated_at = $3
        WHERE id = $1`,
      [jobId, code, at],
    );
  }

  async getStatuses(userIds: string[]): Promise<Map<string, TeamAttributionStatus>> {
    if (userIds.length === 0) return new Map();
    const result = await this.pool.query<StatusRow>(
      `SELECT DISTINCT ON (user_id)
              id::text, user_id::text, kind, status, matched_events,
              processed_events, updated_events, attempts, last_error,
              next_attempt_at, finished_at
         FROM team_attribution_jobs
        WHERE user_id = ANY($1::uuid[])
        ORDER BY user_id, created_at DESC, id DESC`,
      [[...new Set(userIds)]],
    );
    return new Map(result.rows.map((row) => [row.user_id, mapStatus(row)]));
  }

  async hasFence(from: Date, to: Date): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM team_attribution_read_fences
        WHERE from_ts < $2
          AND (to_ts IS NULL OR to_ts > $1)
        LIMIT 1`,
      [from, to],
    );
    return result.rowCount === 1;
  }
}

export function sanitizeTeamAttributionError(error: unknown): string {
  if (error instanceof Error && /rollup verification failed/i.test(error.message)) {
    return "ROLLUP_VERIFICATION_FAILED";
  }
  return "TEAM_ATTRIBUTION_FAILED";
}

export type TeamAttributionWorkerDependencies = {
  repository: TeamAttributionRepository;
  storage: StorageBackend;
  limit: number;
};

export async function runTeamAttributionBatchAt(
  at: Date,
  dependencies: TeamAttributionWorkerDependencies,
): Promise<"idle" | "progress" | "complete" | "failed"> {
  const claimed = await dependencies.repository.claim(at);
  if (!claimed) return "idle";
  try {
    if (claimed.matchedEvents === 0 && claimed.processedEvents === 0) {
      const preview = await dependencies.storage.previewUnassignedTeamAttribution({
        userId: claimed.userId,
        from: claimed.from,
        to: claimed.to,
      });
      await dependencies.repository.recordMatched(claimed.id, preview.events);
    }
    const result = await dependencies.storage.backfillUnassignedTeamAttribution({
      userId: claimed.userId,
      teamId: claimed.teamId,
      from: claimed.from,
      to: claimed.to,
      limit: dependencies.limit,
      jobId: claimed.id,
    });
    await dependencies.repository.markProgress(claimed.id, {
      processed: result.processed,
      updated: result.updated,
      hasMore: result.hasMore,
      at,
    });
    return result.hasMore ? "progress" : "complete";
  } catch (error) {
    await dependencies.repository.markFailed(claimed.id, sanitizeTeamAttributionError(error), at);
    return "failed";
  }
}

function defaultDependencies(): TeamAttributionWorkerDependencies {
  return {
    repository: new PgTeamAttributionRepository(getPool()),
    storage: getStorage(),
    limit: DEFAULT_LIMIT,
  };
}

export async function runTeamAttributionBatch(
  at = new Date(),
): Promise<"idle" | "progress" | "complete" | "failed"> {
  return runTeamAttributionBatchAt(at, defaultDependencies());
}

export async function getTeamAttributionStatus(
  userIds: string[],
): Promise<Map<string, TeamAttributionStatus>> {
  return new PgTeamAttributionRepository(getPool()).getStatuses(userIds);
}

export async function findTeamAttributionFence(from: Date, to: Date): Promise<boolean> {
  return new PgTeamAttributionRepository(getPool()).hasFence(from, to);
}

export function teamAttributionSchedulerEligible(
  env: Record<string, string | undefined>,
): boolean {
  if (env.VERCEL) return false;
  return env.NODE_ENV === "production";
}

export function startTeamAttributionWorker(): void {
  const state = globalThis as {
    __toardTeamAttributionStarted?: true;
    __toardTeamAttributionRunning?: true;
  };
  if (state.__toardTeamAttributionStarted) return;
  state.__toardTeamAttributionStarted = true;
  const tick = () => {
    if (state.__toardTeamAttributionRunning) return;
    state.__toardTeamAttributionRunning = true;
    runTeamAttributionBatch().catch(() => {
      console.warn("[toard] team attribution worker tick failed; retrying later");
    }).finally(() => {
      state.__toardTeamAttributionRunning = undefined;
    });
  };
  setTimeout(tick, STARTUP_DELAY_MS).unref();
  setInterval(tick, TICK_MS).unref();
}
