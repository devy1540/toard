import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import { getLegacyE2eeCapability, type LegacyE2eeCapability } from "@/lib/e2ee-legacy-gate";
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

type Dependencies = {
  isAuthOpen(): boolean;
  requireSession(): Promise<string | null>;
  capability(userId: string): Promise<LegacyE2eeCapability>;
  state(userId: string, input: Parameters<typeof setE2eeManagedMigrationState>[1]): Promise<unknown>;
};

const defaults: Dependencies = {
  isAuthOpen: isContentAuthOpen,
  requireSession: requireContentSession,
  capability: getLegacyE2eeCapability,
  state: setE2eeManagedMigrationState,
};

function createPost(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function POST(request: Request): Promise<Response> {
  if (dependencies.isAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  let userId: string | null;
  try { userId = await dependencies.requireSession(); }
  catch { return problem(503, "MIGRATION_FAILED"); }
  if (!userId) return problem(401, "UNAUTHORIZED");
  let capability: LegacyE2eeCapability;
  try { capability = await dependencies.capability(userId); }
  catch { return problem(500, "E2EE_LEGACY_GATE_FAILED"); }
  if (capability === "disabled") return problem(410, "E2EE_SETUP_RETIRED");
  let input;
  try {
    input = parseE2eeManagedState(await readBoundedJson(request, E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof RangeError) return problem(413, "MIGRATION_PAYLOAD_TOO_LARGE");
    return problem(400, migrationContractErrorCode(error) ?? "INVALID_JSON");
  }
  try { return noStore(Response.json(await dependencies.state(userId, input))); }
  catch (error) {
    const code = e2eeManagedMigrationErrorCode(error) ?? "MIGRATION_FAILED";
    return problem(e2eeManagedMigrationHttpStatus(code), code);
  }
  };
}

export const POST = Object.assign(createPost(), { withDependencies: createPost });

function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
