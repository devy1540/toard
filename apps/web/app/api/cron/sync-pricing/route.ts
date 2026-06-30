import { fetchLiteLLMPricing } from "@toard/pricing";
import { getPool } from "@/lib/db";
import { kstDate } from "@/lib/kst";

export const dynamic = "force-dynamic";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * LiteLLM 가격 동기화 cron (설계 §6.2).
 * fetch → per-million 변환 → pricing_models 에 당일(effective_date) UPSERT.
 * fetch 실패/0건이면 마지막 스냅샷 유지(검토 A-9). CRON_SECRET 설정 시 Bearer 인증.
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const url = process.env.LITELLM_PRICING_URL ?? DEFAULT_URL;
  let pricing;
  try {
    pricing = await fetchLiteLLMPricing(url);
  } catch (e) {
    // fail-safe: 기존 가격 스냅샷 유지
    return Response.json({ ok: false, kept: "snapshot", error: String(e) });
  }

  const day = kstDate(0);
  const client = await getPool().connect();
  let upserted = 0;
  try {
    await client.query("BEGIN");
    for (const [modelId, p] of pricing) {
      await client.query(
        `INSERT INTO pricing_models
           (model_id, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok,
            cache_creation_price_per_mtok, input_price_above_200k_per_mtok,
            output_price_above_200k_per_mtok, fast_multiplier, effective_date, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,'litellm')
         ON CONFLICT (model_id, effective_date) DO UPDATE SET
           input_price_per_mtok            = EXCLUDED.input_price_per_mtok,
           output_price_per_mtok           = EXCLUDED.output_price_per_mtok,
           cache_read_price_per_mtok       = EXCLUDED.cache_read_price_per_mtok,
           cache_creation_price_per_mtok   = EXCLUDED.cache_creation_price_per_mtok,
           input_price_above_200k_per_mtok = EXCLUDED.input_price_above_200k_per_mtok,
           output_price_above_200k_per_mtok = EXCLUDED.output_price_above_200k_per_mtok,
           fast_multiplier                 = EXCLUDED.fast_multiplier,
           source                          = 'litellm'`,
        [
          modelId, p.inputPerM, p.outputPerM, p.cacheReadPerM ?? null,
          p.cacheCreatePerM ?? null, p.inputAbove200kPerM ?? null,
          p.outputAbove200kPerM ?? null, p.fastMultiplier ?? 1, day,
        ],
      );
      upserted += 1;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  } finally {
    client.release();
  }

  return Response.json({ ok: true, upserted, day });
}
