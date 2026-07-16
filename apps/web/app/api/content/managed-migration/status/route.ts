import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import { getE2eeManagedMigrationStatus } from "@/lib/e2ee-to-managed-migration";

export async function GET(): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  try { return noStore(Response.json(await getE2eeManagedMigrationStatus(userId))); }
  catch { return problem(409, "MIGRATION_STATUS_UNAVAILABLE"); }
}

function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
