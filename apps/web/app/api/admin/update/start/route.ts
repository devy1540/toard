import { startServerUpdate } from "@/lib/server-update";
import { getSessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return Response.json({ error: "forbidden" }, { status: 403 });
  const result = await startServerUpdate();
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}
