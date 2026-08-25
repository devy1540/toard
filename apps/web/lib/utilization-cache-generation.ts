import { getPool } from "./db";

export type UtilizationCacheGenerationState = {
  personalUserGeneration: number;
  personalUserPending: number;
  personalAllGeneration: number;
  personalAllPending: number;
  organizationGeneration: number;
  organizationPending: number;
};

type GenerationRow = {
  personal_user_generation: string | number;
  personal_user_pending: string | number;
  personal_all_generation: string | number;
  personal_all_pending: string | number;
  organization_generation: string | number;
  organization_pending: string | number;
};

export type UtilizationCacheGenerationDb = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

const number = (value: string | number | undefined): number => Number(value ?? 0);
const HEARTBEAT_MS = 30_000;

function leaseId(result: { rows: Record<string, unknown>[] }): string {
  const value = result.rows[0]?.lease_id;
  if (typeof value !== "string") throw new Error("utilization cache change lease missing");
  return value;
}

function startHeartbeat(
  id: string,
  db: UtilizationCacheGenerationDb,
): () => void {
  const timer = setInterval(() => {
    void db.query("SELECT heartbeat_utilization_cache_change($1::uuid)", [id]).catch(() => {
      // finish가 실패하면 lease가 남고 read path가 stale lease를 회수하므로 heartbeat 오류는 작업을 중단하지 않는다.
    });
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function readUtilizationCacheGeneration(
  userId: string | null,
  db: UtilizationCacheGenerationDb = getPool(),
): Promise<UtilizationCacheGenerationState> {
  const result = await db.query(
    "SELECT * FROM read_utilization_cache_generation($1::uuid)",
    [userId],
  );
  const row = result.rows[0] as GenerationRow | undefined;
  if (!row) throw new Error("utilization cache generation state missing");
  return {
    personalUserGeneration: number(row.personal_user_generation),
    personalUserPending: number(row.personal_user_pending),
    personalAllGeneration: number(row.personal_all_generation),
    personalAllPending: number(row.personal_all_pending),
    organizationGeneration: number(row.organization_generation),
    organizationPending: number(row.organization_pending),
  };
}

async function finishChange(
  db: UtilizationCacheGenerationDb,
  sql: string,
  values: unknown[],
  hadPrimaryError: boolean,
): Promise<void> {
  try {
    await db.query(sql, values);
  } catch (finishError) {
    if (!hadPrimaryError) throw finishError;
    console.warn("[toard] utilization cache generation finish failed after mutation error");
  }
}

export async function withUserUtilizationCacheChange<T>(
  userId: string,
  operation: () => Promise<T>,
  db: UtilizationCacheGenerationDb = getPool(),
): Promise<T> {
  const id = leaseId(await db.query(
    "SELECT begin_user_utilization_cache_change($1::uuid) AS lease_id",
    [userId],
  ));
  const stopHeartbeat = startHeartbeat(id, db);
  let result: T | undefined;
  let hadPrimaryError = false;
  try {
    result = await operation();
    return result;
  } catch (error) {
    hadPrimaryError = true;
    throw error;
  } finally {
    stopHeartbeat();
    await finishChange(
      db,
      "SELECT finish_user_utilization_cache_change($1::uuid, $2::uuid, $3::boolean)",
      [id, userId, true],
      hadPrimaryError,
    );
  }
}

export async function withAllUtilizationCacheChange<T>(
  operation: () => Promise<T>,
  db: UtilizationCacheGenerationDb = getPool(),
): Promise<T> {
  const id = leaseId(await db.query(
    "SELECT begin_all_utilization_cache_change() AS lease_id",
  ));
  const stopHeartbeat = startHeartbeat(id, db);
  let result: T | undefined;
  let hadPrimaryError = false;
  try {
    result = await operation();
    return result;
  } catch (error) {
    hadPrimaryError = true;
    throw error;
  } finally {
    stopHeartbeat();
    await finishChange(
      db,
      "SELECT finish_all_utilization_cache_change($1::uuid, $2::boolean)",
      [id, true],
      hadPrimaryError,
    );
  }
}
