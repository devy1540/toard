import assert from "node:assert/strict";
import test from "node:test";
import {
  connectLocalShim,
  connectLocalShimFromBrowser,
  connectLocalShimWithHelper,
  LOCAL_SHIM_BASE_URL,
  runLocalShimAction,
  type LocalShimFetch,
  type LocalShimHelperEnvironment,
} from "./local-shim-client";

const targetId = "b".repeat(64);

const status = {
  protocol: "toard-local-v1",
  session: "a".repeat(64),
  version: "0.15.43",
  platform: "macos",
  host: "my-mac",
  daemon: { installed: true, active: true, backend: "launchd", intervalSecs: 300 },
  target: { id: "123456789abc", content: "off", tools: true, delivery: null },
  capabilities: ["collect", "doctor", "update"],
} as const;

test("connect requests the fixed loopback bridge with an exact target binding", async () => {
  const calls: Array<{ url: string; init: Parameters<LocalShimFetch>[1] }> = [];
  const fetcher: LocalShimFetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(status);
  };

  const session = await connectLocalShim(targetId, fetcher);

  assert.equal(session.status.host, "my-mac");
  assert.equal(calls[0]?.url, `${LOCAL_SHIM_BASE_URL}/v1/status`);
  assert.equal(calls[0]?.init?.targetAddressSpace, "loopback");
  assert.equal(calls[0]?.init?.mode, "cors");
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.equal(calls[0]?.init?.credentials, "omit");
  assert.equal(calls[0]?.init?.redirect, "error");
  assert.deepEqual(calls[0]?.init?.headers, { "X-Toard-Target": targetId });
});

test("actions use the short-lived browser session and never put it in the URL", async () => {
  const calls: Array<{ url: string; init: Parameters<LocalShimFetch>[1] }> = [];
  const fetcher: LocalShimFetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ ok: true, action: "collect", exitCode: 0 });
  };

  await runLocalShimAction(
    { transport: "direct", status: { ...status }, token: status.session, targetId },
    "collect",
    fetcher,
  );

  assert.equal(calls[0]?.url, `${LOCAL_SHIM_BASE_URL}/v1/actions/collect`);
  assert.equal(calls[0]?.init?.headers instanceof Headers, false);
  assert.deepEqual(calls[0]?.init?.headers, {
    Authorization: `Bearer ${status.session}`,
    "X-Toard-Target": targetId,
  });
  assert.doesNotMatch(calls[0]?.url ?? "", new RegExp(status.session));
});

test("invalid responders cannot impersonate the toard bridge contract", async () => {
  const fetcher: LocalShimFetch = async () => Response.json({ protocol: "other-service" });
  await assert.rejects(connectLocalShim(targetId, fetcher), /invalid local shim response/);
});

test("unsupported actions are rejected before a request is sent", async () => {
  let called = false;
  const fetcher: LocalShimFetch = async () => {
    called = true;
    return Response.json({ ok: true });
  };
  await assert.rejects(
    runLocalShimAction(
      {
        transport: "direct",
        status: { ...status, capabilities: ["collect"] },
        token: status.session,
        targetId,
      },
      "update",
      fetcher,
    ),
    /not supported/,
  );
  assert.equal(called, false);
});

function helperHarness() {
  let listener: ((event: MessageEvent) => void) | undefined;
  let openedUrl = "";
  const sent: Array<{ message: unknown; origin: string }> = [];
  const popup = {
    closed: false,
    close() { this.closed = true; },
    postMessage(message: unknown, origin: string) { sent.push({ message, origin }); },
  };
  const environment: LocalShimHelperEnvironment = {
    open(url) { openedUrl = url; return popup; },
    addMessageListener(next) { listener = next; },
    removeMessageListener(next) { if (listener === next) listener = undefined; },
    randomNonce: () => "c".repeat(32),
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  };
  const emit = (data: unknown, origin = LOCAL_SHIM_BASE_URL, source: unknown = popup) => {
    listener?.({ data, origin, source } as MessageEvent);
  };
  return { environment, emit, openedUrl: () => openedUrl, popup, sent };
}

test("browser helper uses a top-level one-time RPC and returns only the status contract", async () => {
  const harness = helperHarness();
  const pending = connectLocalShimWithHelper(targetId, harness.environment);

  assert.equal(
    harness.openedUrl(),
    `${LOCAL_SHIM_BASE_URL}/v1/helper?target=${targetId}&nonce=${"c".repeat(32)}`,
  );
  harness.emit({ protocol: "toard-helper-v1", nonce: "c".repeat(32), ready: true });
  assert.deepEqual(harness.sent[0], {
    message: { protocol: "toard-helper-v1", nonce: "c".repeat(32), action: "status" },
    origin: LOCAL_SHIM_BASE_URL,
  });
  harness.emit({
    protocol: "toard-helper-v1",
    nonce: "c".repeat(32),
    action: "status",
    ok: true,
    value: { ok: true, status },
  });

  const session = await pending;
  assert.equal(session.transport, "helper");
  assert.equal(session.status.host, "my-mac");
  assert.equal(harness.popup.closed, true);
});

test("helper ignores messages from another origin or window and supports actions", async () => {
  const harness = helperHarness();
  const session = { transport: "helper" as const, status: { ...status }, targetId };
  const pending = runLocalShimAction(session, "doctor", undefined, harness.environment);

  harness.emit(
    { protocol: "toard-helper-v1", nonce: "c".repeat(32), ready: true },
    "https://evil.example",
  );
  harness.emit(
    { protocol: "toard-helper-v1", nonce: "c".repeat(32), ready: true },
    LOCAL_SHIM_BASE_URL,
    {},
  );
  assert.equal(harness.sent.length, 0);
  harness.emit({ protocol: "toard-helper-v1", nonce: "c".repeat(32), ready: true });
  assert.deepEqual(harness.sent[0]?.message, {
    protocol: "toard-helper-v1",
    nonce: "c".repeat(32),
    action: "doctor",
  });
  harness.emit({
    protocol: "toard-helper-v1",
    nonce: "c".repeat(32),
    action: "doctor",
    ok: true,
    value: { ok: true, status },
  });
  assert.equal((await pending)?.version, "0.15.43");
});

test("browser connection prefers the cross-browser helper without a user-agent branch", async () => {
  const harness = helperHarness();
  let directCalled = false;
  const fetcher: LocalShimFetch = async () => {
    directCalled = true;
    return Response.json(status);
  };
  const pending = connectLocalShimFromBrowser(targetId, harness.environment, fetcher);

  harness.emit({ protocol: "toard-helper-v1", nonce: "c".repeat(32), ready: true });
  harness.emit({
    protocol: "toard-helper-v1",
    nonce: "c".repeat(32),
    action: "status",
    ok: true,
    value: { ok: true, status },
  });

  assert.equal((await pending).transport, "helper");
  assert.equal(directCalled, false);
});

test("browser connection falls back to direct loopback when the helper popup is blocked", async () => {
  const harness = helperHarness();
  const blockedEnvironment: LocalShimHelperEnvironment = {
    ...harness.environment,
    open: () => null,
  };
  const calls: string[] = [];
  const fetcher: LocalShimFetch = async (input) => {
    calls.push(String(input));
    return Response.json(status);
  };

  const session = await connectLocalShimFromBrowser(targetId, blockedEnvironment, fetcher);

  assert.equal(session.transport, "direct");
  assert.deepEqual(calls, [`${LOCAL_SHIM_BASE_URL}/v1/status`]);
});

test("browser connection reports failure only after helper and direct transports both fail", async () => {
  const harness = helperHarness();
  const blockedEnvironment: LocalShimHelperEnvironment = {
    ...harness.environment,
    open: () => null,
  };
  const fetcher: LocalShimFetch = async () => {
    throw new TypeError("loopback blocked");
  };

  await assert.rejects(
    connectLocalShimFromBrowser(targetId, blockedEnvironment, fetcher),
    /any browser transport/,
  );
});
