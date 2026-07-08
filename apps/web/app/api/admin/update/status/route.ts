import { getServerUpdateStatus } from "@/lib/server-update";
import { getSessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json(await getServerUpdateStatus(), { headers: { "cache-control": "no-store" } });
}
