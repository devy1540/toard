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

function helperHarness(nonce = "c".repeat(32)) {
  let listener: ((event: MessageEvent) => void) | undefined;
  let openedUrl = "";
  let openedWindowName = "";
  let timerCallback: (() => void) | undefined;
  let timerTimeoutMs: number | undefined;
  const sent: Array<{ message: unknown; origin: string }> = [];
  const popup = {
    closed: false,
    close() { this.closed = true; },
    postMessage(message: unknown, origin: string) { sent.push({ message, origin }); },
  };
  const environment: LocalShimHelperEnvironment = {
    open(url, windowName) {
      openedUrl = url;
      openedWindowName = windowName;
      return popup;
    },
    addMessageListener(next) { listener = next; },
    removeMessageListener(next) { if (listener === next) listener = undefined; },
    randomNonce: () => nonce,
    setTimer(callback, timeoutMs) {
      timerCallback = callback;
      timerTimeoutMs = timeoutMs;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      timerCallback = undefined;
      timerTimeoutMs = undefined;
    },
  };
  const emit = (data: unknown, origin = LOCAL_SHIM_BASE_URL, source: unknown = popup) => {
    listener?.({ data, origin, source } as MessageEvent);
  };
  return {
    environment,
    emit,
    openedUrl: () => openedUrl,
    openedWindowName: () => openedWindowName,
    fireTimer: () => timerCallback?.(),
    timerTimeoutMs: () => timerTimeoutMs,
    popup,
    sent,
  };
}

test("browser helper uses a top-level one-time RPC and returns only the status contract", async () => {
  const harness = helperHarness();
  const pending = connectLocalShimWithHelper(targetId, harness.environment);

  assert.equal(
    harness.openedUrl(),
    `${LOCAL_SHIM_BASE_URL}/v1/helper?target=${targetId}&nonce=${"c".repeat(32)}`,
  );
  assert.equal(harness.openedWindowName(), `toard-local-shim-${"c".repeat(32)}`);
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

test("each helper RPC opens a fresh popup browsing context", async () => {
  const firstNonce = "c".repeat(32);
  const secondNonce = "d".repeat(32);
  const first = helperHarness(firstNonce);
  const firstPending = connectLocalShimWithHelper(targetId, first.environment);
  first.emit({ protocol: "toard-helper-v1", nonce: firstNonce, ready: true });
  first.emit({
    protocol: "toard-helper-v1",
    nonce: firstNonce,
    action: "status",
    ok: true,
    value: { ok: true, status },
  });
  await firstPending;

  const second = helperHarness(secondNonce);
  const secondPending = runLocalShimAction(
    { transport: "helper", status: { ...status }, targetId },
    "update",
    undefined,
    second.environment,
  );
  second.emit({ protocol: "toard-helper-v1", nonce: secondNonce, ready: true });
  second.emit({
    protocol: "toard-helper-v1",
    nonce: secondNonce,
    action: "update",
    ok: true,
    value: { ok: true, status },
  });
  await secondPending;

  assert.notEqual(first.openedWindowName(), second.openedWindowName());
  assert.equal(first.openedWindowName(), `toard-local-shim-${firstNonce}`);
  assert.equal(second.openedWindowName(), `toard-local-shim-${secondNonce}`);
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

test("missing local helper closes its error popup after the short status timeout", async () => {
  const harness = helperHarness();
  const pending = connectLocalShimWithHelper(targetId, harness.environment);

  assert.equal(harness.timerTimeoutMs(), 3_000);
  harness.fireTimer();

  await assert.rejects(pending, /helper timed out/);
  assert.equal(harness.popup.closed, true);
});
