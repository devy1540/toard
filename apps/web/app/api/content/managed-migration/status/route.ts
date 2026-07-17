import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import { getLegacyE2eeCapability, type LegacyE2eeCapability } from "@/lib/e2ee-legacy-gate";
import {
  e2eeManagedMigrationErrorCode,
  e2eeManagedMigrationHttpStatus,
  getE2eeManagedMigrationStatus,
} from "@/lib/e2ee-to-managed-migration";

export async function GET(): Promise<Response> {
  return getManagedMigrationStatusForSession();
}

export function getManagedMigrationStatusForSession(
  requireSession: StatusDependencies["requireSession"] = requireContentSession,
): Promise<Response> {
  return getManagedMigrationStatusResponse({
    isAuthOpen: isContentAuthOpen,
    requireSession,
    capability: getLegacyE2eeCapability,
    status: getE2eeManagedMigrationStatus,
  });
}

type StatusDependencies = {
  isAuthOpen(): boolean;
  requireSession(): Promise<string | null>;
  capability(userId: string): Promise<LegacyE2eeCapability>;
  status(userId: string): Promise<unknown>;
};

export async function getManagedMigrationStatusResponse(
  dependencies: StatusDependencies,
): Promise<Response> {
  if (dependencies.isAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  let userId: string | null;
  try { userId = await dependencies.requireSession(); }
  catch { return problem(503, "MIGRATION_FAILED"); }
  if (!userId) return problem(401, "UNAUTHORIZED");
  let capability: LegacyE2eeCapability;
  try { capability = await dependencies.capability(userId); }
  catch { return problem(500, "E2EE_LEGACY_GATE_FAILED"); }
  if (capability === "disabled") return problem(410, "E2EE_SETUP_RETIRED");
  try { return noStore(Response.json(await dependencies.status(userId))); }
  catch (error) {
    const code = e2eeManagedMigrationErrorCode(error) ?? "MIGRATION_FAILED";
    return problem(e2eeManagedMigrationHttpStatus(code), code);
  }
}

function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
