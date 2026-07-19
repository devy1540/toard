import { decryptE2eeRecord } from "./e2ee-browser-crypto";
import {
  E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES,
} from "./e2ee-to-managed-contract";
import type { E2eePromptRecordWire } from "./e2ee-contract";

type FetchJson = (url: string, init?: RequestInit) => Promise<unknown>;

export type E2eeManagedMigrationSource = {
  id: string;
  sourceDigest: string;
  record: E2eePromptRecordWire;
};

export type E2eeToManagedWorkerInput = {
  uck: Uint8Array;
  signal?: AbortSignal;
  fetchJson: FetchJson;
  decrypt?: (
    uck: Uint8Array,
    record: E2eePromptRecordWire,
  ) => Promise<Uint8Array>;
};

export type E2eeToManagedWorkerResult = {
  migrated: number;
  remaining: number;
  complete: boolean;
  payloadBytes: number;
};

export type E2eeManagedMigrationStatus = {
  state: "pending" | "running" | "blocked" | "complete";
  e2eeRecords: number;
  migratedRecords: number;
  startedAt: string | null;
  completedAt: string | null;
  blockedAt: string | null;
  blockedReason: "key_unavailable" | null;
};

export type E2eeToManagedLoopEnvironment = {
  isVisible(): boolean;
  isOnline(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  onOnline(listener: () => void): () => void;
};

export type E2eeToManagedLoop = {
  start(): void;
  dispose(): void;
};

export type E2eeMigrationRetryTimer = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

export type E2eeMigrationCompletionBoundary = {
  finish(): boolean;
  isComplete(): boolean;
  unlock(uck: Uint8Array, onUnlock: (uck: Uint8Array) => void): boolean;
};

export function createE2eeMigrationCompletionBoundary(
  onComplete: () => void,
): E2eeMigrationCompletionBoundary {
  let complete = false;
  return {
    finish() {
      if (complete) return false;
      complete = true;
      onComplete();
      return true;
    },
    isComplete() {
      return complete;
    },
    unlock(uck, onUnlock) {
      try {
        if (complete) return false;
        onUnlock(uck);
        return true;
      } finally {
        uck.fill(0);
      }
    },
  };
}

export function acceptInitialE2eeMigrationStatus(
  boundary: E2eeMigrationCompletionBoundary,
  status: E2eeManagedMigrationStatus,
  onIncomplete: (status: E2eeManagedMigrationStatus) => void,
): void {
  if (boundary.isComplete()) return;
  if (status.state === "complete") {
    boundary.finish();
    return;
  }
  onIncomplete(status);
}

export function resolveE2eeContentAccountState(
  boundary: E2eeMigrationCompletionBoundary,
  state: "off" | "pending" | "active" | "migrated",
): "active" | "inactive" | "complete" {
  if (boundary.isComplete()) return "complete";
  if (state === "migrated") {
    boundary.finish();
    return "complete";
  }
  return state === "active" ? "active" : "inactive";
}

const EMPTY_BODY_BYTES = new TextEncoder().encode('{"items":[]}').byteLength;
const MAX_CONFLICT_RETRIES = 3;
const RECOVERABLE_CONFLICT_CODES = new Set([
  "MIGRATION_NOT_RUNNABLE",
  "E2EE_SOURCE_CHANGED",
  "MIGRATION_STATE_CHANGED",
  "CONTENT_ACCOUNT_STATE_CHANGED",
]);

export function isRecoverableE2eeMigrationConflict(error: unknown): boolean {
  try {
    return error instanceof Error && RECOVERABLE_CONFLICT_CODES.has(error.message);
  } catch {
    return false;
  }
}

export async function runE2eeToManagedBatch(
  input: E2eeToManagedWorkerInput,
): Promise<E2eeToManagedWorkerResult> {
  const page = await input.fetchJson("/api/content/managed-migration/page?limit=25", {
    signal: input.signal,
  }) as { records: E2eeManagedMigrationSource[] };
  if (page.records.length === 0) {
    return { migrated: 0, remaining: 0, complete: true, payloadBytes: 0 };
  }

  const decrypt = input.decrypt ?? decryptE2eeRecord;
  const serializedItems: string[] = [];
  let payloadBytes = EMPTY_BODY_BYTES;
  for (const source of page.records) {
    const plaintext = await decrypt(input.uck, source.record);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      const serialized = JSON.stringify({
        id: source.id,
        sourceDigest: source.sourceDigest,
        text,
      });
      const itemBytes = new TextEncoder().encode(serialized).byteLength;
      const separatorBytes = serializedItems.length === 0 ? 0 : 1;
      if (payloadBytes + separatorBytes + itemBytes > E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES) {
        if (serializedItems.length === 0) throw new Error("MIGRATION_ITEM_TOO_LARGE");
        break;
      }
      serializedItems.push(serialized);
      payloadBytes += separatorBytes + itemBytes;
    } finally {
      plaintext.fill(0);
    }
  }

  const body = `{"items":[${serializedItems.join(",")}]}`;
  const result = await input.fetchJson("/api/content/managed-migration/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: input.signal,
  }) as Omit<E2eeToManagedWorkerResult, "payloadBytes">;
  return { ...result, payloadBytes };
}

export function createE2eeToManagedLoop(input: {
  copyUck(): Uint8Array;
  fetchJson: FetchJson;
  environment: E2eeToManagedLoopEnvironment;
  onStatus(status: E2eeManagedMigrationStatus): void;
  onComplete(): void;
  onError(error: unknown): void;
  decrypt?: E2eeToManagedWorkerInput["decrypt"];
  retryTimer?: E2eeMigrationRetryTimer;
}): E2eeToManagedLoop {
  const controller = new AbortController();
  const retryTimer = input.retryTimer ?? defaultRetryTimer();
  let started = false;
  let disposed = false;
  let running = false;
  let complete = false;
  let conflictRetries = 0;
  let retryScheduled = false;
  let retryHandle: unknown;
  let removeVisibility: (() => void) | null = null;
  let removeOnline: (() => void) | null = null;

  const runnable = () => !disposed
    && !complete
    && !retryScheduled
    && input.environment.isVisible()
    && input.environment.isOnline();

  const finish = () => {
    if (complete || disposed) return;
    complete = true;
    input.onComplete();
  };

  const scheduleConflictRetry = () => {
    conflictRetries += 1;
    const delayMs = 50 * (2 ** (conflictRetries - 1));
    retryScheduled = true;
    retryHandle = retryTimer.set(() => {
      if (!retryScheduled) return;
      retryScheduled = false;
      retryHandle = undefined;
      if (!disposed && !complete) schedule();
    }, delayMs);
  };

  const schedule = () => {
    if (!runnable() || running) return;
    running = true;
    let repeat = false;
    void run().then((shouldRepeat) => {
      repeat = shouldRepeat;
    }).catch((error) => {
      if (!disposed && !controller.signal.aborted) input.onError(error);
    }).finally(() => {
      running = false;
      if (repeat && runnable()) schedule();
    });
  };

  const run = async (): Promise<boolean> => {
    const status = await input.fetchJson("/api/content/managed-migration/status", {
      signal: controller.signal,
    }) as E2eeManagedMigrationStatus;
    if (disposed) return false;
    input.onStatus(status);
    if (status.state === "complete") {
      finish();
      return false;
    }
    if (status.state === "blocked" || status.e2eeRecords === 0 || !runnable()) return false;

    const uck = input.copyUck();
    try {
      let result: E2eeToManagedWorkerResult;
      try {
        result = await runE2eeToManagedBatch({
          uck,
          signal: controller.signal,
          fetchJson: input.fetchJson,
          decrypt: input.decrypt,
        });
      } catch (error) {
        if (isRecoverableE2eeMigrationConflict(error)
          && conflictRetries < MAX_CONFLICT_RETRIES
          && !disposed
          && !controller.signal.aborted) {
          scheduleConflictRetry();
          return false;
        }
        throw error;
      }
      if (disposed) return false;
      conflictRetries = 0;
      input.onStatus({
        ...status,
        state: result.complete ? "complete" : "running",
        e2eeRecords: result.remaining,
        migratedRecords: status.migratedRecords + result.migrated,
      });
      if (result.complete) {
        finish();
        return false;
      }
      return true;
    } finally {
      uck.fill(0);
    }
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      removeVisibility = input.environment.onVisibilityChange(schedule);
      removeOnline = input.environment.onOnline(schedule);
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      if (retryScheduled) {
        retryScheduled = false;
        retryTimer.clear(retryHandle);
        retryHandle = undefined;
      }
      removeVisibility?.();
      removeOnline?.();
      removeVisibility = null;
      removeOnline = null;
    },
  };
}

function defaultRetryTimer(): E2eeMigrationRetryTimer {
  return {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}
