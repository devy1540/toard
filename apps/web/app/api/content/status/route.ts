import { getE2eeContentStatus } from "@/lib/e2ee-history";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

export async function GET(): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  try {
    return noStore(Response.json(await getE2eeContentStatus(userId)));
  } catch {
    return problem(500, "CONTENT_STATUS_FAILED");
  }
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
