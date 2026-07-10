import { parseToolInventoryBody } from "@toard/core";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { ingestToolInventory, readBoundedJson, toolIngestClientError } from "@/lib/tool-ingest";

const MAX_BODY_BYTES = 1024 * 1024;

export async function PUT(req: Request): Promise<Response> {
  const auth = await authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });
  try {
    const snapshot = parseToolInventoryBody(await readBoundedJson(req, MAX_BODY_BYTES));
    const providers = new Set((await loadProviders()).map((provider) => provider.key));
    const unknown = [...new Set(snapshot.items.map((item) => item.sourceProvider))].filter((key) => !providers.has(key));
    if (unknown.length > 0) return new Response(`등록되지 않은 provider: ${unknown.join(", ")}`, { status: 400 });
    return Response.json(await ingestToolInventory(auth, snapshot));
  } catch (error) {
    const response = toolIngestClientError(error);
    if (response) return response;
    throw error;
  }
}
