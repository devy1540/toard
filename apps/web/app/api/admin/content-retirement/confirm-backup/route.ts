import { confirmLegacyBackupPurge, LegacyRetirementError, type LegacyRetirementStatus } from "@/lib/e2ee-legacy-retirement";
import { getSessionUser, type SessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  getSessionUser(): Promise<SessionUser | null>;
  confirmLegacyBackupPurge(adminUserId: string): Promise<LegacyRetirementStatus>;
};

const defaults: Dependencies = { getSessionUser, confirmLegacyBackupPurge };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function createPost(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function POST(_request: Request) {
    try {
      const user = await dependencies.getSessionUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      return json(await dependencies.confirmLegacyBackupPurge(user.id));
    } catch (error) {
      if (error instanceof LegacyRetirementError) return json({ error: error.code }, 409);
      return json({ error: "internal error" }, 500);
    }
  };
}

export const POST = Object.assign(createPost(), { withDependencies: createPost });
