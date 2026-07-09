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

function isFlushable(storage: unknown): storage is FlushableStorage {
  return typeof (storage as { flushUsageOutbox?: unknown }).flushUsageOutbox === "function";
}

function isCompactable(storage: unknown): storage is CompactableStorage {
  return typeof (storage as { compactUsage15mRollup?: unknown }).compactUsage15mRollup === "function";
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
