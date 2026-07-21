import { prepareContentAccount } from "@/lib/content-accounts";
import { authenticateIngestToken } from "@/lib/ingest-auth";

type Dependencies = {
  authenticate: typeof authenticateIngestToken;
  prepare: typeof prepareContentAccount;
};

const defaults: Dependencies = { authenticate: authenticateIngestToken, prepare: prepareContentAccount };

function createPost(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function POST(req: Request): Promise<Response> {
    let auth;
    try { auth = await dependencies.authenticate(req.headers.get("authorization")); }
    catch { return problem(500, "CONTENT_SETUP_FAILED"); }
    if (!auth) return problem(401, "UNAUTHORIZED");

    // 기존 계정이 pending이어도 신규 E2EE setup은 다시 열지 않는다.
    return problem(410, "E2EE_SETUP_RETIRED");
  };
}

export const POST = Object.assign(createPost(), { withDependencies: createPost });

function problem(status: number, code: string): Response {
  return noStore(Response.json({ code }, { status }));
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
