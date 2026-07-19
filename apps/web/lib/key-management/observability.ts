import { getPool } from "../db";
import { inspectProviderError } from "./provider-error";
import type {
  CredentialSourceSummary,
  KeyContext,
  KeyManagementProvider,
  KeyProviderHealth,
  KeyProviderName,
  WrappedUserKey,
} from "./types";

export type KeyOperation = "wrap" | "unwrap" | "health";
export type KeyOperationOutcome =
  | "success"
  | "throttled"
  | "unavailable"
  | "auth"
  | "invalid";
export type KeyCacheResult = "none" | "hit" | "miss" | "single_flight";

export type KeyOperationEvent = Readonly<{
  provider: KeyProviderName;
  fingerprint: string;
  operation: KeyOperation;
  outcome: KeyOperationOutcome;
  /** Provider calls omit this and are stored as `none`; KMS cost queries must filter `cache_result='none'`. */
  cacheResult?: KeyCacheResult;
  latencyMs: number;
}>;

export type CacheResultEvent = Readonly<{
  provider: KeyProviderName;
  fingerprint: string;
  operation: KeyOperation;
  /** Lookup-only row. These non-none outcomes are request/cache diagnostics, not billable KMS calls. */
  cacheResult: Exclude<KeyCacheResult, "none">;
}>;

export type KeyOperationRecorder = {
  record(event: KeyOperationEvent): Promise<void>;
};

export type KeySecurityEventType =
  | "user_key_created"
  | "user_key_rewrapped"
  | "provider_migration_started"
  | "provider_migration_completed"
  | "e2ee_migration_blocked"
  | "e2ee_migration_resumed";

// provider_migration_* records an explicit CLI approval subject in RLS. toard-admin
// rewrap-provider receives --actor-user-id from an infrastructure-controlled operator and
// validates that subject's current admin row; it does not authenticate the CLI operator.
// Actual operator attribution belongs to the content-admin workload and external orchestration audit.
// Completion is emitted only after
// the migration-39 distribution lock and readiness proof succeed in the same transaction.

/** Exact, secret-free audit DTO. Nulls are intentional and shape-dependent. */
export type KeySecurityEvent = Readonly<{
  eventType: KeySecurityEventType;
  userId: string | null;
  provider: KeyProviderName | null;
  providerFingerprint: string | null;
  keyVersion: number | null;
  actorUserId: string | null;
  appInstanceId: string;
}>;

export type KeySecurityEventRecorder = (
  event: KeySecurityEvent,
  db: KeyOperationDatabase,
) => Promise<void>;

export type KeyOperationDatabase = {
  query(sql: string, params: unknown[]): Promise<unknown>;
};

const PROVIDERS = new Set<KeyProviderName>([
  "local",
  "aws-kms",
  "gcp-kms",
  "azure-key-vault",
  "vault-transit",
  "openbao-transit",
]);
const OPERATIONS = new Set<KeyOperation>(["wrap", "unwrap", "health"]);
const OUTCOMES = new Set<KeyOperationOutcome>([
  "success", "throttled", "unavailable", "auth", "invalid",
]);
const CACHE_RESULTS = new Set<KeyCacheResult>([
  "none", "hit", "miss", "single_flight",
]);
const PROVIDER_ERROR_CODES = new Set([
  "THROTTLED",
  "AUTH_FAILED",
  "TEMPORARY",
  "FAILED",
  "KEY_NOT_FOUND",
  "KEY_DISABLED",
  "KEY_INVALID_STATE",
  "KEY_MISMATCH",
  "WRAPPER_MISMATCH",
  "INVALID_CIPHERTEXT",
  "INVALID_PLAINTEXT",
  "INVALID_CONTEXT",
  "EMPTY_CIPHERTEXT",
  "EMPTY_PLAINTEXT",
  "RESPONSE_INVALID",
]);
const INVALID_CODES = new Set([
  "WRAPPER_MISMATCH",
  "INVALID_CIPHERTEXT",
  "INVALID_PLAINTEXT",
  "INVALID_CONTEXT",
  "EMPTY_CIPHERTEXT",
  "EMPTY_PLAINTEXT",
  "KEY_MISMATCH",
  "RESPONSE_INVALID",
]);
const MAX_LATENCY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const defaultRecorder: KeyOperationRecorder = Object.freeze({
  record: recordKeyOperation,
});

function validProvider(value: unknown): value is KeyProviderName {
  return typeof value === "string" && PROVIDERS.has(value as KeyProviderName);
}

function validFingerprint(provider: KeyProviderName, value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 128
    && new RegExp(`^${provider}:[0-9a-f]{24}$`).test(value);
}

function safeLatency(value: number): number {
  if (!Number.isFinite(value)) return MAX_LATENCY_MS;
  return Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(value)));
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function safeOutcome(provider: KeyProviderName, error: unknown): KeyOperationOutcome {
  try {
    if (
      provider === "local"
      && error instanceof Error
      && [
        "LOCAL_KEY_WRAPPER_MISMATCH",
        "LOCAL_KEY_CIPHERTEXT_INVALID",
        "LOCAL_KEY_CONTEXT_OR_CIPHERTEXT_INVALID",
      ].includes(error.message)
    ) {
      return "invalid";
    }
    const code = inspectProviderError(error, provider, PROVIDER_ERROR_CODES);
    return outcomeFromCode(code);
  } catch {
    return "unavailable";
  }
}

function outcomeFromCode(code: string | null): KeyOperationOutcome {
  if (code === "THROTTLED") return "throttled";
  if (code === "AUTH_FAILED") return "auth";
  if (code && INVALID_CODES.has(code)) return "invalid";
  return "unavailable";
}

function dispatchRecorder(
  recorder: KeyOperationRecorder,
  event: KeyOperationEvent,
): void {
  try {
    void Promise.resolve(recorder.record(Object.freeze(event))).catch(() => undefined);
  } catch {
    // Observability is fail-open relative to the cryptographic operation.
  }
}

export class ObservedKeyManagementProvider implements KeyManagementProvider {
  readonly name!: KeyProviderName;
  readonly keyRef!: string;
  readonly fingerprint!: string;
  private readonly inner: KeyManagementProvider;
  private readonly recorder: KeyOperationRecorder;
  private readonly now: () => number;

  constructor(
    inner: KeyManagementProvider,
    options: {
      recorder?: KeyOperationRecorder;
      now?: () => number;
    } = {},
  ) {
    // Read identity getters once; registry identity and metrics use this immutable snapshot.
    let name: KeyProviderName;
    let keyRef: string;
    let fingerprint: string;
    try {
      const candidateName = inner.name;
      const candidateKeyRef = inner.keyRef;
      const candidateFingerprint = inner.fingerprint;
      if (
        !validProvider(candidateName)
        || typeof candidateKeyRef !== "string"
        || candidateKeyRef.length < 1
        || candidateKeyRef.length > 2_048
        || !validFingerprint(candidateName, candidateFingerprint)
      ) {
        throw new Error("invalid");
      }
      name = candidateName;
      keyRef = candidateKeyRef;
      fingerprint = candidateFingerprint;
    } catch {
      throw new Error("KEY_OPERATION_IDENTITY_INVALID");
    }
    Object.defineProperties(this, {
      name: { value: name, enumerable: true, writable: false, configurable: false },
      keyRef: { value: keyRef, enumerable: true, writable: false, configurable: false },
      fingerprint: { value: fingerprint, enumerable: true, writable: false, configurable: false },
    });
    this.inner = inner;
    this.recorder = options.recorder ?? defaultRecorder;
    this.now = options.now ?? Date.now;
  }

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    return this.observe("wrap", () => this.inner.wrapKey(uck, context));
  }

  async unwrapKey(wrapped: WrappedUserKey, context: KeyContext): Promise<Buffer> {
    return this.observe("unwrap", () => this.inner.unwrapKey(wrapped, context));
  }

  async healthCheck(): Promise<KeyProviderHealth> {
    const startedAt = safeNow(this.now);
    try {
      const result = await this.inner.healthCheck();
      dispatchRecorder(this.recorder, {
        provider: this.name,
        fingerprint: this.fingerprint,
        operation: "health",
        outcome: result.status === "healthy"
          ? "success"
          : outcomeFromCode(PROVIDER_ERROR_CODES.has(result.errorCode) ? result.errorCode : null),
        latencyMs: safeLatency(safeNow(this.now) - startedAt),
      });
      return result;
    } catch (error) {
      dispatchRecorder(this.recorder, {
        provider: this.name,
        fingerprint: this.fingerprint,
        operation: "health",
        outcome: safeOutcome(this.name, error),
        latencyMs: safeLatency(safeNow(this.now) - startedAt),
      });
      throw error;
    }
  }

  describeCredentialSource(): Promise<CredentialSourceSummary> {
    return this.inner.describeCredentialSource();
  }

  private async observe<T>(operation: "wrap" | "unwrap", run: () => Promise<T>): Promise<T> {
    const startedAt = safeNow(this.now);
    try {
      const result = await run();
      dispatchRecorder(this.recorder, {
        provider: this.name,
        fingerprint: this.fingerprint,
        operation,
        outcome: "success",
        latencyMs: safeLatency(safeNow(this.now) - startedAt),
      });
      return result;
    } catch (error) {
      dispatchRecorder(this.recorder, {
        provider: this.name,
        fingerprint: this.fingerprint,
        operation,
        outcome: safeOutcome(this.name, error),
        latencyMs: safeLatency(safeNow(this.now) - startedAt),
      });
      throw error;
    }
  }
}

function snapshotEvent(event: KeyOperationEvent): Required<KeyOperationEvent> {
  try {
    const allowedKeys = new Set(["provider", "fingerprint", "operation", "outcome", "cacheResult", "latencyMs"]);
    const keys = Reflect.ownKeys(event);
    if (keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      throw new Error("KEY_OPERATION_EVENT_INVALID");
    }
    const values = Object.fromEntries(keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(event, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("KEY_OPERATION_EVENT_INVALID");
      }
      return [key, descriptor.value];
    })) as Record<string, unknown>;
    const provider = values.provider;
    const fingerprint = values.fingerprint;
    const operation = values.operation;
    const outcome = values.outcome;
    const cacheResult = values.cacheResult ?? "none";
    const latencyMs = values.latencyMs;
    if (
      !validProvider(provider)
      || !validFingerprint(provider, fingerprint)
      || typeof operation !== "string"
      || !OPERATIONS.has(operation as KeyOperation)
      || typeof outcome !== "string"
      || !OUTCOMES.has(outcome as KeyOperationOutcome)
      || typeof cacheResult !== "string"
      || !CACHE_RESULTS.has(cacheResult as KeyCacheResult)
      || typeof latencyMs !== "number"
      || !Number.isFinite(latencyMs)
      || latencyMs < 0
      || latencyMs > MAX_LATENCY_MS
    ) {
      throw new Error("KEY_OPERATION_EVENT_INVALID");
    }
    return {
      provider,
      fingerprint,
      operation: operation as KeyOperation,
      outcome: outcome as KeyOperationOutcome,
      cacheResult: cacheResult as KeyCacheResult,
      latencyMs,
    };
  } catch {
    throw new Error("KEY_OPERATION_EVENT_INVALID");
  }
}

export async function recordKeyOperation(
  event: KeyOperationEvent,
  db: KeyOperationDatabase = getPool(),
): Promise<void> {
  const snapshot = snapshotEvent(event);
  try {
    await db.query(
      `INSERT INTO content_key_operation_daily
         (day,provider,provider_fingerprint,operation,outcome,cache_result,
          operation_count,total_latency_ms)
       VALUES(CURRENT_DATE,$1,$2,$3,$4,$5,1,$6)
       ON CONFLICT(day,provider,provider_fingerprint,operation,outcome,cache_result)
       DO UPDATE SET
         operation_count=content_key_operation_daily.operation_count+1,
         total_latency_ms=content_key_operation_daily.total_latency_ms+EXCLUDED.total_latency_ms`,
      [
        snapshot.provider,
        snapshot.fingerprint,
        snapshot.operation,
        snapshot.outcome,
        snapshot.cacheResult,
        Math.round(snapshot.latencyMs),
      ],
    );
  } catch {
    throw new Error("KEY_OPERATION_RECORD_FAILED");
  }
}

export async function recordCacheResult(event: CacheResultEvent): Promise<void> {
  await recordKeyOperation({
    provider: event.provider,
    fingerprint: event.fingerprint,
    operation: event.operation,
    outcome: "success",
    cacheResult: event.cacheResult,
    latencyMs: 0,
  });
}

function snapshotSecurityEvent(event: KeySecurityEvent): KeySecurityEvent {
  try {
    const expectedKeys = [
      "eventType", "userId", "provider", "providerFingerprint",
      "keyVersion", "actorUserId", "appInstanceId",
    ];
    const keys = Reflect.ownKeys(event);
    if (
      keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) throw new Error("invalid");
    const values = Object.fromEntries(keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(event, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("invalid");
      return [key, descriptor.value];
    })) as Record<string, unknown>;
    const eventType = values.eventType;
    const userId = values.userId;
    const provider = values.provider;
    const providerFingerprint = values.providerFingerprint;
    const keyVersion = values.keyVersion;
    const actorUserId = values.actorUserId;
    const appInstanceId = values.appInstanceId;
    if (
      typeof eventType !== "string"
      || ![
        "user_key_created", "user_key_rewrapped",
        "provider_migration_started", "provider_migration_completed",
        "e2ee_migration_blocked", "e2ee_migration_resumed",
      ].includes(eventType)
      || typeof appInstanceId !== "string"
      || !UUID.test(appInstanceId)
    ) throw new Error("invalid");

    const userKeyEvent = eventType === "user_key_created" || eventType === "user_key_rewrapped";
    const providerMigrationEvent = eventType === "provider_migration_started"
      || eventType === "provider_migration_completed";
    const e2eeEvent = eventType === "e2ee_migration_blocked" || eventType === "e2ee_migration_resumed";
    if (userKeyEvent) {
      if (
        typeof userId !== "string" || !UUID.test(userId)
        || !validProvider(provider)
        || !validFingerprint(provider, providerFingerprint)
        || !Number.isSafeInteger(keyVersion) || (keyVersion as number) < 1 || (keyVersion as number) > 32_767
        || actorUserId !== null
      ) throw new Error("invalid");
    } else if (providerMigrationEvent) {
      if (
        userId !== null
        || !validProvider(provider)
        || !validFingerprint(provider, providerFingerprint)
        || keyVersion !== null
        || typeof actorUserId !== "string" || !UUID.test(actorUserId)
      ) throw new Error("invalid");
    } else if (e2eeEvent) {
      if (
        typeof userId !== "string" || !UUID.test(userId)
        || provider !== null || providerFingerprint !== null || keyVersion !== null || actorUserId !== null
      ) throw new Error("invalid");
    }
    return Object.freeze({
      eventType: eventType as KeySecurityEventType,
      userId: userId as string | null,
      provider: provider as KeyProviderName | null,
      providerFingerprint: providerFingerprint as string | null,
      keyVersion: keyVersion as number | null,
      actorUserId: actorUserId as string | null,
      appInstanceId,
    });
  } catch {
    throw new Error("KEY_SECURITY_EVENT_INVALID");
  }
}

export async function recordKeySecurityEvent(
  event: KeySecurityEvent,
  db: KeyOperationDatabase = getPool(),
): Promise<void> {
  const snapshot = snapshotSecurityEvent(event);
  try {
    await db.query(
      `INSERT INTO content_key_security_events
         (event_type,user_id,provider,provider_fingerprint,key_version,actor_user_id,app_instance_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        snapshot.eventType,
        snapshot.userId,
        snapshot.provider,
        snapshot.providerFingerprint,
        snapshot.keyVersion,
        snapshot.actorUserId,
        snapshot.appInstanceId,
      ],
    );
  } catch {
    throw new Error("KEY_SECURITY_EVENT_RECORD_FAILED");
  }
}
