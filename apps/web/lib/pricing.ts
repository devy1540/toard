import type { ModelPricing, PricingMap } from "@toard/pricing";
import { getPool } from "./db";

let cache: { map: PricingMap; at: number } | undefined;
const TTL_MS = 60 * 60 * 1000;

/** pricing_models 에서 모델별 최신 가격(per-million) 로드 + 1시간 캐시 (설계 §6.2). PG 는 argMax 대신 DISTINCT ON. */
export async function getPricingMap(): Promise<PricingMap> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.map;

  const res = await getPool().query(
    `SELECT DISTINCT ON (model_id)
       model_id, input_price_per_mtok, output_price_per_mtok,
       cache_read_price_per_mtok, cache_creation_price_per_mtok,
       input_price_above_200k_per_mtok, output_price_above_200k_per_mtok, fast_multiplier
     FROM pricing_models
     ORDER BY model_id, effective_date DESC`,
  );

  const map: PricingMap = new Map();
  for (const r of res.rows) {
    const p: ModelPricing = {
      inputPerM: Number(r.input_price_per_mtok),
      outputPerM: Number(r.output_price_per_mtok),
    };
    if (r.cache_read_price_per_mtok != null) p.cacheReadPerM = Number(r.cache_read_price_per_mtok);
    if (r.cache_creation_price_per_mtok != null) p.cacheCreatePerM = Number(r.cache_creation_price_per_mtok);
    if (r.input_price_above_200k_per_mtok != null) p.inputAbove200kPerM = Number(r.input_price_above_200k_per_mtok);
    if (r.output_price_above_200k_per_mtok != null) p.outputAbove200kPerM = Number(r.output_price_above_200k_per_mtok);
    if (r.fast_multiplier != null) p.fastMultiplier = Number(r.fast_multiplier);
    map.set(r.model_id, p);
  }
  cache = { map, at: now };
  return map;
}
