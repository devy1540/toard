import { parseToolActivityBody } from "@toard/core";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { ingestToolActivity, readBoundedJson, toolIngestClientError } from "@/lib/tool-ingest";

const MAX_BODY_BYTES = 512 * 1024;

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });
  try {
    const events = parseToolActivityBody(await readBoundedJson(req, MAX_BODY_BYTES));
    const providers = new Set((await loadProviders()).map((provider) => provider.key));
    const unknown = [...new Set(events.map((event) => event.providerKey))].filter((key) => !providers.has(key));
    if (unknown.length > 0) return new Response(`등록되지 않은 provider: ${unknown.join(", ")}`, { status: 400 });
    return Response.json(await ingestToolActivity(auth, events));
  } catch (error) {
    const response = toolIngestClientError(error);
    if (response) return response;
    throw error;
  }
}
