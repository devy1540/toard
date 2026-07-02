import { fetchLiteLLMPricing } from "@toard/pricing";
import { getPool } from "@/lib/db";
import { orgDate } from "@/lib/org-time";
import { invalidatePricingCache } from "@/lib/pricing";

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

  const day = orgDate(0);
  const client = await getPool().connect();
  let upserted = 0;
  try {
    await client.query("BEGIN");
    // 건당 UPSERT 대신 청크 배치(다중 VALUES)로 라운드트립·클라이언트 점유시간 단축
    const entries = [...pricing.entries()];
    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const params: unknown[] = [day]; // $1 = effective_date (전 row 공통)
      const rows: string[] = [];
      for (const [modelId, p] of chunk) {
        const b = params.length + 1;
        rows.push(
          `($${b},$${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$1::date,'litellm')`,
        );
        params.push(
          modelId, p.inputPerM, p.outputPerM, p.cacheReadPerM ?? null,
          p.cacheCreatePerM ?? null, p.inputAbove200kPerM ?? null,
          p.outputAbove200kPerM ?? null, p.fastMultiplier ?? 1,
        );
      }
      await client.query(
        `INSERT INTO pricing_models
           (model_id, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok,
            cache_creation_price_per_mtok, input_price_above_200k_per_mtok,
            output_price_above_200k_per_mtok, fast_multiplier, effective_date, source)
         VALUES ${rows.join(",")}
         ON CONFLICT (model_id, effective_date) DO UPDATE SET
           input_price_per_mtok            = EXCLUDED.input_price_per_mtok,
           output_price_per_mtok           = EXCLUDED.output_price_per_mtok,
           cache_read_price_per_mtok       = EXCLUDED.cache_read_price_per_mtok,
           cache_creation_price_per_mtok   = EXCLUDED.cache_creation_price_per_mtok,
           input_price_above_200k_per_mtok = EXCLUDED.input_price_above_200k_per_mtok,
           output_price_above_200k_per_mtok = EXCLUDED.output_price_above_200k_per_mtok,
           fast_multiplier                 = EXCLUDED.fast_multiplier,
           source                          = 'litellm'`,
        params,
      );
      upserted += chunk.length;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  } finally {
    client.release();
  }

  invalidatePricingCache(); // 새 스냅샷 즉시 반영
  return Response.json({ ok: true, upserted, day });
}
