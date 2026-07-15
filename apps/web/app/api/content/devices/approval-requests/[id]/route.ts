import { ContentAccountError, consumeApprovedEnvelope } from "@/lib/content-accounts";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

type RouteContext = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  const { id } = await context.params;
  try {
    return noStore(Response.json({ state: "approved", ...(await consumeApprovedEnvelope(userId, id)) }));
  } catch (error) {
    if (error instanceof ContentAccountError && error.code === "DEVICE_APPROVAL_PENDING") {
      return noStore(Response.json({ state: "pending" }, { status: 202 }));
    }
    const code = error instanceof ContentAccountError ? error.code : "DEVICE_APPROVAL_READ_FAILED";
    const status = code === "DEVICE_APPROVAL_CONSUMED" ? 409 : code === "DEVICE_APPROVAL_READ_FAILED" ? 500 : 400;
    return problem(status, code);
  }
}
function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
