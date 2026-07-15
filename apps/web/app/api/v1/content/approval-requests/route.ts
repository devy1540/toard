import { listPendingApprovalRequests } from "@/lib/content-accounts";
import { authenticateIngestToken } from "@/lib/ingest-auth";

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateIngestToken(request.headers.get("authorization"));
  if (!auth) return problem(401, "UNAUTHORIZED");
  try { return noStore(Response.json({ requests: await listPendingApprovalRequests(auth.userId) })); }
  catch { return problem(500, "DEVICE_APPROVAL_LIST_FAILED"); }
}
function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
