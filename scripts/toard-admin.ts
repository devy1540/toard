import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { createManagedContentRuntimeForDatabase } from "../apps/web/lib/managed-content-runtime";
import { closePool, getPool } from "../apps/web/lib/db";
import { loadKek } from "../apps/web/lib/legacy-content-crypto";
import {
  getProviderRewrapUsers,
  rewrapErrorCode,
  rewrapUserKey,
  type RewrapDb,
} from "../apps/web/lib/provider-rewrap";
import {
  getServerContentMigrationUsers,
  migrateServerContentBatch,
  ServerContentMigrationError,
} from "../apps/web/lib/server-content-migration";
import type { KeyProviderName } from "../apps/web/lib/key-management/types";
import {
  evaluateProviderRemovalReadiness,
  parseManagedKeyDistribution,
  type ManagedKeyDistributionEntry,
  type ProviderDistributionIdentity,
  type ProviderRemovalReadiness,
} from "../apps/web/lib/managed-key-distribution";
import { recordKeySecurityEvent } from "../apps/web/lib/key-management/observability";
import { assertManagedContentDatabaseRoleReady } from "../apps/web/lib/content-database-role-readiness";

const PROVIDERS = new Set<KeyProviderName>([
  "local", "aws-kms", "gcp-kms", "azure-key-vault", "vault-transit", "openbao-transit",
]);
const USAGE = "Usage: toard-admin encryption status | encryption migrate-server --batch-size <1..25> | encryption rewrap-provider --from <provider> --to <provider> --actor-user-id <UUID>";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_SERVER_CODES = new Set([
  "INVALID_LEGACY_KEK", "INVALID_LIMIT", "INVALID_USER_ID", "LEGACY_SOURCE_CORRUPT",
  "MANAGED_ROUND_TRIP_FAILED", "MANAGED_USER_KEY_INVALID", "SERVER_CONTENT_MIGRATION_FAILED",
  "SERVER_CONTENT_USER_ENUMERATION_FAILED", "SOURCE_CHANGED",
]);
const SAFE_REWRAP_CODES = new Set([
  "ACTIVE_WRAPPER_CHANGED", "ACTIVE_WRAPPER_INVALID", "ACTIVE_WRAPPER_MISSING",
  "CACHE_EVICTION_UNAVAILABLE", "INVALID_PROVIDER_FILTER", "INVALID_USER_ID",
  "MANAGED_CANARY_INVALID", "MANAGED_CANARY_MISSING", "MIGRATION_PROVIDER_MISSING",
  "PENDING_WRAPPER_CONFLICT", "PENDING_WRAPPER_INVALID", "PENDING_WRAPPER_MISMATCH",
  "PENDING_WRAPPER_PLAINTEXT",
  "REWRAP_FAILED", "REWRAP_ROW_INVALID", "REWRAP_USER_ENUMERATION_FAILED",
]);

export type AdminCliDependencies = {
  runtime(db: RewrapDb): Promise<ManagedContentRuntime | null>;
  acquireDb(): Promise<AdminDbLease>;
  assertManagedContentDatabaseRoleReady(db: RewrapDb): Promise<void>;
  loadLegacyKek(): Buffer;
  migrateServerBatch(
    userId: string,
    batchSize: number,
    runtime: ManagedContentRuntime,
    legacyKek: Buffer,
    db: RewrapDb,
  ): Promise<{ migrated: number; remaining: number }>;
  rewrapUser(
    userId: string,
    runtime: ManagedContentRuntime,
    db: RewrapDb,
  ): Promise<{ state: "already-current" | "migrated" }>;
  close(): Promise<void>;
  signal?: AbortSignal;
};

export type AdminDbLease = {
  db: RewrapDb;
  release(): void | Promise<void>;
};

type PoolConnector = {
  connect(): Promise<RewrapDb & { release(): void }>;
};

export type CliResult = { exitCode: 0 | 1 | 2; stdout: string; stderr: string };

const defaultDependencies: AdminCliDependencies = {
  runtime: createManagedContentRuntimeForDatabase,
  acquireDb: () => createPoolLeaseFactory(getPool())(),
  assertManagedContentDatabaseRoleReady,
  loadLegacyKek: loadKek,
  migrateServerBatch: migrateServerContentBatch,
  rewrapUser: rewrapUserKey,
  close: closePool,
};

export async function runCli(
  argv: readonly string[],
  deps: AdminCliDependencies = defaultDependencies,
): Promise<CliResult> {
  const parsed = parseCommand(argv);
  if (!parsed) return usage();
  try {
    switch (parsed.command) {
      case "status":
        return await encryptionStatus(deps);
      case "migrate-server":
        return await migrateServer(parsed.batchSize, deps);
      case "rewrap-provider":
        return await rewrapProviders(parsed.from, parsed.to, parsed.actorUserId, deps);
    }
  } catch {
    return { exitCode: 1, stdout: "", stderr: "ADMIN_COMMAND_FAILED\n" };
  }
}

type ParsedCommand =
  | { command: "status" }
  | { command: "migrate-server"; batchSize: number }
  | { command: "rewrap-provider"; from: KeyProviderName; to: KeyProviderName; actorUserId: string };

function parseCommand(argv: readonly string[]): ParsedCommand | null {
  const [group, command, ...args] = argv;
  if (group !== "encryption") return null;
  if (command === "status") return args.length === 0 ? { command } : null;
  if (command === "migrate-server") {
    if (args.length !== 2 || args[0] !== "--batch-size") return null;
    const rawBatchSize = args[1]!;
    if (!/^(?:[1-9]|1[0-9]|2[0-5])$/.test(rawBatchSize)) return null;
    const batchSize = Number(rawBatchSize);
    return Number.isSafeInteger(batchSize)
      ? { command, batchSize }
      : null;
  }
  if (command === "rewrap-provider") {
    if (
      args.length !== 6
      || args[0] !== "--from"
      || args[2] !== "--to"
      || args[4] !== "--actor-user-id"
    ) return null;
    const from = args[1], to = args[3], actorUserId = args[5];
    if (!isProvider(from) || !isProvider(to) || !actorUserId || !UUID.test(actorUserId)) return null;
    return { command, from, to, actorUserId };
  }
  return null;
}

type CliEncryptionSnapshot = {
  activeUserKeys: number;
  e2eeRecords: number;
  managedRecords: number;
  pendingUserKeys: number;
  retiringUserKeys: number;
  serverRecords: number;
  wrapperDistribution: ManagedKeyDistributionEntry[];
  providerMigration: ProviderRemovalReadiness;
};

async function encryptionStatus(deps: AdminCliDependencies): Promise<CliResult> {
  const snapshot = await withDbLease(deps, async (db) => {
    const runtime = await requireRuntimeForStatus(deps, db);
    return loadCliEncryptionSnapshot(db, runtime);
  });
  return { exitCode: 0, stdout: `${JSON.stringify(snapshot)}\n`, stderr: "" };
}

async function loadCliEncryptionSnapshot(
  db: RewrapDb,
  runtime: ManagedContentRuntime | null,
): Promise<CliEncryptionSnapshot> {
  const result = await db.query(
    `SELECT server_records,e2ee_records,managed_records,
            active_user_keys,pending_user_keys,retiring_user_keys,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'provider',distribution.provider,
                'provider_fingerprint',distribution.provider_fingerprint,
                'state',distribution.state,
                'wrapper_count',distribution.wrapper_count::text
              ) ORDER BY distribution.provider,distribution.provider_fingerprint,distribution.state)
              FROM managed_content_key_distribution distribution
            ),'[]'::jsonb) AS wrapper_distribution
       FROM content_encryption_status WHERE singleton=TRUE`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("STATUS_MISSING");
  const activeUserKeys = count(row.active_user_keys);
  const pendingUserKeys = count(row.pending_user_keys);
  const retiringUserKeys = count(row.retiring_user_keys);
  const wrapperDistribution = parseManagedKeyDistribution(row.wrapper_distribution);
  const totals = distributionTotals(wrapperDistribution);
  if (
    totals.active !== activeUserKeys
    || totals.pending !== pendingUserKeys
    || totals.retiring !== retiringUserKeys
  ) throw new Error("INVALID_STATUS");
  const oldIdentity = runtime ? providerIdentity(runtime.registry.active) : null;
  const targetIdentity = runtime?.registry.migration
    ? providerIdentity(runtime.registry.migration)
    : null;
  return {
    activeUserKeys,
    e2eeRecords: count(row.e2ee_records),
    managedRecords: count(row.managed_records),
    pendingUserKeys,
    retiringUserKeys,
    serverRecords: count(row.server_records),
    wrapperDistribution,
    providerMigration: evaluateProviderRemovalReadiness(
      wrapperDistribution,
      oldIdentity,
      targetIdentity,
    ),
  };
}

async function migrateServer(batchSize: number, deps: AdminCliDependencies): Promise<CliResult> {
  const { runtime, users } = await withDbLease(deps, async (db) => ({
    runtime: await requireRuntime(deps, db),
    users: (await getServerContentMigrationUsers(db)).sort(),
  }));
  let kek: Buffer | undefined;
  const failures: string[] = [];
  let migrated = 0;
  try {
    kek = deps.loadLegacyKek();
    if (!Buffer.isBuffer(kek) || kek.length !== 32) throw new Error("INVALID_KEK");
    let interrupted = false;
    for (const userId of users) {
      if (deps.signal?.aborted) { failures.push(`${userId} INTERRUPTED`); break; }
      try {
        let previousRemaining: number | null = null;
        for (;;) {
          const result = await withDbLease(deps, (db) =>
            deps.migrateServerBatch(userId, batchSize, runtime, kek!, db));
          if (
            !Number.isSafeInteger(result.migrated) || result.migrated < 0
            || !Number.isSafeInteger(result.remaining) || result.remaining < 0
          ) throw new Error("INVALID_MIGRATION_RESULT");
          migrated += result.migrated;
          if (deps.signal?.aborted) {
            failures.push(`${userId} INTERRUPTED`);
            interrupted = true;
            break;
          }
          if (result.remaining === 0) break;
          if (
            result.migrated === 0
            || (previousRemaining !== null && result.remaining >= previousRemaining)
          ) {
            failures.push(`${userId} ZERO_PROGRESS`);
            break;
          }
          previousRemaining = result.remaining;
        }
      } catch (error) {
        failures.push(`${userId} ${safeServerCode(error)}`);
      }
      if (interrupted) break;
    }
  } finally {
    kek?.fill(0);
  }
  return summary("migrated", migrated, failures);
}

async function rewrapProviders(
  from: KeyProviderName,
  to: KeyProviderName,
  actorUserId: string,
  deps: AdminCliDependencies,
): Promise<CliResult> {
  const runtime = await withDbLease(deps, (db) => requireRuntime(deps, db));
  const target = runtime.registry.migration;
  const oldIdentity = providerIdentity(runtime.registry.active);
  const targetIdentity = target ? providerIdentity(target) : null;
  const appInstanceId = runtime.installationId;
  if (typeof appInstanceId !== "string" || !UUID.test(appInstanceId)) {
    throw new Error("INVALID_APP_INSTANCE_ID");
  }
  if (
    oldIdentity.provider !== from
    || !targetIdentity
    || targetIdentity.provider !== to
    || targetIdentity.providerFingerprint === oldIdentity.providerFingerprint
  ) return usage();

  // 시작 audit은 새 writer의 durable fence다. 따라서 zero-wrapper migration도
  // target의 wrap/unwrap canary가 healthy임을 먼저 확인해야 한다.
  const targetHealth = await runtime.health.check(target);
  if (targetHealth.status !== "healthy") {
    throw new Error("PROVIDER_MIGRATION_TARGET_CANARY_FAILED");
  }

  await withDbLease(deps, (db) => recordProviderMigrationEvent(
    "provider_migration_started", actorUserId, targetIdentity, appInstanceId, db,
  ));
  if (deps.signal?.aborted) return summary("migrated", 0, ["INTERRUPTED"]);

  const users = await withDbLease(
    deps,
    (db) => getProviderRewrapUsers(from, oldIdentity.providerFingerprint, db),
  );
  const failures: string[] = [];
  if (deps.signal?.aborted) failures.push("INTERRUPTED");
  let migrated = 0;
  for (const userId of failures.length === 0 ? users : []) {
    if (deps.signal?.aborted) { failures.push("INTERRUPTED"); break; }
    try {
      const result = await withDbLease(deps, (db) => deps.rewrapUser(userId, runtime, db));
      if (result.state === "migrated") migrated += 1;
      if (deps.signal?.aborted) {
        failures.push("INTERRUPTED");
        break;
      }
    } catch (error) {
      const code = rewrapErrorCode(error);
      failures.push(code && SAFE_REWRAP_CODES.has(code) ? code : "REWRAP_FAILED");
    }
  }
  if (failures.length === 0) {
    if (deps.signal?.aborted) failures.push("INTERRUPTED");
    else failures.push(...await withDbLease(deps, (db) => completeProviderMigration(
      actorUserId,
      oldIdentity,
      targetIdentity,
      appInstanceId,
      deps.signal,
      db,
    )));
  }
  return summary("migrated", migrated, failures);
}

async function completeProviderMigration(
  actorUserId: string,
  oldIdentity: ProviderDistributionIdentity,
  targetIdentity: ProviderDistributionIdentity,
  appInstanceId: string,
  signal: AbortSignal | undefined,
  db: RewrapDb,
): Promise<string[]> {
  let began = false;
  let finished = false;
  const stop = async (reason: string): Promise<string[]> => {
    await db.query("ROLLBACK");
    finished = true;
    return [reason];
  };
  try {
    await db.query("BEGIN");
    began = true;
    await setAndValidateAdminActor(actorUserId, db);
    if (signal?.aborted) return await stop("INTERRUPTED");

    // migration 39 trigger writer와 같은 canonical advisory lock을 잡은 뒤 분포를 새로 읽는다.
    await db.query("SELECT lock_managed_content_key_distribution()");
    if (signal?.aborted) return await stop("INTERRUPTED");
    const distributionResult = await db.query(
      `SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'provider',distribution.provider,
                'provider_fingerprint',distribution.provider_fingerprint,
                'state',distribution.state,
                'wrapper_count',distribution.wrapper_count::text
              ) ORDER BY distribution.provider,distribution.provider_fingerprint,distribution.state),'[]'::jsonb)
              AS wrapper_distribution
         FROM managed_content_key_distribution distribution`,
    );
    if (signal?.aborted) return await stop("INTERRUPTED");
    if (distributionResult.rows.length !== 1) throw new Error("INVALID_DISTRIBUTION");
    const distribution = parseManagedKeyDistribution(distributionResult.rows[0]?.wrapper_distribution);
    const readiness = evaluateProviderRemovalReadiness(
      distribution,
      oldIdentity,
      targetIdentity,
    );
    if (!readiness.removalReady) return await stop("PROVIDER_MIGRATION_NOT_READY");
    if (signal?.aborted) return await stop("INTERRUPTED");

    await insertProviderMigrationEvent(
      "provider_migration_completed",
      actorUserId,
      targetIdentity,
      appInstanceId,
      db,
    );
    if (signal?.aborted) return await stop("INTERRUPTED");
    await db.query("COMMIT");
    finished = true;
    return [];
  } catch {
    if (began && !finished) await db.query("ROLLBACK").catch(() => undefined);
    throw new Error("PROVIDER_MIGRATION_AUDIT_FAILED");
  }
}

async function recordProviderMigrationEvent(
  eventType: "provider_migration_started",
  actorUserId: string,
  target: ProviderDistributionIdentity,
  appInstanceId: string,
  db: RewrapDb,
): Promise<void> {
  let began = false;
  try {
    await db.query("BEGIN");
    began = true;
    // 신규 UCK writer가 잡는 lock과 같은 transaction lock 뒤에 durable fence를 기록한다.
    await db.query("SELECT lock_managed_content_key_distribution()");
    await setAndValidateAdminActor(actorUserId, db);
    await insertProviderMigrationEvent(eventType, actorUserId, target, appInstanceId, db);
    await db.query("COMMIT");
  } catch {
    if (began) await db.query("ROLLBACK").catch(() => undefined);
    throw new Error("PROVIDER_MIGRATION_AUDIT_FAILED");
  }
}

// actorUserId는 CLI operator가 인프라 접근통제 아래 지정하는 approval subject다. 이 CLI는
// 호출자의 인증 identity를 증명하지 않으며, 실제 operator attribution은 workload/orchestration audit에 둔다.
async function setAndValidateAdminActor(actorUserId: string, db: RewrapDb): Promise<void> {
  await db.query("SELECT set_config('app.current_user_id',$1,true)", [actorUserId]);
  const actor = await db.query(
    "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='admin') AS is_admin",
    [actorUserId],
  );
  if (actor.rows.length !== 1 || actor.rows[0]?.is_admin !== true) {
    throw new Error("ADMIN_ACTOR_INVALID");
  }
}

async function insertProviderMigrationEvent(
  eventType: "provider_migration_started" | "provider_migration_completed",
  actorUserId: string,
  target: ProviderDistributionIdentity,
  appInstanceId: string,
  db: RewrapDb,
): Promise<void> {
  await recordKeySecurityEvent({
    eventType,
    userId: null,
    provider: target.provider,
    providerFingerprint: target.providerFingerprint,
    keyVersion: null,
    actorUserId,
    appInstanceId,
  }, db);
}

function summary(label: string, succeeded: number, failures: string[]): CliResult {
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    stdout: `${label}=${succeeded} failed=${failures.length}\n`,
    stderr: failures.length === 0 ? "" : `${failures.join("\n")}\n`,
  };
}

async function requireRuntime(
  deps: AdminCliDependencies,
  db: RewrapDb,
): Promise<ManagedContentRuntime> {
  const runtime = await deps.runtime(db);
  if (!runtime) throw new Error("MANAGED_RUNTIME_MISSING");
  return runtime;
}

async function requireRuntimeForStatus(
  deps: AdminCliDependencies,
  db: RewrapDb,
): Promise<ManagedContentRuntime | null> {
  return deps.runtime(db);
}

function safeServerCode(error: unknown): string {
  return error instanceof ServerContentMigrationError && SAFE_SERVER_CODES.has(error.code)
    ? error.code
    : "SERVER_MIGRATION_FAILED";
}

function isProvider(value: string | undefined): value is KeyProviderName {
  return typeof value === "string" && PROVIDERS.has(value as KeyProviderName);
}

function count(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("INVALID_STATUS");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("INVALID_STATUS");
  return parsed;
}

function providerIdentity(provider: ManagedContentRuntime["registry"]["active"]): ProviderDistributionIdentity {
  const name = provider.name;
  const fingerprint = provider.fingerprint;
  if (
    !PROVIDERS.has(name)
    || typeof fingerprint !== "string"
    || !new RegExp(`^${name}:[0-9a-f]{24}$`).test(fingerprint)
  ) throw new Error("INVALID_PROVIDER_IDENTITY");
  return { provider: name, providerFingerprint: fingerprint };
}

function distributionTotals(distribution: readonly ManagedKeyDistributionEntry[]): Record<"active" | "pending" | "retiring", number> {
  const totals = { active: 0, pending: 0, retiring: 0 };
  for (const entry of distribution) {
    const next = totals[entry.state] + entry.count;
    if (!Number.isSafeInteger(next)) throw new Error("INVALID_STATUS");
    totals[entry.state] = next;
  }
  return totals;
}

function usage(): CliResult {
  return { exitCode: 2, stdout: "", stderr: `${USAGE}\n` };
}

export function createPoolLeaseFactory(pool: PoolConnector): AdminCliDependencies["acquireDb"] {
  return async () => {
    const client = await pool.connect();
    let released = false;
    return {
      db: client,
      release() {
        if (released) return;
        released = true;
        client.release();
      },
    };
  };
}

async function withDbLease<T>(
  deps: Pick<AdminCliDependencies, "acquireDb" | "assertManagedContentDatabaseRoleReady">,
  fn: (db: RewrapDb) => Promise<T>,
): Promise<T> {
  const lease = await deps.acquireDb();
  try {
    await deps.assertManagedContentDatabaseRoleReady(lease.db);
    return await fn(lease.db);
  } finally {
    await lease.release();
  }
}

async function main(): Promise<void> {
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  try {
    const result = await runCli(process.argv.slice(2), { ...defaultDependencies, signal: abort.signal });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", onSignal);
    await defaultDependencies.close().catch(() => undefined);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch(async () => {
    process.stderr.write("ADMIN_COMMAND_FAILED\n");
    process.exitCode = 1;
    await defaultDependencies.close().catch(() => undefined);
  });
}
