import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import { parseE2eeManagedLimit } from "@/lib/e2ee-to-managed-contract";
import {
  e2eeManagedMigrationErrorCode,
  e2eeManagedMigrationHttpStatus,
  getE2eeManagedMigrationPage,
} from "@/lib/e2ee-to-managed-migration";

export async function GET(request: Request): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  let userId: string | null;
  try { userId = await requireContentSession(); }
  catch { return problem(503, "MIGRATION_FAILED"); }
  if (!userId) return problem(401, "UNAUTHORIZED");
  let limit: number;
  try { limit = parseE2eeManagedLimit(new URL(request.url).searchParams.get("limit")); }
  catch { return problem(400, "INVALID_MIGRATION_LIMIT"); }
  try {
    return noStore(Response.json(await getE2eeManagedMigrationPage(userId, limit)));
  } catch (error) {
    const code = e2eeManagedMigrationErrorCode(error) ?? "MIGRATION_FAILED";
    return problem(e2eeManagedMigrationHttpStatus(code), code);
  }
}

function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
