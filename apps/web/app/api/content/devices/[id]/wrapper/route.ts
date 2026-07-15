import { ContentAccountError, getDeviceWrapper } from "@/lib/content-accounts";
import { isContentAuthOpen, requireContentSession } from "@/lib/content-session";

type RouteContext = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
  const userId = await requireContentSession();
  if (!userId) return problem(401, "UNAUTHORIZED");
  const { id } = await context.params;
  try { return noStore(Response.json(await getDeviceWrapper(userId, id))); }
  catch (error) {
    const code = error instanceof ContentAccountError ? error.code : "DEVICE_WRAPPER_READ_FAILED";
    return problem(code === "DEVICE_WRAPPER_READ_FAILED" ? 500 : 404, code);
  }
}
function problem(status: number, code: string): Response { return noStore(Response.json({ code }, { status })); }
function noStore(response: Response): Response { response.headers.set("Cache-Control", "no-store"); return response; }
