import { ContentAccountError, activateContentAccount } from "@/lib/content-accounts";
import { E2eeContractError } from "@/lib/e2ee-contract";
import { authenticateIngestToken } from "@/lib/ingest-auth";

const MAX_BODY_BYTES = 32 * 1024;

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return problem(401, "UNAUTHORIZED");

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return problem(413, "PAYLOAD_TOO_LARGE");
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return problem(400, "INVALID_JSON");
  }

  try {
    const activated = await activateContentAccount(auth.userId, input);
    return noStore(Response.json(activated));
  } catch (error) {
    if (error instanceof ContentAccountError) return problem(400, error.code);
    if (error instanceof E2eeContractError) return problem(400, "INVALID_E2EE_PAYLOAD");
    return problem(500, "CONTENT_ACTIVATION_FAILED");
  }
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
