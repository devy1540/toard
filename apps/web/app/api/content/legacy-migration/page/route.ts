import { loadKek } from "@/lib/content-crypto";
import { parseLegacyMigrationLimit } from "@/lib/e2ee-legacy-contract";
import { getLegacyMigrationPage, LegacyMigrationError } from "@/lib/e2ee-legacy-migration";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

export async function GET(request: Request): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  const deviceId = request.headers.get("x-toard-content-device-id");
  if (!deviceId) return problem(400, "CONTENT_DEVICE_REQUIRED");
  const rawLimit = new URL(request.url).searchParams.get("limit") ?? "25";
  let limit: number;
  try { limit = parseLegacyMigrationLimit(rawLimit); }
  catch { return problem(400, "INVALID_MIGRATION_LIMIT"); }
  let kek: Buffer;
  try { kek = loadKek(); } catch { return problem(503, "LEGACY_KEK_UNAVAILABLE"); }
  try {
    return noStore(Response.json(await getLegacyMigrationPage(userId, deviceId, kek, limit)));
  } catch (error) {
    return migrationProblem(error);
  }
}

function migrationProblem(error: unknown): Response {
  const code = error instanceof LegacyMigrationError ? error.code : "LEGACY_MIGRATION_FAILED";
  const status = code === "CONTENT_DEVICE_UNAPPROVED" ? 403 : code === "LEGACY_SOURCE_CORRUPT" ? 409 : 500;
  return problem(status, code);
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
