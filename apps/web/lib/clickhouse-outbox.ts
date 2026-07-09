import { getStorage } from "./storage";

const STARTUP_DELAY_MS = 15_000;
const TICK_MS = 30_000;
const DEFAULT_LIMIT = 10;

type FlushableStorage = {
  flushUsageOutbox(limit?: number): Promise<{ batches: number; rows: number }>;
};

function isFlushable(storage: unknown): storage is FlushableStorage {
  return typeof (storage as { flushUsageOutbox?: unknown }).flushUsageOutbox === "function";
}

export async function flushClickHouseOutbox(limit = DEFAULT_LIMIT): Promise<{ batches: number; rows: number }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { batches: 0, rows: 0 };
  const storage = getStorage();
  if (!isFlushable(storage)) return { batches: 0, rows: 0 };
  return storage.flushUsageOutbox(limit);
}

async function tick(): Promise<void> {
  try {
    const r = await flushClickHouseOutbox();
    if (r.rows > 0) console.log(`[toard] ClickHouse outbox flushed — ${r.rows} rows in ${r.batches} batches`);
  } catch (e) {
    console.warn(`[toard] ClickHouse outbox flush failed — ${String(e)} — retrying later`);
  }
}

export function startClickHouseOutboxFlush(): void {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  const g = globalThis as { __toardClickHouseOutboxFlush?: true; __toardClickHouseOutboxRunning?: true };
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
}
