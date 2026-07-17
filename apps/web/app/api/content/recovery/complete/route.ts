import { ContentAccountError, registerRecoveredBrowser } from "@/lib/content-accounts";
import {
  getLegacyE2eeCapability,
  type LegacyE2eeCapability,
} from "@/lib/e2ee-legacy-gate";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

type Dependencies = {
  isAuthOpen(): boolean;
  requireSession(): Promise<string | null>;
  capability(userId: string): Promise<LegacyE2eeCapability>;
  complete(userId: string, input: unknown): Promise<unknown>;
};

const defaults: Dependencies = {
  isAuthOpen: isContentAuthOpen,
  requireSession: requireContentSession,
  capability: getLegacyE2eeCapability,
  complete: registerRecoveredBrowser,
};

function createPost(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function POST(request: Request): Promise<Response> {
  if (dependencies.isAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  let userId: string | null;
  try { userId = await dependencies.requireSession(); }
  catch { return problem(500, "RECOVERY_COMPLETE_FAILED"); }
  if (!userId) return problem(401, "UNAUTHORIZED");
  let capability: LegacyE2eeCapability;
  try { capability = await dependencies.capability(userId); }
  catch { return problem(500, "E2EE_LEGACY_GATE_FAILED"); }
  if (capability === "disabled") return problem(410, "E2EE_SETUP_RETIRED");
  try { return noStore(Response.json(await dependencies.complete(userId, await request.json()), { status: 201 })); }
  catch (error) {
    const code = error instanceof ContentAccountError ? error.code : "RECOVERY_COMPLETE_FAILED";
    return problem(code === "RECOVERY_COMPLETE_FAILED" ? 500 : 400, code);
  }
  };
}

export const POST = Object.assign(createPost(), { withDependencies: createPost });
function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
