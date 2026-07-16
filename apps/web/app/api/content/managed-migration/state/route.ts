import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import {
  E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES,
  migrationContractErrorCode,
  parseE2eeManagedState,
} from "@/lib/e2ee-to-managed-contract";
import {
  e2eeManagedMigrationErrorCode,
  e2eeManagedMigrationHttpStatus,
  setE2eeManagedMigrationState,
} from "@/lib/e2ee-to-managed-migration";
import { readBoundedJson } from "@/lib/tool-ingest";

export async function POST(request: Request): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  let userId: string | null;
  try { userId = await requireContentSession(); }
  catch { return problem(503, "MIGRATION_FAILED"); }
  if (!userId) return problem(401, "UNAUTHORIZED");
  let input;
  try {
    input = parseE2eeManagedState(await readBoundedJson(request, E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof RangeError) return problem(413, "MIGRATION_PAYLOAD_TOO_LARGE");
    return problem(400, migrationContractErrorCode(error) ?? "INVALID_JSON");
  }
  try { return noStore(Response.json(await setE2eeManagedMigrationState(userId, input))); }
  catch (error) {
    const code = e2eeManagedMigrationErrorCode(error) ?? "MIGRATION_FAILED";
    return problem(e2eeManagedMigrationHttpStatus(code), code);
  }
}

function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
