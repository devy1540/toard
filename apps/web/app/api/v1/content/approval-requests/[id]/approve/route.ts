import { ContentAccountError, approveRequest } from "@/lib/content-accounts";
import { authenticateIngestToken } from "@/lib/ingest-auth";

type RouteContext = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const auth = await authenticateIngestToken(request.headers.get("authorization"));
  if (!auth) return problem(401, "UNAUTHORIZED");
  const { id } = await context.params;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["confirmationCode", "envelope"].includes(key))) {
      return problem(400, "INVALID_APPROVAL_BODY");
    }
    return noStore(Response.json(await approveRequest(auth.userId, id, String(body.confirmationCode ?? ""), body.envelope)));
  } catch (error) {
    const code = error instanceof ContentAccountError ? error.code : "DEVICE_APPROVAL_FAILED";
    return problem(code === "DEVICE_APPROVAL_FAILED" ? 500 : 400, code);
  }
}
function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
