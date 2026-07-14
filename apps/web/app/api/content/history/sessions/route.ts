import { getE2eeHistorySessions } from "@/lib/e2ee-history";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

export async function GET(request: Request): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");

  const url = new URL(request.url);
  const limit = parseInteger(url.searchParams.get("limit"));
  const offset = parseInteger(url.searchParams.get("offset"));
  try {
    const page = await getE2eeHistorySessions(userId, { limit, offset });
    return noStore(Response.json(page));
  } catch {
    return problem(500, "CONTENT_HISTORY_FAILED");
  }
}

function parseInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
