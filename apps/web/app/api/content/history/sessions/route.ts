import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import { loadE2eeHistoryPage } from "@/lib/e2ee-history-page";
import { getStorage } from "@/lib/storage";
import { getViewerTimezone } from "@/lib/viewer-time";
import { getHistoryMfaGate } from "@/lib/history-mfa";

export async function GET(request: Request): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  const mfa = await getHistoryMfaGate(userId);
  if (mfa.required && !mfa.verified) return problem(403, "MFA_REQUIRED");

  const url = new URL(request.url);
  try {
    const page = await loadE2eeHistoryPage({
      userId,
      searchParams: url.searchParams,
      timezone: await getViewerTimezone(),
      loadUsage: (ownerId, sessionIds) =>
        getStorage().getSessionUsageSummaries(ownerId, sessionIds),
    });
    return noStore(Response.json(page));
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
