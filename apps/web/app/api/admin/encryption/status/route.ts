import {
  getEncryptionAdminStatus,
  type EncryptionAdminStatus,
} from "@/lib/encryption-admin-status";
import { getSessionUser, type SessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  getSessionUser(): Promise<SessionUser | null>;
  getEncryptionAdminStatus(): Promise<EncryptionAdminStatus>;
};

const defaults: Dependencies = { getSessionUser, getEncryptionAdminStatus };

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function createGet(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function GET(): Promise<Response> {
    try {
      const user = await dependencies.getSessionUser();
      if (!user) return noStoreJson({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return noStoreJson({ error: "forbidden" }, 403);
      return noStoreJson(await dependencies.getEncryptionAdminStatus());
    } catch {
      return noStoreJson({ error: "internal error" }, 500);
    }
  };
}

export const GET = Object.assign(createGet(), { withDependencies: createGet });
