import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import {
  e2eeManagedMigrationErrorCode,
  e2eeManagedMigrationHttpStatus,
  getE2eeManagedMigrationStatus,
} from "@/lib/e2ee-to-managed-migration";

export async function GET(): Promise<Response> {
  return getManagedMigrationStatusResponse({
    isAuthOpen: isContentAuthOpen,
    requireSession: requireContentSession,
    status: getE2eeManagedMigrationStatus,
  });
}

type StatusDependencies = {
  isAuthOpen(): boolean;
  requireSession(): Promise<string | null>;
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
  try { return noStore(Response.json(await dependencies.status(userId))); }
  catch (error) {
    const code = e2eeManagedMigrationErrorCode(error) ?? "MIGRATION_FAILED";
    return problem(e2eeManagedMigrationHttpStatus(code), code);
  }
}

function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
