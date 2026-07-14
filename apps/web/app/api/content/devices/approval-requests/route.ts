import { ContentAccountError, createApprovalRequest } from "@/lib/content-accounts";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

export async function POST(request: Request): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  try {
    return noStore(Response.json(await createApprovalRequest(userId, await request.json()), { status: 201 }));
  } catch (error) {
    return accountProblem(error, "DEVICE_APPROVAL_CREATE_FAILED");
  }
}

function accountProblem(error: unknown, fallback: string): Response {
  const code = error instanceof ContentAccountError ? error.code : fallback;
  const status = code === fallback ? 500 : 400;
  return problem(status, code);
}
function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
