import { prepareContentAccount } from "@/lib/content-accounts";
import { authenticateIngestToken } from "@/lib/ingest-auth";

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return problem(401, "UNAUTHORIZED");

  try {
    const prepared = await prepareContentAccount(auth.userId);
    return noStore(Response.json(prepared, { status: prepared.state === "pending" ? 201 : 200 }));
  } catch {
    return problem(500, "CONTENT_SETUP_FAILED");
  }
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
