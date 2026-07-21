import { listPendingApprovalRequests } from "@/lib/content-accounts";
import { authenticateIngestToken } from "@/lib/ingest-auth";
import { getLegacyE2eeCapability, type LegacyE2eeCapability } from "@/lib/e2ee-legacy-gate";

type Dependencies = {
  authenticate: typeof authenticateIngestToken;
  capability(userId: string): Promise<LegacyE2eeCapability>;
  list: typeof listPendingApprovalRequests;
};

const defaults: Dependencies = {
  authenticate: authenticateIngestToken,
  capability: getLegacyE2eeCapability,
  list: listPendingApprovalRequests,
};

function createPost(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function POST(request: Request): Promise<Response> {
    let auth;
    try { auth = await dependencies.authenticate(request.headers.get("authorization")); }
    catch { return problem(500, "DEVICE_APPROVAL_LIST_FAILED"); }
    if (!auth) return problem(401, "UNAUTHORIZED");
    try {
      const capability = await dependencies.capability(auth.userId);
      if (capability === "disabled") return problem(410, "E2EE_SETUP_RETIRED");
      return noStore(Response.json({ requests: await dependencies.list(auth.userId) }));
    } catch {
      return problem(500, "DEVICE_APPROVAL_LIST_FAILED");
    }
  };
}

export const POST = Object.assign(createPost(), { withDependencies: createPost });
function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
