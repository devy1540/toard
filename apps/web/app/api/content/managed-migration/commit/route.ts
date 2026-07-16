import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";
import {
  E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES,
  migrationContractErrorCode,
  parseE2eeManagedCommit,
} from "@/lib/e2ee-to-managed-contract";
import {
  commitE2eeManagedBatch,
  e2eeManagedMigrationErrorCode,
} from "@/lib/e2ee-to-managed-migration";
import {
  getManagedContentRuntime,
  type ManagedContentRuntime,
} from "@/lib/managed-content-runtime";
import { readBoundedJson } from "@/lib/tool-ingest";

type Dependencies = {
  isAuthOpen: () => boolean;
  requireSession: () => Promise<string | null>;
  getRuntime: () => Promise<ManagedContentRuntime | null>;
  commit: typeof commitE2eeManagedBatch;
};

const defaults: Dependencies = {
  isAuthOpen: isContentAuthOpen,
  requireSession: requireContentSession,
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
  const userId = await dependencies.requireSession();
  if (!userId) return problem(401, "UNAUTHORIZED");

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
    if (code === "MANAGED_KEY_UNAVAILABLE" || code === "MANAGED_KEY_INVALID") {
      return problem(503, code);
    }
    return problem(409, code);
  }
}

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
