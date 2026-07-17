import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { getManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
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

const PROVIDERS = new Set<KeyProviderName>([
  "local", "aws-kms", "gcp-kms", "azure-key-vault", "vault-transit", "openbao-transit",
]);
const USAGE = "Usage: toard-admin encryption status | encryption migrate-server --batch-size <1..25> | encryption rewrap-provider --from <provider> --to <provider>";
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
  runtime(): Promise<ManagedContentRuntime | null>;
  acquireDb(): Promise<AdminDbLease>;
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
  runtime: getManagedContentRuntime,
  acquireDb: () => createPoolLeaseFactory(getPool())(),
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
        return await withDbLease(deps, status);
      case "migrate-server":
        return await migrateServer(parsed.batchSize, deps);
      case "rewrap-provider":
        return await rewrapProviders(parsed.from, parsed.to, deps);
    }
  } catch {
    return { exitCode: 1, stdout: "", stderr: "ADMIN_COMMAND_FAILED\n" };
  }
}

type ParsedCommand =
  | { command: "status" }
  | { command: "migrate-server"; batchSize: number }
  | { command: "rewrap-provider"; from: KeyProviderName; to: KeyProviderName };

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
    if (args.length !== 4 || args[0] !== "--from" || args[2] !== "--to") return null;
    const from = args[1], to = args[3];
    if (!isProvider(from) || !isProvider(to) || from === to) return null;
    return { command, from, to };
  }
  return null;
}

async function status(db: RewrapDb): Promise<CliResult> {
  const result = await db.query(
    `SELECT server_records,e2ee_records,managed_records,
            active_user_keys,pending_user_keys,retiring_user_keys
       FROM content_encryption_status WHERE singleton=TRUE`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("STATUS_MISSING");
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      activeUserKeys: count(row.active_user_keys),
      e2eeRecords: count(row.e2ee_records),
      managedRecords: count(row.managed_records),
      pendingUserKeys: count(row.pending_user_keys),
      retiringUserKeys: count(row.retiring_user_keys),
      serverRecords: count(row.server_records),
    })}\n`,
    stderr: "",
  };
}

async function migrateServer(batchSize: number, deps: AdminCliDependencies): Promise<CliResult> {
  const runtime = await requireRuntime(deps);
  let kek: Buffer | undefined;
  const failures: string[] = [];
  let migrated = 0;
  try {
    kek = deps.loadLegacyKek();
    if (!Buffer.isBuffer(kek) || kek.length !== 32) throw new Error("INVALID_KEK");
    const users = (await withDbLease(deps, getServerContentMigrationUsers)).sort();
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
  deps: AdminCliDependencies,
): Promise<CliResult> {
  const runtime = await requireRuntime(deps);
  const target = runtime.registry.migration;
  if (
    runtime.registry.active.name !== from
    || !target
    || target.name !== to
  ) return usage();

  const users = await withDbLease(
    deps,
    (db) => getProviderRewrapUsers(from, runtime.registry.active.fingerprint, db),
  );
  const failures: string[] = [];
  let migrated = 0;
  for (const userId of users) {
    if (deps.signal?.aborted) { failures.push(`${userId} INTERRUPTED`); break; }
    try {
      const result = await withDbLease(deps, (db) => deps.rewrapUser(userId, runtime, db));
      if (result.state === "migrated") migrated += 1;
    } catch (error) {
      const code = rewrapErrorCode(error);
      failures.push(`${userId} ${code && SAFE_REWRAP_CODES.has(code) ? code : "REWRAP_FAILED"}`);
    }
  }
  return summary("migrated", migrated, failures);
}

function summary(label: string, succeeded: number, failures: string[]): CliResult {
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    stdout: `${label}=${succeeded} failed=${failures.length}\n`,
    stderr: failures.length === 0 ? "" : `${failures.join("\n")}\n`,
  };
}

async function requireRuntime(deps: AdminCliDependencies): Promise<ManagedContentRuntime> {
  const runtime = await deps.runtime();
  if (!runtime) throw new Error("MANAGED_RUNTIME_MISSING");
  return runtime;
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
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("INVALID_STATUS");
  return parsed;
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
  deps: Pick<AdminCliDependencies, "acquireDb">,
  fn: (db: RewrapDb) => Promise<T>,
): Promise<T> {
  const lease = await deps.acquireDb();
  try {
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
