import type { UsageCostCoverage } from "@toard/core";
import type { ModelPricing, PricingMap, PricingRevision, PricingSchedule } from "@toard/pricing";
import { getAppSetting } from "./app-settings";
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

const TTL_MS = 60 * 60 * 1000;

export const PRICING_SYNC_STATUS_SETTING_KEY = "pricing_sync_status";

export type CostCoverageState = "complete" | "partial" | "unpriced" | "legacy";

/** 비용 숫자를 그대로 완전 합계로 표시해도 되는지 결정하는 순수 표시 상태. */
export function costCoverageState(coverage: UsageCostCoverage): CostCoverageState {
  if (coverage.unpricedEvents > 0) {
    return coverage.pricedEvents + coverage.legacyEvents > 0 ? "partial" : "unpriced";
  }
  if (coverage.legacyEvents > 0) return "legacy";
  return "complete";
}

export function formatCostForCoverage(
  cost: string,
  coverage: UsageCostCoverage,
  labels: { partial: string; unpriced: string; legacy: string },
): string {
  const state = costCoverageState(coverage);
  if (state === "unpriced") return labels.unpriced;
  if (state === "partial") return `${cost} · ${labels.partial}`;
  if (state === "legacy") return `${cost} · ${labels.legacy}`;
  return cost;
}

export type PricingSyncStatus = {
  day: string;
  syncedAt: string;
};

type PricingScheduleCacheDeps = {
  loadSchedule(): Promise<PricingSchedule>;
  readVersion(): Promise<string | null>;
  now?(): number;
};

export function createPricingScheduleCache({
  loadSchedule,
  readVersion,
  now = Date.now,
}: PricingScheduleCacheDeps) {
  let entry: { schedule: PricingSchedule; at: number; version: string | null } | undefined;
  return {
    async get(): Promise<PricingSchedule> {
      const version = await readVersion();
      const currentTime = now();
      if (entry && entry.version === version && currentTime - entry.at < TTL_MS) {
        return entry.schedule;
      }

      const schedule = await loadSchedule();
      entry = { schedule, at: currentTime, version };
      return schedule;
    },
    invalidate(): void {
      entry = undefined;
    },
  };
}

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

const pricingScheduleCache = createPricingScheduleCache({
  loadSchedule: () => loadPricingSchedule((sql) => getPool().query<PricingRevisionRow>(sql)),
  readVersion: async () => {
    const status = await getAppSetting<PricingSyncStatus>(PRICING_SYNC_STATUS_SETTING_KEY);
    return status?.syncedAt ?? null;
  },
});

/** 공유 sync version이 같을 때만 전체 가격 revision schedule을 최대 1시간 캐시한다. */
export async function getPricingSchedule(): Promise<PricingSchedule> {
  return pricingScheduleCache.get();
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
  pricingScheduleCache.invalidate();
}

export type PricingStatus = { models: number; lastDay: string | null };

export async function loadPricingStatus(
  query: (sql: string) => Promise<{ rows: Array<{ models: string }> }>,
  readSetting: (key: string) => Promise<PricingSyncStatus | undefined>,
): Promise<PricingStatus> {
  const [revisions, sync] = await Promise.all([
    query("SELECT count(DISTINCT model_id) AS models FROM pricing_revisions"),
    readSetting(PRICING_SYNC_STATUS_SETTING_KEY),
  ]);
  return {
    models: Number(revisions.rows[0]?.models ?? 0),
    lastDay: sync?.day ?? null,
  };
}

/** 가격 현황 — 모델 수는 revision, 마지막 성공일은 app_settings의 sync 상태가 권위 소스다. */
export async function getPricingStatus(): Promise<PricingStatus> {
  return loadPricingStatus(
    (sql) => getPool().query<{ models: string }>(sql),
    (key) => getAppSetting<PricingSyncStatus>(key),
  );
}
