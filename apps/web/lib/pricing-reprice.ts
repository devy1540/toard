import { resolveCost, resolvePricing, type PricingMap } from "@toard/pricing";

const PAGE_SIZE = 500;

type QueryResult<T> = { rows: T[] };

type RepriceClient = {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
};

export type RepricePool = {
  connect(): Promise<RepriceClient>;
};

type StoredUsageRow = {
  dedup_key: string;
  model: string | null;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_creation_tokens: string;
  day: string;
};

export type RepriceResult = {
  repriced: number;
  unpriced: number;
  days: string[];
};

/**
 * 보존 중인 모든 이벤트를 현재 가격표로 재평가한다.
 * 과거 이벤트에는 cacheCreation1hTokens/isFast가 저장돼 있지 않으므로, 현재 비용 엔진의
 * no-hint 기본값(캐시생성 전체 5분 TTL·fast 미적용)을 사용한다.
 */
export async function repriceUsageCostsWithPool(
  pool: RepricePool,
  pricing: PricingMap,
  timezone: string,
): Promise<RepriceResult> {
  const client = await pool.connect();
  const days = new Set<string>();
  let after = "";
  let repriced = 0;
  let unpriced = 0;

  try {
    await client.query("BEGIN");
    for (;;) {
      const page = await client.query<StoredUsageRow>(
        `SELECT dedup_key, model, input_tokens::text, output_tokens::text,
                cache_read_tokens::text, cache_creation_tokens::text,
                (ts AT TIME ZONE $1)::date::text AS day
         FROM usage_events
         WHERE dedup_key > $2
         ORDER BY dedup_key
         LIMIT $3`,
        [timezone, after, PAGE_SIZE],
      );
      if (page.rows.length === 0) break;

      const costs = page.rows.map((row) => {
        if (!resolvePricing(row.model, pricing)) unpriced += 1;
        days.add(row.day);
        return [
          row.dedup_key,
          resolveCost({
            model: row.model,
            inputTokens: Number(row.input_tokens),
            outputTokens: Number(row.output_tokens),
            cacheReadTokens: Number(row.cache_read_tokens),
            cacheCreationTokens: Number(row.cache_creation_tokens),
            pricing,
            mode: "calculate",
          }),
        ] as const;
      });

      await updateCosts(client, costs);
      repriced += costs.length;
      after = page.rows.at(-1)!.dedup_key;
    }
    await client.query("COMMIT");
    return { repriced, unpriced, days: [...days].sort() };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateCosts(client: RepriceClient, costs: ReadonlyArray<readonly [string, number]>): Promise<void> {
  if (costs.length === 0) return;
  const params: unknown[] = [];
  const values = costs.map(([dedupKey, cost]) => {
    const offset = params.length + 1;
    params.push(dedupKey, cost.toFixed(8));
    return `($${offset}::text, $${offset + 1}::numeric)`;
  });
  await client.query(
    `UPDATE usage_events AS event
     SET cost_usd = price.cost
     FROM (VALUES ${values.join(",")}) AS price(dedup_key, cost)
     WHERE event.dedup_key = price.dedup_key`,
    params,
  );
}
