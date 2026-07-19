export type ClickHouseOperationLog = {
  event: "clickhouse_operation_failed";
  backend: "clickhouse";
  operation: string;
  errorClass: "network" | "overload" | "admission_timeout" | "query";
  errorCode?: string;
  attempt: number;
  durationMs: number;
  queueWaitMs: number;
  inFlight: number;
};

export interface ClickHouseOperationRunner {
  run<T>(
    operation: string,
    action: () => Promise<T>,
    options?: { signal?: AbortSignal; retryTransient?: boolean },
  ): Promise<T>;
}

export class ClickHouseAdmissionTimeoutError extends Error {
  constructor(
    readonly queueWaitMs: number,
    readonly inFlight: number,
  ) {
    super("ClickHouse operation admission timed out");
    this.name = "ClickHouseAdmissionTimeoutError";
  }
}

export class ClickHouseOverloadError extends Error {
  readonly code = "202";

  constructor(readonly operation: string, options: { cause: unknown }) {
    super("ClickHouse is temporarily overloaded", options);
    this.name = "ClickHouseOverloadError";
  }
}

type OperationOptions = {
  signal?: AbortSignal;
  retryTransient?: boolean;
};

type AdmissionLease = {
  queueWaitMs: number;
  inFlight: number;
  release: () => void;
};

type QueueEntry = {
  enqueuedAt: number;
  signal?: AbortSignal;
  timeout: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: Error) => void;
};

const NETWORK_ATTEMPTS = 5;
const NETWORK_BACKOFF_BASE_MS = 150;
const OVERLOAD_ATTEMPTS = 2;
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class ClickHouseOperationController implements ClickHouseOperationRunner {
  private readonly maxConcurrent: number;
  private readonly queueTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (record: ClickHouseOperationLog) => void;
  private active = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(options: {
    maxConcurrent?: number;
    queueTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    log?: (record: ClickHouseOperationLog) => void;
  } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.queueTimeoutMs = options.queueTimeoutMs ?? 5_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.log = options.log ?? ((record) => console.warn(JSON.stringify(record)));
  }

  async run<T>(
    operation: string,
    action: () => Promise<T>,
    options: OperationOptions = {},
  ): Promise<T> {
    const startedAt = Date.now();
    let attempt = 0;
    let networkFailures = 0;
    let overloadFailures = 0;
    let lastLease: Pick<AdmissionLease, "queueWaitMs" | "inFlight"> | undefined;

    while (true) {
      attempt += 1;
      try {
        const lease = await this.acquire(options.signal);
        lastLease = lease;
        try {
          return await action();
        } finally {
          lease.release();
        }
      } catch (error) {
        if (options.retryTransient && isOverloadError(error)) {
          overloadFailures += 1;
          if (overloadFailures < OVERLOAD_ATTEMPTS) {
            await this.sleep(100 + Math.floor(this.random() * 200));
            continue;
          }
        } else if (options.retryTransient && isTransientNetworkError(error)) {
          networkFailures += 1;
          if (networkFailures < NETWORK_ATTEMPTS) {
            await this.sleep(NETWORK_BACKOFF_BASE_MS * 2 ** (networkFailures - 1));
            continue;
          }
        }

        const finalError = isOverloadError(error)
          ? new ClickHouseOverloadError(operation, { cause: error })
          : error;
        const admission = finalError instanceof ClickHouseAdmissionTimeoutError
          ? finalError
          : undefined;
        const queueWaitMs = admission?.queueWaitMs ?? lastLease?.queueWaitMs ?? 0;
        const inFlight = admission?.inFlight ?? lastLease?.inFlight ?? this.active;
        const code = errorCode(finalError);

        this.log({
          event: "clickhouse_operation_failed",
          backend: "clickhouse",
          operation,
          errorClass: classify(finalError),
          ...(code ? { errorCode: code } : {}),
          attempt,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          inFlight,
        });
        throw finalError;
      }
    }
  }

  private acquire(signal?: AbortSignal): Promise<AdmissionLease> {
    const enqueuedAt = Date.now();
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (this.active < this.maxConcurrent) {
      return Promise.resolve(this.createLease(enqueuedAt));
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const entry: QueueEntry = {
        enqueuedAt,
        signal,
        timeout: setTimeout(() => {
          if (!this.removeQueuedEntry(entry)) return;
          reject(new ClickHouseAdmissionTimeoutError(
            Date.now() - enqueuedAt,
            this.active,
          ));
        }, this.queueTimeoutMs),
        resolve,
        reject,
      };
      if (signal) {
        entry.abortListener = () => {
          if (!this.removeQueuedEntry(entry)) return;
          reject(abortError());
        };
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.queue.push(entry);
    });
  }

  private createLease(enqueuedAt: number): AdmissionLease {
    this.active += 1;
    let released = false;
    return {
      queueWaitMs: Date.now() - enqueuedAt,
      inFlight: this.active,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.cleanupEntry(entry);
      entry.resolve(this.createLease(entry.enqueuedAt));
    }
  }

  private removeQueuedEntry(entry: QueueEntry): boolean {
    const index = this.queue.indexOf(entry);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this.cleanupEntry(entry);
    return true;
  }

  private cleanupEntry(entry: QueueEntry): void {
    clearTimeout(entry.timeout);
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener("abort", entry.abortListener);
    }
  }
}

function abortError(): Error {
  const error = new Error("ClickHouse operation admission aborted");
  error.name = "AbortError";
  return error;
}

function classify(error: unknown): ClickHouseOperationLog["errorClass"] {
  if (error instanceof ClickHouseAdmissionTimeoutError) return "admission_timeout";
  if (error instanceof ClickHouseOverloadError || isOverloadError(error)) return "overload";
  if (isTransientNetworkError(error)) return "network";
  return "query";
}

function isOverloadError(error: unknown): boolean {
  const codes = errorCodes(error);
  return codes.includes("202") || codes.includes("TOO_MANY_SIMULTANEOUS_QUERIES");
}

function isTransientNetworkError(error: unknown): boolean {
  const codes = errorCodes(error);
  if (codes.some((code) => TRANSIENT_NETWORK_ERROR_CODES.has(code))) return true;
  const message = String(error instanceof Error ? error.message : error);
  return [...TRANSIENT_NETWORK_ERROR_CODES].some((code) => message.includes(code));
}

function errorCode(error: unknown): string | undefined {
  return errorCodes(error)[0];
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const visited = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" || typeof candidate.code === "number") {
      codes.push(String(candidate.code));
    }
    current = candidate.cause;
  }
  return codes;
}

export const defaultClickHouseOperationController =
  new ClickHouseOperationController({ maxConcurrent: 4, queueTimeoutMs: 5_000 });
