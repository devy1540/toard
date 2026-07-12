import { getPool } from "@/lib/db";
import {
  PgRollupWorkerRepository,
  shadowWorkerEnabled,
  type RollupWorkerName,
} from "@/lib/rollup-worker-state";
import { getSessionUser, type SessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

type ControlAction = "pause" | "resume";
type ControlRequest = { worker: RollupWorkerName; action: ControlAction };
type ControlDependencies = {
  getSessionUser(): Promise<SessionUser | null>;
  hardEnabled(worker: RollupWorkerName): boolean;
  setPaused(
    worker: RollupWorkerName,
    paused: boolean,
  ): Promise<{ worker: RollupWorkerName; paused: boolean }>;
};

const workers = new Set<RollupWorkerName>(["usage_15m_v2", "timezone"]);
const actions = new Set<ControlAction>(["pause", "resume"]);

const defaultDependencies: ControlDependencies = {
  getSessionUser,
  hardEnabled(worker) {
    const key = worker === "usage_15m_v2"
      ? "CLICKHOUSE_15M_V2_COMPACTOR"
      : "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR";
    return shadowWorkerEnabled(process.env, key);
  },
  async setPaused(worker, paused) {
    const repository = new PgRollupWorkerRepository(getPool());
    return repository.setPaused(worker, paused);
  },
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function parseControlRequest(value: unknown): ControlRequest | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("worker") || !keys.includes("action")) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.worker !== "string" || !workers.has(body.worker as RollupWorkerName)) return null;
  if (typeof body.action !== "string" || !actions.has(body.action as ControlAction)) return null;
  return {
    worker: body.worker as RollupWorkerName,
    action: body.action as ControlAction,
  };
}

function createPost(overrides: Partial<ControlDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async function POST(request: Request): Promise<Response> {
    try {
      const user = await dependencies.getSessionUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);

      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return json({ error: "invalid request" }, 400);
      }
      const body = parseControlRequest(rawBody);
      if (!body) return json({ error: "invalid request" }, 400);
      if (body.action === "resume" && !dependencies.hardEnabled(body.worker)) {
        return json({ error: "disabled by server configuration" }, 409);
      }

      const record = await dependencies.setPaused(body.worker, body.action === "pause");
      return json({ worker: record.worker, paused: record.paused });
    } catch {
      return json({ error: "internal error" }, 500);
    }
  };
}

export const POST = Object.assign(createPost(), {
  withDependencies: createPost,
});
