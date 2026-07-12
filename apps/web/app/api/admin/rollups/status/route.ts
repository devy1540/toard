import { getRollupAdminStatus, type RollupAdminStatus } from "@/lib/rollup-status";
import { getSessionUser, type SessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

type StatusDependencies = {
  getSessionUser(): Promise<SessionUser | null>;
  getRollupAdminStatus(): Promise<RollupAdminStatus>;
};

const defaultDependencies: StatusDependencies = {
  getSessionUser,
  getRollupAdminStatus,
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function createGet(overrides: Partial<StatusDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async function GET(): Promise<Response> {
    try {
      const user = await dependencies.getSessionUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      return json(await dependencies.getRollupAdminStatus());
    } catch {
      return json({ error: "internal error" }, 500);
    }
  };
}

export const GET = Object.assign(createGet(), {
  withDependencies: createGet,
});
