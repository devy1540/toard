import type { Pool, PoolClient } from "pg";
import { getPool } from "./db";
import { legacyContentKeyConfigured } from "./legacy-content-crypto";

export type LegacyRetirementState =
  | "migrating"
  | "unsafe_key_missing"
  | "zero_observation_required"
  | "backup_policy_unconfigured"
  | "waiting_backup_retention"
  | "backup_confirmation_required"
  | "ready_to_remove_key"
  | "key_removed_unconfirmed"
  | "retired";

export type LegacyRetirementStateInput = {
  legacyRecords: number;
  zeroObservedAt: Date | null;
  backupConfirmedAt: Date | null;
  keyRetiredObservedAt: Date | null;
  retentionDays: number | null;
  kekConfigured: boolean;
  now: Date;
};

export type LegacyRetirementStatus = {
  state: LegacyRetirementState;
  legacyRecords: number;
  zeroObservedAt: string | null;
  retentionDays: number | null;
  eligibleAt: string | null;
  backupConfirmedAt: string | null;
  kekConfigured: boolean;
  keyRetiredObservedAt: string | null;
};

type QueryResultLike = { rows: Record<string, unknown>[]; rowCount?: number | null };
export type LegacyRetirementClient = {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
  release?(): void;
};
export type LegacyRetirementDatabase = { connect(): Promise<LegacyRetirementClient> };

type RetirementOptions = {
  db?: LegacyRetirementDatabase;
  env?: Record<string, string | undefined>;
  now?: Date;
  kekConfigured?: boolean;
};

export class LegacyRetirementError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacyRetirementError";
  }
}

export function parseLegacyBackupRetentionDays(env: Record<string, string | undefined>): number | null {
  const raw = env.TOARD_LEGACY_BACKUP_RETENTION_DAYS;
  if (raw === undefined || raw === "") return null;
  if (!/^\d+$/.test(raw)) throw new Error("TOARD_LEGACY_BACKUP_RETENTION_DAYS는 0~3650 정수여야 합니다");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 3_650) {
    throw new Error("TOARD_LEGACY_BACKUP_RETENTION_DAYS는 0~3650 정수여야 합니다");
  }
  return value;
}

export function deriveLegacyRetirementState(input: LegacyRetirementStateInput): {
  state: LegacyRetirementState;
  eligibleAt: Date | null;
} {
  if (input.legacyRecords > 0) {
    return { state: input.kekConfigured ? "migrating" : "unsafe_key_missing", eligibleAt: null };
  }
  if (!input.zeroObservedAt) return { state: "zero_observation_required", eligibleAt: null };
  if (input.retentionDays === null) return { state: "backup_policy_unconfigured", eligibleAt: null };
  const eligibleAt = new Date(input.zeroObservedAt.getTime() + input.retentionDays * 86_400_000);
  if (input.now < eligibleAt) return { state: "waiting_backup_retention", eligibleAt };
  if (!input.backupConfirmedAt) {
    return { state: input.kekConfigured ? "backup_confirmation_required" : "key_removed_unconfirmed", eligibleAt };
  }
  return {
    state: input.kekConfigured ? "ready_to_remove_key" : "retired",
    eligibleAt,
  };
}

export async function getLegacyRetirementStatus(options: RetirementOptions = {}): Promise<LegacyRetirementStatus> {
  return withTransaction(options.db ?? (getPool() as Pool), async (client) => {
    return reconcileStatus(client, runtime(options));
  });
}

export async function confirmLegacyBackupPurge(
  adminUserId: string,
  options: RetirementOptions = {},
): Promise<LegacyRetirementStatus> {
  if (!adminUserId) throw new LegacyRetirementError("INVALID_ADMIN_USER");
  const runtimeState = runtime(options);
  return withTransaction(options.db ?? (getPool() as Pool), async (client) => {
    const current = await reconcileStatus(client, runtimeState);
    if (current.state !== "backup_confirmation_required" && current.state !== "key_removed_unconfirmed") {
      throw new LegacyRetirementError("BACKUP_CONFIRMATION_NOT_READY");
    }
    await client.query(
      `UPDATE content_legacy_retirement
          SET backup_confirmed_at=$1, backup_confirmed_by=$2, updated_at=$1
        WHERE singleton=TRUE`,
      [runtimeState.now, adminUserId],
    );
    await insertEvent(client, "backup_confirmed", adminUserId, 0, runtimeState.now);
    return reconcileStatus(client, runtimeState);
  });
}

function runtime(options: RetirementOptions) {
  return {
    now: options.now ?? new Date(),
    retentionDays: parseLegacyBackupRetentionDays(options.env ?? process.env),
    kekConfigured:
      options.kekConfigured
      ?? legacyContentKeyConfigured(options.env ?? process.env),
  };
}

async function reconcileStatus(
  client: LegacyRetirementClient,
  runtimeState: { now: Date; retentionDays: number | null; kekConfigured: boolean },
): Promise<LegacyRetirementStatus> {
  const stateResult = await client.query(
    `SELECT legacy_records, zero_observed_at, backup_confirmed_at, key_retired_observed_at
       FROM content_legacy_retirement WHERE singleton=TRUE FOR UPDATE`,
  );
  const row = stateResult.rows[0];
  if (!row) throw new LegacyRetirementError("RETIREMENT_STATE_MISSING");
  const legacyRecords = asCount(row.legacy_records);
  let zeroObservedAt = asDateOrNull(row.zero_observed_at);
  let backupConfirmedAt = asDateOrNull(row.backup_confirmed_at);
  let keyRetiredObservedAt = asDateOrNull(row.key_retired_observed_at);

  if (legacyRecords > 0 && (zeroObservedAt || backupConfirmedAt || keyRetiredObservedAt)) {
    await client.query(
      `UPDATE content_legacy_retirement
          SET zero_observed_at=NULL, backup_confirmed_at=NULL, backup_confirmed_by=NULL,
              key_retired_observed_at=NULL, updated_at=$1
        WHERE singleton=TRUE`,
      [runtimeState.now],
    );
    await insertEvent(client, "zero_invalidated", null, legacyRecords, runtimeState.now);
    zeroObservedAt = null;
    backupConfirmedAt = null;
    keyRetiredObservedAt = null;
  } else if (legacyRecords === 0 && !zeroObservedAt) {
    await client.query(
      `UPDATE content_legacy_retirement
          SET zero_observed_at=$1, updated_at=$1
        WHERE singleton=TRUE`,
      [runtimeState.now],
    );
    await insertEvent(client, "zero_observed", null, 0, runtimeState.now);
    zeroObservedAt = runtimeState.now;
  }

  if (legacyRecords === 0 && backupConfirmedAt && !runtimeState.kekConfigured && !keyRetiredObservedAt) {
    await client.query(
      `UPDATE content_legacy_retirement
          SET key_retired_observed_at=$1, updated_at=$1
        WHERE singleton=TRUE`,
      [runtimeState.now],
    );
    await insertEvent(client, "key_retired_observed", null, 0, runtimeState.now);
    keyRetiredObservedAt = runtimeState.now;
  }

  const derived = deriveLegacyRetirementState({
    legacyRecords,
    zeroObservedAt,
    backupConfirmedAt,
    keyRetiredObservedAt,
    ...runtimeState,
  });
  return {
    state: derived.state,
    legacyRecords,
    zeroObservedAt: toIso(zeroObservedAt),
    retentionDays: runtimeState.retentionDays,
    eligibleAt: toIso(derived.eligibleAt),
    backupConfirmedAt: toIso(backupConfirmedAt),
    kekConfigured: runtimeState.kekConfigured,
    keyRetiredObservedAt: toIso(keyRetiredObservedAt),
  };
}

async function insertEvent(
  client: LegacyRetirementClient,
  type: string,
  actor: string | null,
  legacyRecords: number,
  at: Date,
) {
  await client.query(
    `INSERT INTO content_legacy_retirement_events
       (event_type, actor_user_id, legacy_records, created_at)
     VALUES($1,$2,$3,$4)`,
    [type, actor, legacyRecords, at],
  );
}

async function withTransaction<T>(db: LegacyRetirementDatabase, fn: (client: LegacyRetirementClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release?.();
  }
}

function asCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new LegacyRetirementError("INVALID_LEGACY_COUNT");
  return parsed;
}

function asDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new LegacyRetirementError("INVALID_RETIREMENT_DATE");
  return date;
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
