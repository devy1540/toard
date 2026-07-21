import { fetchLiteLLMPricing, type ModelPricing, type PricingMap } from "@toard/pricing";
import { getPool } from "./db";
import { dayStartUtc, getOrgTimezone, orgDate } from "./org-time";
import {
  invalidatePricingCache,
  PRICING_CACHE_VERSION_SETTING_KEY,
  PRICING_SYNC_STATUS_SETTING_KEY,
} from "./pricing";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_SYNC_LOCK_KEY = "pricing-sync";

export type PricingSyncResult =
  | { ok: true; upserted: number; day: string }
  | { ok: false; error: string; kept: boolean };

type LatestPricingRow = {
  model_id: string;
  input_price_per_mtok: string | number;
  output_price_per_mtok: string | number;
  cache_read_price_per_mtok: string | number | null;
  cache_creation_price_per_mtok: string | number | null;
  input_price_above_200k_per_mtok: string | number | null;
  output_price_above_200k_per_mtok: string | number | null;
  fast_multiplier: string | number;
};

export type PricingSyncQueryClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export function pricingRevisionEffectiveAt(day: string, timezone: string): Date {
  return dayStartUtc(day, timezone);
}

export async function markPricingRepairPending(
  client: PricingSyncQueryClient,
  generation: Date,
  targetTo: Date,
): Promise<void> {
  await client.query(
    `UPDATE pricing_repair_status
     SET generation = $1,
         state = 'pending',
         target_to = $2,
         processed_events = 0,
         recovered_events = 0,
         reconciled_events = 0,
         repriced_legacy_events = 0,
         remaining_unpriced_events = 0,
         remaining_legacy_events = 0,
         unresolved_models = '[]'::jsonb,
         eligible_since = now(),
         next_attempt_at = now(),
         consecutive_failures = 0,
         last_error = NULL,
         updated_at = now()
     WHERE singleton`,
    [generation, targetTo],
  );
}

function optionalNumber(value: string | number | null): number | undefined {
  return value == null ? undefined : Number(value);
}

function samePricing(row: LatestPricingRow, pricing: ModelPricing): boolean {
  return Number(row.input_price_per_mtok) === pricing.inputPerM &&
    Number(row.output_price_per_mtok) === pricing.outputPerM &&
    optionalNumber(row.cache_read_price_per_mtok) === pricing.cacheReadPerM &&
    optionalNumber(row.cache_creation_price_per_mtok) === pricing.cacheCreatePerM &&
    optionalNumber(row.input_price_above_200k_per_mtok) === pricing.inputAbove200kPerM &&
    optionalNumber(row.output_price_above_200k_per_mtok) === pricing.outputAbove200kPerM &&
    Number(row.fast_multiplier) === (pricing.fastMultiplier ?? 1);
}

/** 최신 revision과 다른 모델만 새 revision으로 추가한다. 기존 행은 절대 수정하지 않는다. */
export async function syncPricingRevisions(
  client: PricingSyncQueryClient,
  pricing: PricingMap,
  effectiveAt: Date,
): Promise<number> {
  const latestResult = await client.query(
    `SELECT DISTINCT ON (model_id)
       model_id, input_price_per_mtok, output_price_per_mtok,
       cache_read_price_per_mtok, cache_creation_price_per_mtok,
       input_price_above_200k_per_mtok, output_price_above_200k_per_mtok, fast_multiplier
     FROM pricing_revisions
     ORDER BY model_id, effective_at DESC, observed_at DESC, id DESC`,
  );
  const latest = new Map(
    (latestResult.rows as LatestPricingRow[]).map((row) => [row.model_id, row]),
  );
  const changed = [...pricing.entries()].filter(([modelId, value]) => {
    const previous = latest.get(modelId);
    return !previous || !samePricing(previous, value);
  });

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < changed.length; i += CHUNK) {
    const chunk = changed.slice(i, i + CHUNK);
    const params: unknown[] = [effectiveAt];
    const rows: string[] = [];
    for (const [modelId, value] of chunk) {
      const b = params.length + 1;
      rows.push(
        `($${b},$1,$${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},'litellm')`,
      );
      params.push(
        modelId,
        value.inputPerM,
        value.outputPerM,
        value.cacheReadPerM ?? null,
        value.cacheCreatePerM ?? null,
        value.inputAbove200kPerM ?? null,
        value.outputAbove200kPerM ?? null,
        value.fastMultiplier ?? 1,
      );
    }
    const result = await client.query(
      `INSERT INTO pricing_revisions
         (model_id, effective_at, input_price_per_mtok, output_price_per_mtok,
          cache_read_price_per_mtok, cache_creation_price_per_mtok,
          input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
          fast_multiplier, source)
       VALUES ${rows.join(",")}
       ON CONFLICT (model_id, effective_at, source) DO NOTHING
       RETURNING id`,
      params,
    );
    inserted += result.rows.length;
  }
  return inserted;
}

/** 가격 fetch부터 성공 상태 기록까지 하나의 DB transaction으로 확정한다. */
export async function runPricingSyncTransaction(
  client: PricingSyncQueryClient,
  fetchPricing: () => Promise<PricingMap>,
  day: string,
  timezone: string,
  /** @deprecated 호출 호환용. revision 시각은 lock 획득·fetch 성공 뒤 생성한다. */
  _requestedAt?: Date,
  invalidateCache: () => void = invalidatePricingCache,
  now: () => Date = () => new Date(),
): Promise<number> {
  await client.query("BEGIN");
  let upserted = 0;
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PRICING_SYNC_LOCK_KEY]);
    const pricing = await fetchPricing();
    const observedAt = now();
    const effectiveAt = pricingRevisionEffectiveAt(day, timezone);
    upserted = await syncPricingRevisions(client, pricing, effectiveAt);
    await markPricingRepairPending(client, observedAt, observedAt);
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [
        PRICING_SYNC_STATUS_SETTING_KEY,
        JSON.stringify({ day, syncedAt: observedAt.toISOString() }),
      ],
    );
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [
        PRICING_CACHE_VERSION_SETTING_KEY,
        JSON.stringify({ updatedAt: observedAt.toISOString() }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  invalidateCache();
  return upserted;
}

/**
 * LiteLLM 가격 동기화 코어 (설계 §6.2) — cron 라우트와 admin 수동 동기화가 공유.
 * fetch → per-million 변환 → 가격이 달라진 모델만 현재 시각 revision으로 INSERT.
 * fetch 실패/0건이면 마지막 스냅샷 유지(검토 A-9) — kept: true 로 구분.
 */
export async function runPricingSync(): Promise<PricingSyncResult> {
  const url = process.env.LITELLM_PRICING_URL ?? DEFAULT_URL;
  const timezone = getOrgTimezone();
  const day = orgDate(0);
  const client = await getPool().connect();
  let upserted = 0;
  let fetchFailed = false;
  try {
    upserted = await runPricingSyncTransaction(
      client,
      async () => {
        try {
          return await fetchLiteLLMPricing(url);
        } catch (error) {
          fetchFailed = true;
          throw error;
        }
      },
      day,
      timezone,
    );
  } catch (e) {
    return { ok: false, error: String(e), kept: fetchFailed };
  } finally {
    client.release();
  }

  return { ok: true, upserted, day };
}
