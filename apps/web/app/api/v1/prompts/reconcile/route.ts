import { authenticateIngestToken } from "@/lib/ingest-auth";
import { reconcilePromptAgentMetadata } from "@/lib/prompt-records";
import {
  parsePromptAgentMetadataReconciliationBody,
  PromptWireError,
  type PromptAgentMetadataReconciliationWire,
} from "@/lib/prompt-wire";
import { readBoundedJson } from "@/lib/tool-ingest";

const MAX_BODY_BYTES = 1024 * 1024;

type PromptAgentReconcilePostDeps = {
  authenticateIngestToken: typeof authenticateIngestToken;
  reconcilePromptAgentMetadata(
    userId: string,
    records: PromptAgentMetadataReconciliationWire[],
  ): Promise<{ reconciled: number }>;
};

const defaultDeps: PromptAgentReconcilePostDeps = {
  authenticateIngestToken,
  reconcilePromptAgentMetadata,
};

function createPost(overrides: Partial<PromptAgentReconcilePostDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  return (request: Request) => postReconciliation(request, deps);
}

async function postReconciliation(
  request: Request,
  deps: PromptAgentReconcilePostDeps,
): Promise<Response> {
  const auth = await deps.authenticateIngestToken(request.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });

  let records: PromptAgentMetadataReconciliationWire[];
  try {
    records = parsePromptAgentMetadataReconciliationBody(
      await readBoundedJson(request, MAX_BODY_BYTES),
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return new Response("payload too large (max 1MB)", { status: 413 });
    }
    const message = error instanceof PromptWireError
      ? error.message
      : "본문이 유효한 JSON 이 아닙니다";
    return new Response(message, { status: 400 });
  }

  if (records.length === 0) return Response.json({ reconciled: 0 });

  const unique = new Map<string, PromptAgentMetadataReconciliationWire>();
  for (const record of records) {
    const key = `${record.providerKey}:${record.dedupKey}`;
    const previous = unique.get(key);
    if (previous && JSON.stringify(previous.agent) !== JSON.stringify(record.agent)) {
      return new Response("동일 dedupKey에 상충하는 agent 메타데이터가 있습니다", { status: 400 });
    }
    unique.set(key, record);
  }

  return Response.json(
    await deps.reconcilePromptAgentMetadata(auth.userId, [...unique.values()]),
  );
}

export const POST = Object.assign(createPost(), {
  withDependencies: createPost,
});
