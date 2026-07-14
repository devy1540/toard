import { loadKek } from "@/lib/content-crypto";
import { commitLegacyMigrationBatch, LegacyMigrationError } from "@/lib/e2ee-legacy-migration";
import { parseLegacyMigrationCommit } from "@/lib/e2ee-legacy-contract";
import { E2eeContractError } from "@/lib/e2ee-contract";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

export async function POST(request: Request): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  const deviceId = request.headers.get("x-toard-content-device-id");
  if (!deviceId) return problem(400, "CONTENT_DEVICE_REQUIRED");
  let items;
  try { items = parseLegacyMigrationCommit(await request.json()); }
  catch (error) {
    return problem(400, error instanceof E2eeContractError ? "INVALID_LEGACY_MIGRATION_BATCH" : "INVALID_JSON");
  }
  let kek: Buffer;
  try { kek = loadKek(); } catch { return problem(503, "LEGACY_KEK_UNAVAILABLE"); }
  try {
    return noStore(Response.json(await commitLegacyMigrationBatch(userId, deviceId, items, kek)));
  } catch (error) {
    const code = error instanceof LegacyMigrationError ? error.code : "LEGACY_MIGRATION_FAILED";
    const status = code === "CONTENT_DEVICE_UNAPPROVED" ? 403 : 409;
    return problem(status, code);
  }
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
