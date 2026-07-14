import { loadKek } from "@/lib/content-crypto";
import { getLegacyMigrationStatus } from "@/lib/e2ee-legacy-migration";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

export async function GET(): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  let kekAvailable = true;
  try { loadKek(); } catch { kekAvailable = false; }
  try {
    return noStore(Response.json(await getLegacyMigrationStatus(userId, kekAvailable)));
  } catch {
    return problem(409, "E2EE_ACCOUNT_NOT_ACTIVE");
  }
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
