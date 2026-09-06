import type { CostEvidenceCursor, FinalizedUsageEvent } from "@toard/core";
import { COST_CALCULATION_VERSION, explainCostAt, type PricingRevision } from "@toard/pricing";
import { getPool } from "./db";

export function decodeCostCursor(value: string | undefined): CostEvidenceCursor | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof decoded.ts !== "string" || typeof decoded.dedupKey !== "string" || decoded.dedupKey.length > 512) return undefined;
    const ts = new Date(decoded.ts);
    return Number.isFinite(ts.getTime()) ? { ts, dedupKey: decoded.dedupKey } : undefined;
  } catch { return undefined; }
}

export function encodeCostCursor(cursor: CostEvidenceCursor): string {
  return Buffer.from(JSON.stringify({ ts: cursor.ts.toISOString(), dedupKey: cursor.dedupKey })).toString("base64url");
}

export type CostEvidenceRevision = PricingRevision & { source: string; sourceRef: string | null };

/** IDs originate from an already-authorized personal ledger page, never from the request. */
export async function getCostEvidenceRevisions(events: FinalizedUsageEvent[], pool: Pick<ReturnType<typeof getPool>, "query"> = getPool()): Promise<Map<string, CostEvidenceRevision>> {
  const ids = [...new Set(events.flatMap((event) => event.pricingRevisionId ? [event.pricingRevisionId] : []))];
  return getCostEvidenceRevisionIds(ids, pool);
}

/** Internal report readers obtain these IDs from an authorized storage query. */
export async function getCostEvidenceRevisionIds(ids: string[], pool: Pick<ReturnType<typeof getPool>, "query"> = getPool()): Promise<Map<string, CostEvidenceRevision>> {
  if (!ids.length) return new Map();
  const result = await pool.query(
    "SELECT * FROM pricing_revisions WHERE id = ANY($1::uuid[])", [ids],
  );
  return new Map(result.rows.map((row) => [row.id, {
    id: row.id, modelId: row.model_id, sourceModelId: row.source_model_id,
    effectiveAt: new Date(row.effective_at), validUntil: row.valid_until ? new Date(row.valid_until) : undefined,
    source: row.source, sourceRef: row.source_ref,
    pricing: {
      inputPerM: Number(row.input_price_per_mtok), outputPerM: Number(row.output_price_per_mtok),
      cacheReadPerM: row.cache_read_price_per_mtok == null ? undefined : Number(row.cache_read_price_per_mtok),
      cacheCreatePerM: row.cache_creation_price_per_mtok == null ? undefined : Number(row.cache_creation_price_per_mtok),
      inputAbove200kPerM: row.input_price_above_200k_per_mtok == null ? undefined : Number(row.input_price_above_200k_per_mtok),
      outputAbove200kPerM: row.output_price_above_200k_per_mtok == null ? undefined : Number(row.output_price_above_200k_per_mtok),
      fastMultiplier: Number(row.fast_multiplier), ...row.pricing_details,
    },
  }]));
}

export function explainStoredCost(event: FinalizedUsageEvent, revision: CostEvidenceRevision | undefined) {
  if (!revision || event.costCalculationVersion !== COST_CALCULATION_VERSION || event.costStatus === "unpriced") return null;
  const explanation = explainCostAt({ ...event, occurredAt: event.ts, schedule: new Map([[revision.modelId, [revision]]]) });
  // Never present a reconstruction as stored evidence when input hints are missing or the result differs.
  if (!explanation.breakdown || Math.abs(explanation.resolution.costUsd - event.costUsd) > 1e-8) return null;
  return explanation;
}
