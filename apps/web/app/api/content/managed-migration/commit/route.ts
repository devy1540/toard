import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import { getLegacyE2eeCapability, type LegacyE2eeCapability } from "@/lib/e2ee-legacy-gate";
import {
  E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES,
  migrationContractErrorCode,
  parseE2eeManagedCommit,
} from "@/lib/e2ee-to-managed-contract";
import {
  commitE2eeManagedBatch,
  e2eeManagedMigrationErrorCode,
  e2eeManagedMigrationHttpStatus,
} from "@/lib/e2ee-to-managed-migration";
import {
  getManagedContentRuntime,
  type ManagedContentRuntime,
} from "@/lib/managed-content-runtime";
import { readBoundedJson } from "@/lib/tool-ingest";

type Dependencies = {
  isAuthOpen: () => boolean;
  requireSession: () => Promise<string | null>;
  capability: (userId: string) => Promise<LegacyE2eeCapability>;
  getRuntime: () => Promise<ManagedContentRuntime | null>;
  commit: typeof commitE2eeManagedBatch;
};

const defaults: Dependencies = {
  isAuthOpen: isContentAuthOpen,
  requireSession: requireContentSession,
  capability: getLegacyE2eeCapability,
  getRuntime: getManagedContentRuntime,
  commit: commitE2eeManagedBatch,
};

export async function POST(request: Request): Promise<Response> {
  return postManagedMigrationCommit(request, defaults);
}

export async function postManagedMigrationCommit(
  request: Request,
  dependencies: Dependencies,
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

  let items;
  try {
    const body = await readBoundedJson(request, E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES);
    items = parseE2eeManagedCommit(body);
  } catch (error) {
    if (error instanceof RangeError) return problem(413, "MIGRATION_PAYLOAD_TOO_LARGE");
    return problem(400, migrationContractErrorCode(error) ?? "INVALID_JSON");
  }

  let runtime: ManagedContentRuntime | null;
  try { runtime = await dependencies.getRuntime(); }
  catch { return problem(503, "MANAGED_KEY_UNAVAILABLE"); }
  if (!runtime) return problem(503, "MANAGED_KEY_UNAVAILABLE");
  try {
    return noStore(Response.json(await dependencies.commit(userId, items, runtime)));
  } catch (error) {
    const code = e2eeManagedMigrationErrorCode(error);
    if (!code) return problem(503, "MIGRATION_FAILED");
    return problem(e2eeManagedMigrationHttpStatus(code), code);
  }
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
