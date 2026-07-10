const STARTUP_DELAY_MS = 15_000;
const TICK_MS = 30_000;
const COMPACTOR_TICK_MS = 60_000;
const DEFAULT_LIMIT = 10;

type FlushableStorage = {
  flushUsageOutbox(limit?: number): Promise<{ batches: number; rows: number }>;
};

type CompactableStorage = {
  compactUsage15mRollup(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }>;
};

type V2CompactableStorage = {
  compactUsage15mV2(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }>;
};

function isFlushable(storage: unknown): storage is FlushableStorage {
  return typeof (storage as { flushUsageOutbox?: unknown }).flushUsageOutbox === "function";
}

function isCompactable(storage: unknown): storage is CompactableStorage {
  return typeof (storage as { compactUsage15mRollup?: unknown }).compactUsage15mRollup === "function";
}

function isV2Compactable(storage: unknown): storage is V2CompactableStorage {
  return typeof (storage as { compactUsage15mV2?: unknown }).compactUsage15mV2 === "function";
}

function enabled(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}

export async function flushClickHouseOutbox(limit = DEFAULT_LIMIT): Promise<{ batches: number; rows: number }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { batches: 0, rows: 0 };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isFlushable(storage)) return { batches: 0, rows: 0 };
  return storage.flushUsageOutbox(limit);
}

export async function compactClickHouse15mRollup(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { buckets: 0, rows: 0, watermark: "" };
  if (!enabled("CLICKHOUSE_15M_ROLLUP_COMPACTOR")) return { buckets: 0, rows: 0, watermark: "" };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isCompactable(storage)) return { buckets: 0, rows: 0, watermark: "" };
  return storage.compactUsage15mRollup(limitBuckets);
}

export async function compactClickHouse15mV2Rollup(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { buckets: 0, rows: 0, watermark: "" };
  if (!enabled("CLICKHOUSE_15M_V2_COMPACTOR")) return { buckets: 0, rows: 0, watermark: "" };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isV2Compactable(storage)) return { buckets: 0, rows: 0, watermark: "" };
  return storage.compactUsage15mV2(limitBuckets);
}

/** Task 7의 scheduler가 호출할 시간대 cache bounded tick. 시작 flag/timer는 그 task에서 연결한다. */
export async function compactClickHouseTimezoneRollups(): Promise<{ jobs: number; rows: number }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { jobs: 0, rows: 0 };
  const { runTimezoneRollupWorker } = await import("./timezone-rollup");
  return runTimezoneRollupWorker();
}

async function tick(): Promise<void> {
  try {
    const r = await flushClickHouseOutbox();
    if (r.rows > 0) console.log(`[toard] ClickHouse outbox flushed — ${r.rows} rows in ${r.batches} batches`);
  } catch (e) {
    console.warn(`[toard] ClickHouse outbox flush failed — ${String(e)} — retrying later`);
  }
}

async function compactTick(): Promise<void> {
  try {
    const r = await compactClickHouse15mRollup();
    if (r.buckets > 0) {
      console.log(`[toard] ClickHouse 15m rollup compacted — ${r.buckets} buckets, ${r.rows} rows, watermark ${r.watermark}`);
    }
  } catch (e) {
    console.warn(`[toard] ClickHouse 15m rollup compaction failed — ${String(e)} — retrying later`);
  }
}

async function compactV2Tick(): Promise<void> {
  try {
    const r = await compactClickHouse15mV2Rollup();
    if (r.buckets > 0) {
      console.log(`[toard] ClickHouse 15m v2 rollup compacted — ${r.buckets} buckets, ${r.rows} rows, watermark ${r.watermark}`);
    }
  } catch (e) {
    console.warn(`[toard] ClickHouse 15m v2 rollup compaction failed — ${String(e)} — retrying later`);
  }
}

export function startClickHouseOutboxFlush(): void {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  const g = globalThis as {
    __toardClickHouseOutboxFlush?: true;
    __toardClickHouseOutboxRunning?: true;
    __toardClickHouse15mRollupRunning?: true;
  };
  if (g.__toardClickHouseOutboxFlush) return;
  g.__toardClickHouseOutboxFlush = true;
  const guardedTick = () => {
    if (g.__toardClickHouseOutboxRunning) return;
    g.__toardClickHouseOutboxRunning = true;
    tick().finally(() => {
      g.__toardClickHouseOutboxRunning = undefined;
    });
  };
  setTimeout(guardedTick, STARTUP_DELAY_MS).unref();
  setInterval(guardedTick, TICK_MS).unref();
  const guardedCompactTick = () => {
    if (!enabled("CLICKHOUSE_15M_ROLLUP_COMPACTOR")) return;
    if (g.__toardClickHouse15mRollupRunning) return;
    g.__toardClickHouse15mRollupRunning = true;
    compactTick().finally(() => {
      g.__toardClickHouse15mRollupRunning = undefined;
    });
  };
  setTimeout(guardedCompactTick, STARTUP_DELAY_MS + 5_000).unref();
  setInterval(guardedCompactTick, COMPACTOR_TICK_MS).unref();
}

export function startClickHouse15mV2Compaction(): void {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  if (!enabled("CLICKHOUSE_15M_V2_COMPACTOR")) return;
  const g = globalThis as {
    __toardClickHouse15mV2RollupFlush?: true;
    __toardClickHouse15mV2RollupRunning?: true;
  };
  if (g.__toardClickHouse15mV2RollupFlush) return;
  g.__toardClickHouse15mV2RollupFlush = true;
  const guardedCompactV2Tick = () => {
    if (!enabled("CLICKHOUSE_15M_V2_COMPACTOR")) return;
    if (g.__toardClickHouse15mV2RollupRunning) return;
    g.__toardClickHouse15mV2RollupRunning = true;
    compactV2Tick().finally(() => {
      g.__toardClickHouse15mV2RollupRunning = undefined;
    });
  };
  setTimeout(guardedCompactV2Tick, STARTUP_DELAY_MS + 10_000).unref();
  setInterval(guardedCompactV2Tick, COMPACTOR_TICK_MS).unref();
}
