import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import {
  getManagedContentRuntime,
  type ManagedContentRuntime,
} from "@/lib/managed-content-runtime";
import { parsePromptBatch, PromptWireError } from "@/lib/prompt-wire";
import {
  E2eePromptSaveError,
  saveE2eePromptRecords,
  saveManagedPromptRecords,
} from "@/lib/prompt-records";

// 프롬프트/응답 본문 수신 — shim 본문 수집 경로 (opt-in, /events 와 분리).
// schema 없는 plaintext는 managed 봉투 암호화 후 prompt_records(RLS 소유자전용)에 저장한다.
// managed key provider 미설정/장애 시 평문은 저장하지 않고 안전한 503 code만 반환한다.
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 배치 상한 4MB (/events 와 동일)

type PromptsPostDeps = {
  authenticateIngestToken: typeof authenticateIngestToken;
  loadProviders: typeof loadProviders;
  getManagedContentRuntime: typeof getManagedContentRuntime;
  saveManagedPromptRecords: typeof saveManagedPromptRecords;
  saveE2eePromptRecords: typeof saveE2eePromptRecords;
};

const defaultPromptsPostDeps: PromptsPostDeps = {
  authenticateIngestToken,
  loadProviders,
  getManagedContentRuntime,
  saveManagedPromptRecords,
  saveE2eePromptRecords,
};

function createPromptsPost(overrides: Partial<PromptsPostDeps> = {}) {
  const deps = { ...defaultPromptsPostDeps, ...overrides };
  return (req: Request) => postPrompts(req, deps);
}

async function postPrompts(req: Request, deps: PromptsPostDeps): Promise<Response> {
  // 1. 인증 — 토큰 user_id 가 소유자 SSOT, 본문에 userId 없음 (§10.1)
  const auth = await deps.authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return new Response("payload too large (max 4MB)", { status: 413 });
  }

  // 3. 와이어 계약 검증
  let batch;
  try {
    batch = parsePromptBatch(JSON.parse(text));
  } catch (e) {
    const msg = e instanceof PromptWireError ? e.message : "본문이 유효한 JSON 이 아닙니다";
    return new Response(msg, { status: 400 });
  }
  if (batch.records.length === 0) return Response.json({ inserted: 0, deduped: 0 });

  // 4. provider 실재 검증 (/events 와 동일 — 등록된 provider 만 허용)
  const providers = await deps.loadProviders();
  const known = new Set(providers.map((p) => p.key));
  const unknown = [...new Set(batch.records.map((r) => r.providerKey))].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return new Response(`등록되지 않은 provider: ${unknown.join(", ")}`, { status: 400 });
  }

  // 5. transitional E2EE는 암호문 그대로 저장한다.
  if (batch.schema === "e2ee_v1") {
    try {
      return Response.json(await deps.saveE2eePromptRecords(auth.userId, batch.records));
    } catch (error) {
      if (error instanceof E2eePromptSaveError) {
        return Response.json({ code: error.code }, { status: 400 });
      }
      return Response.json({ code: "E2EE_PROMPT_SAVE_FAILED" }, { status: 500 });
    }
  }

  let runtime: ManagedContentRuntime | null;
  try {
    runtime = await deps.getManagedContentRuntime();
  } catch {
    return managedUnavailableResponse("CONTENT_KEY_UNAVAILABLE");
  }
  if (!runtime) {
    return managedUnavailableResponse("CONTENT_COLLECTION_DISABLED");
  }
  try {
    return Response.json(
      await deps.saveManagedPromptRecords(auth.userId, batch.records, runtime),
    );
  } catch {
    return managedUnavailableResponse("CONTENT_KEY_UNAVAILABLE");
  }
}

type ManagedFailureCode =
  | "CONTENT_COLLECTION_DISABLED"
  | "CONTENT_KEY_UNAVAILABLE";

function managedUnavailableResponse(code: ManagedFailureCode): Response {
  return Response.json(
    { code },
    {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export const POST = Object.assign(createPromptsPost(), {
  withDependencies: createPromptsPost,
});
