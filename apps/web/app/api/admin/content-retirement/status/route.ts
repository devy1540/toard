import { getLegacyRetirementStatus, type LegacyRetirementStatus } from "@/lib/e2ee-legacy-retirement";
import { getSessionUser, type SessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  getSessionUser(): Promise<SessionUser | null>;
  getLegacyRetirementStatus(): Promise<LegacyRetirementStatus>;
};

const defaults: Dependencies = { getSessionUser, getLegacyRetirementStatus };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function createGet(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function GET() {
    try {
      const user = await dependencies.getSessionUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      return json(await dependencies.getLegacyRetirementStatus());
    } catch {
      return json({ error: "internal error" }, 500);
    }
  };
}

export const GET = Object.assign(createGet(), { withDependencies: createGet });
