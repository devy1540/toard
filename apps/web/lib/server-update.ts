export type ServerUpdatePhase =
  | "unavailable"
  | "idle"
  | "latest"
  | "preflight"
  | "pulling"
  | "migrating"
  | "restarting"
  | "verifying"
  | "completed"
  | "failed";

export interface ServerUpdateStatus {
  available: boolean;
  configured: boolean;
  running: boolean;
  phase: ServerUpdatePhase;
  message: string;
  currentVersion: string | null;
  latestVersion: string | null;
  targetVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  logs: string[];
}

interface UpdaterStatusResponse {
  configured?: boolean;
  running?: boolean;
  phase?: ServerUpdatePhase;
  message?: string;
  currentVersion?: string | null;
  latestVersion?: string | null;
  targetVersion?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  logs?: string[];
}

const unavailableStatus: ServerUpdateStatus = {
  available: false,
  configured: false,
  running: false,
  phase: "unavailable",
  message: "updater unavailable",
  currentVersion: null,
  latestVersion: null,
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  logs: [],
};

function updaterConfig(): { url: string; secret: string } | null {
  const url = process.env.TOARD_UPDATER_URL?.replace(/\/+$/, "");
  const secret = process.env.TOARD_UPDATER_SECRET;
  return url && secret ? { url, secret } : null;
}

function normalizeStatus(raw: UpdaterStatusResponse, available = true): ServerUpdateStatus {
  return {
    available,
    configured: raw.configured ?? available,
    running: raw.running ?? false,
    phase: raw.phase ?? "idle",
    message: raw.message ?? "idle",
    currentVersion: raw.currentVersion ?? null,
    latestVersion: raw.latestVersion ?? null,
    targetVersion: raw.targetVersion ?? null,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null,
    error: raw.error ?? null,
    logs: Array.isArray(raw.logs) ? raw.logs.slice(-20) : [],
  };
}

async function updaterFetch(path: string, init?: RequestInit): Promise<Response> {
  const config = updaterConfig();
  if (!config) throw new Error("updater not configured");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${config.secret}`);
  if (init?.body) headers.set("content-type", "application/json");
  return fetch(`${config.url}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
    headers,
  });
}

export async function getServerUpdateStatus(): Promise<ServerUpdateStatus> {
  if (!updaterConfig()) return unavailableStatus;
  try {
    const res = await updaterFetch("/status");
    if (!res.ok) {
      return {
        ...unavailableStatus,
        configured: true,
        message: `updater status failed: HTTP ${res.status}`,
        error: await res.text(),
      };
    }
    return normalizeStatus((await res.json()) as UpdaterStatusResponse);
  } catch (e) {
    return {
      ...unavailableStatus,
      configured: true,
      message: "updater status failed",
      error: String(e),
    };
  }
}

export async function startServerUpdate(): Promise<{ status: number; body: ServerUpdateStatus | { error: string } }> {
  if (!updaterConfig()) {
    return { status: 503, body: { error: "updater not configured" } };
  }
  try {
    const res = await updaterFetch("/update", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const json = (await res.json()) as UpdaterStatusResponse | { error?: string; status?: UpdaterStatusResponse };
    if (!res.ok) {
      if ("status" in json && json.status) return { status: res.status, body: normalizeStatus(json.status) };
      return { status: res.status, body: { error: json.error ?? `HTTP ${res.status}` } };
    }
    return { status: res.status, body: normalizeStatus(json as UpdaterStatusResponse) };
  } catch (e) {
    return { status: 502, body: { error: String(e) } };
  }
}
