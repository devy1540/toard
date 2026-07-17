import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import { getLegacyE2eeCapability, type LegacyE2eeCapability } from "@/lib/e2ee-legacy-gate";
import { parseE2eeManagedLimit } from "@/lib/e2ee-to-managed-contract";
import {
  e2eeManagedMigrationErrorCode,
  e2eeManagedMigrationHttpStatus,
  getE2eeManagedMigrationPage,
} from "@/lib/e2ee-to-managed-migration";

export async function GET(request: Request): Promise<Response> {
  return getManagedMigrationPageResponse(request, {
    isAuthOpen: isContentAuthOpen,
    requireSession: requireContentSession,
    capability: getLegacyE2eeCapability,
    page: getE2eeManagedMigrationPage,
  });
}

type Dependencies = {
  isAuthOpen(): boolean;
  requireSession(): Promise<string | null>;
  capability(userId: string): Promise<LegacyE2eeCapability>;
  page(userId: string, limit: number): Promise<unknown>;
};

export async function getManagedMigrationPageResponse(request: Request, dependencies: Dependencies): Promise<Response> {
  if (dependencies.isAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  let userId: string | null;
  try { userId = await dependencies.requireSession(); }
  catch { return problem(503, "MIGRATION_FAILED"); }
  if (!userId) return problem(401, "UNAUTHORIZED");
  let capability: LegacyE2eeCapability;
  try { capability = await dependencies.capability(userId); }
  catch { return problem(500, "E2EE_LEGACY_GATE_FAILED"); }
  if (capability === "disabled") return problem(410, "E2EE_SETUP_RETIRED");
  let limit: number;
  try { limit = parseE2eeManagedLimit(new URL(request.url).searchParams.get("limit")); }
  catch { return problem(400, "INVALID_MIGRATION_LIMIT"); }
  try {
    return noStore(Response.json(await dependencies.page(userId, limit)));
  } catch (error) {
    const code = e2eeManagedMigrationErrorCode(error) ?? "MIGRATION_FAILED";
    return problem(e2eeManagedMigrationHttpStatus(code), code);
  }
}

function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
