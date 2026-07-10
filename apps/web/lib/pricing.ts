import type { ModelPricing, PricingMap, PricingRevision, PricingSchedule } from "@toard/pricing";
import { getPool } from "./db";

type PricingRevisionRow = {
  id: string;
  model_id: string;
  effective_at: Date | string;
  input_price_per_mtok: string | number;
  output_price_per_mtok: string | number;
  cache_read_price_per_mtok: string | number | null;
  cache_creation_price_per_mtok: string | number | null;
  input_price_above_200k_per_mtok: string | number | null;
  output_price_above_200k_per_mtok: string | number | null;
  fast_multiplier: string | number | null;
};

type PricingRevisionQuery = (sql: string) => Promise<{ rows: PricingRevisionRow[] }>;

let cache: { schedule: PricingSchedule; at: number } | undefined;
const TTL_MS = 60 * 60 * 1000;

export async function loadPricingSchedule(query: PricingRevisionQuery): Promise<PricingSchedule> {
  const res = await query(
    `SELECT id, model_id, effective_at,
       input_price_per_mtok, output_price_per_mtok,
       cache_read_price_per_mtok, cache_creation_price_per_mtok,
       input_price_above_200k_per_mtok, output_price_above_200k_per_mtok, fast_multiplier
     FROM pricing_revisions
     ORDER BY model_id, effective_at ASC`,
  );

  const schedule: PricingSchedule = new Map();
  for (const r of res.rows) {
    const pricing: ModelPricing = {
      inputPerM: Number(r.input_price_per_mtok),
      outputPerM: Number(r.output_price_per_mtok),
    };
    if (r.cache_read_price_per_mtok != null) pricing.cacheReadPerM = Number(r.cache_read_price_per_mtok);
    if (r.cache_creation_price_per_mtok != null) pricing.cacheCreatePerM = Number(r.cache_creation_price_per_mtok);
    if (r.input_price_above_200k_per_mtok != null) pricing.inputAbove200kPerM = Number(r.input_price_above_200k_per_mtok);
    if (r.output_price_above_200k_per_mtok != null) pricing.outputAbove200kPerM = Number(r.output_price_above_200k_per_mtok);
    if (r.fast_multiplier != null) pricing.fastMultiplier = Number(r.fast_multiplier);

    const revision: PricingRevision = {
      id: r.id,
      modelId: r.model_id,
      effectiveAt: new Date(r.effective_at),
      pricing,
    };
    const revisions = schedule.get(r.model_id);
    if (revisions) {
      schedule.set(r.model_id, [...revisions, revision]);
    } else {
      schedule.set(r.model_id, [revision]);
    }
  }
  return schedule;
}

/** 전체 불변 가격 revision을 시간순으로 로드해 1시간 캐시한다. */
export async function getPricingSchedule(): Promise<PricingSchedule> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.schedule;

  const schedule = await loadPricingSchedule((sql) => getPool().query<PricingRevisionRow>(sql));
  cache = { schedule, at: now };
  return schedule;
}

/** 기존 최신 가격 호출자 호환용 뷰. canonical 데이터는 pricing_revisions다. */
export async function getPricingMap(): Promise<PricingMap> {
  const schedule = await getPricingSchedule();
  const map: PricingMap = new Map();
  for (const [modelId, revisions] of schedule) {
    const latest = revisions.at(-1);
    if (latest) map.set(modelId, latest.pricing);
  }
  return map;
}

/** 가격 동기화 cron 후 캐시 무효화 — 다음 호출이 최신 스냅샷을 즉시 로드(1h TTL 대기 회피) */
export function invalidatePricingCache(): void {
  cache = undefined;
}

export type PricingStatus = { models: number; lastDay: string | null };

/** 가격 스냅샷 현황 — 관리 시스템 탭 표시·미동기화($0 비용 함정) 경고용. */
export async function getPricingStatus(): Promise<PricingStatus> {
  const r = await getPool().query<{ models: string; last_day: string | null }>(
    "SELECT count(DISTINCT model_id) AS models, max(effective_at)::date::text AS last_day FROM pricing_revisions",
  );
  return { models: Number(r.rows[0]?.models ?? 0), lastDay: r.rows[0]?.last_day ?? null };
}
