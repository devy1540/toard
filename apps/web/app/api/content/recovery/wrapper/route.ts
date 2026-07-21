import { ContentAccountError, getRecoveryWrapper } from "@/lib/content-accounts";
import {
  getLegacyE2eeCapability,
  type LegacyE2eeCapability,
} from "@/lib/e2ee-legacy-gate";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

type Dependencies = {
  isAuthOpen(): boolean;
  requireSession(): Promise<string | null>;
  capability(userId: string): Promise<LegacyE2eeCapability>;
  getWrapper(userId: string): Promise<unknown>;
};

const defaults: Dependencies = {
  isAuthOpen: isContentAuthOpen,
  requireSession: requireContentSession,
  capability: getLegacyE2eeCapability,
  getWrapper: getRecoveryWrapper,
};

function createGet(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function GET(): Promise<Response> {
  if (dependencies.isAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  let userId: string | null;
  try { userId = await dependencies.requireSession(); }
  catch { return problem(500, "RECOVERY_WRAPPER_READ_FAILED"); }
  if (!userId) return problem(401, "UNAUTHORIZED");
  let capability: LegacyE2eeCapability;
  try { capability = await dependencies.capability(userId); }
  catch { return problem(500, "E2EE_LEGACY_GATE_FAILED"); }
  if (capability === "disabled") return problem(410, "E2EE_SETUP_RETIRED");
  try { return noStore(Response.json(await dependencies.getWrapper(userId))); }
  catch (error) {
    const code = error instanceof ContentAccountError ? error.code : "RECOVERY_WRAPPER_READ_FAILED";
    return problem(code === "RECOVERY_WRAPPER_READ_FAILED" ? 500 : 404, code);
  }
  };
}

export const GET = Object.assign(createGet(), { withDependencies: createGet });
function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
