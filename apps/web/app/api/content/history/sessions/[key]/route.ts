import { getE2eeHistorySession } from "@/lib/e2ee-history";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

type RouteContext = { params: Promise<{ key: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");

  const { key } = await context.params;
  try {
    const detail = await getE2eeHistorySession(userId, key);
    if (!detail) return problem(404, "CONTENT_SESSION_NOT_FOUND");
    return noStore(Response.json(detail));
  } catch {
    return problem(500, "CONTENT_HISTORY_FAILED");
  }
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
