import { activateContentAccount } from "@/lib/content-accounts";
import { authenticateIngestToken } from "@/lib/ingest-auth";

type Dependencies = {
  authenticate: typeof authenticateIngestToken;
  activate: typeof activateContentAccount;
};

const defaults: Dependencies = { authenticate: authenticateIngestToken, activate: activateContentAccount };

function createPost(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function POST(req: Request): Promise<Response> {
    let auth;
    try { auth = await dependencies.authenticate(req.headers.get("authorization")); }
    catch { return problem(500, "CONTENT_ACTIVATION_FAILED"); }
    if (!auth) return problem(401, "UNAUTHORIZED");

    // 인증 후 body를 읽거나 계정 상태를 변경하지 않고 영구 폐기 응답을 보낸다.
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
