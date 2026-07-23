export const LOCAL_SHIM_BASE_URL = "http://127.0.0.1:38473";
const LOCAL_SHIM_STATUS_TIMEOUT_MS = 3_000;
const LOCAL_SHIM_ACTION_TIMEOUT_MS = 30_000;
const LOCAL_SHIM_LONG_ACTION_TIMEOUT_MS = 120_000;

export type LocalShimAction = "collect" | "doctor" | "update";

export type LocalShimStatus = {
  protocol: "toard-local-v1";
  session: string;
  version: string;
  platform: string;
  host: string | null;
  daemon: {
    installed: boolean;
    active: boolean;
    backend: string | null;
    intervalSecs: number | null;
  };
  target: {
    id: string;
    content: "off" | "server_v1" | "e2ee_v1";
    tools: boolean;
    delivery: {
      result: "success" | "unreachable" | "unauthorized" | "unsupported" | "disabled" | "server_error";
      lastAttemptAt: string;
      lastSuccessAt: string | null;
    } | null;
  };
  capabilities: readonly LocalShimAction[];
};

export type LocalShimSession = {
  status: LocalShimStatus;
  targetId: string;
} & (
  | { transport: "direct"; token: string }
  | { transport: "helper" }
);

type LocalShimHelperWindow = {
  closed: boolean;
  close(): void;
  postMessage(message: unknown, targetOrigin: string): void;
};

type LocalShimHelperMessage = {
  protocol?: unknown;
  nonce?: unknown;
  ready?: unknown;
  action?: unknown;
  ok?: unknown;
  value?: unknown;
};

export type LocalShimHelperEnvironment = {
  open(url: string, windowName: string): LocalShimHelperWindow | null;
  addMessageListener(listener: (event: MessageEvent) => void): void;
  removeMessageListener(listener: (event: MessageEvent) => void): void;
  randomNonce(): string;
  setTimer(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
};

type LoopbackRequestInit = RequestInit & {
  targetAddressSpace?: "loopback";
};

export type LocalShimFetch = (
  input: string | URL | Request,
  init?: LoopbackRequestInit,
) => Promise<Response>;

function loopbackInit(init: RequestInit = {}): LoopbackRequestInit {
  return {
    ...init,
    mode: "cors",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    targetAddressSpace: "loopback",
  };
}

function isStatus(value: unknown): value is LocalShimStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<LocalShimStatus>;
  return status.protocol === "toard-local-v1"
    && typeof status.session === "string"
    && status.session.length >= 32
    && typeof status.version === "string"
    && typeof status.platform === "string"
    && Boolean(status.daemon && typeof status.daemon === "object")
    && Boolean(status.target && typeof status.target === "object")
    && Array.isArray(status.capabilities);
}

async function fetchWithTimeout(
  fetcher: LocalShimFetch,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(
      `${LOCAL_SHIM_BASE_URL}${path}`,
      loopbackInit({ ...init, signal: controller.signal }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function connectLocalShim(
  targetId: string,
  fetcher: LocalShimFetch = fetch,
): Promise<LocalShimSession> {
  if (!/^[a-f0-9]{64}$/.test(targetId)) throw new Error("invalid local shim target id");
  const response = await fetchWithTimeout(
    fetcher,
    "/v1/status",
    { method: "GET", headers: { "X-Toard-Target": targetId } },
    LOCAL_SHIM_STATUS_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`local shim status failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!isStatus(value)) throw new Error("invalid local shim response");
  return { transport: "direct", status: value, token: value.session, targetId };
}

export function connectLocalShimWithHelper(
  targetId: string,
  environment: LocalShimHelperEnvironment = browserHelperEnvironment(),
): Promise<LocalShimSession> {
  return helperRequest(targetId, "status", environment).then((status) => ({
    transport: "helper" as const,
    status,
    targetId,
  }));
}

/**
 * Browser-independent connection flow.
 *
 * A top-level helper window works across browser engines even when an HTTPS page
 * cannot fetch an HTTP loopback address directly. The helper is opened first so
 * the call still has the user's click activation. Browsers that block pop-ups
 * can fall back to the direct CORS/PNA path when they support it.
 */
export async function connectLocalShimFromBrowser(
  targetId: string,
  helperEnvironment: LocalShimHelperEnvironment = browserHelperEnvironment(),
  fetcher: LocalShimFetch = fetch,
): Promise<LocalShimSession> {
  try {
    return await connectLocalShimWithHelper(targetId, helperEnvironment);
  } catch (helperError) {
    try {
      return await connectLocalShim(targetId, fetcher);
    } catch (directError) {
      throw new AggregateError(
        [helperError, directError],
        "could not connect to the local shim with any browser transport",
      );
    }
  }
}

export async function runLocalShimAction(
  session: LocalShimSession,
  action: LocalShimAction,
  fetcher: LocalShimFetch = fetch,
  helperEnvironment?: LocalShimHelperEnvironment,
): Promise<LocalShimStatus | null> {
  if (!session.status.capabilities.includes(action)) {
    throw new Error(`local shim action is not supported: ${action}`);
  }
  if (session.transport === "helper") {
    return helperRequest(session.targetId, action, helperEnvironment ?? browserHelperEnvironment());
  }
  const response = await fetchWithTimeout(
    fetcher,
    `/v1/actions/${action}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "X-Toard-Target": session.targetId,
      },
    },
    action === "collect" || action === "update"
      ? LOCAL_SHIM_LONG_ACTION_TIMEOUT_MS
      : LOCAL_SHIM_ACTION_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`local shim action failed: ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (result.ok !== true) throw new Error("local shim action failed");
  return null;
}

function browserHelperEnvironment(): LocalShimHelperEnvironment {
  return {
    open: (url, windowName) => window.open(
      url,
      windowName,
      "popup,width=420,height=320,resizable=yes,scrollbars=yes",
    ),
    addMessageListener: (listener) => window.addEventListener("message", listener),
    removeMessageListener: (listener) => window.removeEventListener("message", listener),
    randomNonce: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    setTimer: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
    clearTimer: (timer) => clearTimeout(timer),
  };
}

function helperRequest(
  targetId: string,
  action: "status" | LocalShimAction,
  environment: LocalShimHelperEnvironment,
): Promise<LocalShimStatus> {
  if (!/^[a-f0-9]{64}$/.test(targetId)) {
    return Promise.reject(new Error("invalid local shim target id"));
  }
  const nonce = environment.randomNonce();
  if (!/^[a-f0-9]{16,64}$/.test(nonce)) {
    return Promise.reject(new Error("invalid local shim helper nonce"));
  }
  const url = `${LOCAL_SHIM_BASE_URL}/v1/helper?target=${targetId}&nonce=${nonce}`;
  return new Promise((resolve, reject) => {
    let popup: LocalShimHelperWindow | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer !== null) environment.clearTimer(timer);
      environment.removeMessageListener(onMessage);
      if (popup && !popup.closed) popup.close();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (event: MessageEvent) => {
      if (!popup || event.origin !== LOCAL_SHIM_BASE_URL || event.source !== popup) return;
      const message = event.data as LocalShimHelperMessage;
      if (message.protocol !== "toard-helper-v1" || message.nonce !== nonce) return;
      if (message.ready === true) {
        popup.postMessage({ protocol: "toard-helper-v1", nonce, action }, LOCAL_SHIM_BASE_URL);
        return;
      }
      if (message.action !== action) return;
      if (message.ok !== true || !message.value || typeof message.value !== "object") {
        fail(new Error("local shim helper action failed"));
        return;
      }
      const status = (message.value as { status?: unknown }).status;
      if (!isStatus(status)) {
        fail(new Error("invalid local shim helper response"));
        return;
      }
      cleanup();
      resolve(status);
    };
    environment.addMessageListener(onMessage);
    // Bind the window name to this one-time nonce so a later RPC never reuses
    // the previous helper's browsing context or opener.
    popup = environment.open(url, `toard-local-shim-${nonce}`);
    if (!popup) {
      fail(new Error("local shim helper popup blocked"));
      return;
    }
    const timeoutMs = action === "status"
      ? LOCAL_SHIM_STATUS_TIMEOUT_MS
      : action === "collect" || action === "update"
        ? LOCAL_SHIM_LONG_ACTION_TIMEOUT_MS
        : LOCAL_SHIM_ACTION_TIMEOUT_MS;
    timer = environment.setTimer(
      () => fail(new Error("local shim helper timed out")),
      timeoutMs,
    );
  });
}
