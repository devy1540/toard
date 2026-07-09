import { loadKek } from "@/lib/content-crypto";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { parsePromptRecordsBody, PromptWireError } from "@/lib/prompt-wire";
import { savePromptRecords } from "@/lib/prompt-records";

// 프롬프트/응답 본문 수신 — shim 본문 수집 경로 (opt-in, /events 와 분리).
// 본문은 서버에서 봉투 암호화 후 prompt_records(RLS 소유자전용)에 저장한다.
// KEK 미설정이면 본문 수집이 서버에서 꺼진 것 → 503.
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 배치 상한 4MB (/events 와 동일)

export async function POST(req: Request): Promise<Response> {
  // 1. 인증 — 토큰 user_id 가 소유자 SSOT, 본문에 userId 없음 (§10.1)
  const auth = await authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });

  // 2. 본문 수집 활성화 게이트 = KEK 설정 여부 (운영자 opt-in)
  let kek: Buffer;
  try {
    kek = loadKek();
  } catch {
    return new Response("prompt content collection disabled (TOARD_CONTENT_KEK_B64 미설정)", {
      status: 503,
    });
  }

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return new Response("payload too large (max 4MB)", { status: 413 });
  }

  // 3. 와이어 계약 검증
  let records;
  try {
    records = parsePromptRecordsBody(JSON.parse(text));
  } catch (e) {
    const msg = e instanceof PromptWireError ? e.message : "본문이 유효한 JSON 이 아닙니다";
    return new Response(msg, { status: 400 });
  }
  if (records.length === 0) return Response.json({ inserted: 0, deduped: 0 });

  // 4. provider 실재 검증 (/events 와 동일 — 등록된 provider 만 허용)
  const providers = await loadProviders();
  const known = new Set(providers.map((p) => p.key));
  const unknown = [...new Set(records.map((r) => r.providerKey))].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return new Response(`등록되지 않은 provider: ${unknown.join(", ")}`, { status: 400 });
  }

  // 5. 암호화 + 멱등 저장 (RLS 컨텍스트 안에서)
  const res = await savePromptRecords(auth.userId, records, kek);
  return Response.json(res);
}
