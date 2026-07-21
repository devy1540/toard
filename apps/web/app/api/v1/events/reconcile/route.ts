import type {
  UsageEventReconciliationRequest,
  UsageEventReconciliationResult,
} from "@toard/core";
import { authenticateIngestToken } from "@/lib/ingest-auth";
import { getStorage } from "@/lib/storage";
import { readBoundedJson } from "@/lib/tool-ingest";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_DEDUP_KEYS = 1_000;
const DEDUP_KEY = /^[a-f0-9]{64}$/;

type ReconcilePostDeps = {
  authenticateIngestToken: typeof authenticateIngestToken;
  reconcileUsageEvents(
    request: UsageEventReconciliationRequest,
  ): Promise<UsageEventReconciliationResult>;
};

const defaultReconcilePostDeps: ReconcilePostDeps = {
  authenticateIngestToken,
  reconcileUsageEvents: (request) => getStorage().reconcileUsageEvents(request),
};

function createReconcilePost(overrides: Partial<ReconcilePostDeps> = {}) {
  const deps: ReconcilePostDeps = { ...defaultReconcilePostDeps, ...overrides };
  return (req: Request) => postReconciliation(req, deps);
}

async function postReconciliation(req: Request, deps: ReconcilePostDeps): Promise<Response> {
  const auth = await deps.authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await readBoundedJson(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return new Response(error.message, { status: 413 });
    }
    if (!(error instanceof SyntaxError)) throw error;
    return new Response("본문이 유효한 JSON 이 아닙니다", { status: 400 });
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as { dedupKeys?: unknown }).dedupKeys)) {
    return new Response("dedupKeys 배열이 필요합니다", { status: 400 });
  }
  const rawKeys = (body as { dedupKeys: unknown[] }).dedupKeys;
  if (rawKeys.length > MAX_DEDUP_KEYS) {
    return new Response("dedupKeys는 최대 1000개입니다", { status: 400 });
  }
  if (rawKeys.some((key) => typeof key !== "string" || !DEDUP_KEY.test(key))) {
    return new Response("dedupKeys는 64자리 소문자 SHA-256이어야 합니다", { status: 400 });
  }
  const dedupKeys = [...new Set(rawKeys as string[])];
  if (dedupKeys.length === 0) {
    return Response.json({ reconciled: 0 });
  }

  const result = await deps.reconcileUsageEvents({
    userId: auth.userId,
    providerKey: "codex",
    logAdapter: "codex",
    dedupKeys,
  });
  return Response.json({ reconciled: result.reconciled });
}

export const POST = Object.assign(createReconcilePost(), {
  withDependencies: createReconcilePost,
});
