import test from "node:test";
import assert from "node:assert/strict";
import {
  composeMigrateArgs,
  composePullArgs,
  composeRestartAppArgs,
  createHandle,
  createSingleFlight,
  dockerComposeArgs,
  initialStatus,
  normalizeTargetVersion,
  parseLatestVersionFromLocation,
  updateEnvContent,
} from "../src/server.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function responseRecorder() {
  const result = { status: null, headers: null, body: null };
  return {
    result,
    response: {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
      },
      end(body) {
        result.body = JSON.parse(body);
      },
    },
  };
}

test("parseLatestVersionFromLocation accepts GitHub release redirects", () => {
  assert.equal(
    parseLatestVersionFromLocation("https://github.com/devy1540/toard/releases/tag/v1.2.3"),
    "1.2.3",
  );
  assert.equal(
    parseLatestVersionFromLocation("https://github.com/devy1540/toard/releases/tag/0.0.1"),
    "0.0.1",
  );
  assert.equal(
    parseLatestVersionFromLocation("https://github.com/devy1540/toard/releases/tag/1.2.3"),
    "1.2.3",
  );
  assert.equal(parseLatestVersionFromLocation("https://github.com/devy1540/toard/releases"), null);
});

test("normalizeTargetVersion returns docker image semver tags", () => {
  assert.equal(normalizeTargetVersion("v1.2.3"), "1.2.3");
  assert.equal(normalizeTargetVersion("1.2.3"), "1.2.3");
  assert.equal(normalizeTargetVersion("latest"), null);
  assert.equal(normalizeTargetVersion(""), null);
  assert.throws(() => normalizeTargetVersion("main"), /targetVersion/);
});

test("dockerComposeArgs always scopes commands to the configured compose file", () => {
  assert.deepEqual(dockerComposeArgs(["pull", "app"]), ["compose", "-f", "docker-compose.yml", "pull", "app"]);
});

test("update compose commands do not manage dependency services", () => {
  assert.deepEqual(composePullArgs(), ["pull", "app", "migrate"]);
  assert.deepEqual(composeMigrateArgs(), ["run", "--rm", "--no-deps", "migrate"]);
  assert.deepEqual(composeRestartAppArgs(), ["up", "-d", "--no-deps", "app"]);
});

test("updateEnvContent replaces or appends TOARD_TAG without touching comments", () => {
  assert.equal(updateEnvContent("AUTH_SECRET=keep\nTOARD_TAG=0.10.1\n", "TOARD_TAG", "0.11.0"), "AUTH_SECRET=keep\nTOARD_TAG=0.11.0\n");
  assert.equal(updateEnvContent("# TOARD_TAG=0.10.1\nAUTH_SECRET=keep\n", "TOARD_TAG", "0.11.0"), "# TOARD_TAG=0.10.1\nAUTH_SECRET=keep\nTOARD_TAG=0.11.0\n");
  assert.equal(updateEnvContent("AUTH_SECRET=keep", "TOARD_TAG", "0.11.0"), "AUTH_SECRET=keep\nTOARD_TAG=0.11.0\n");
});

test("initialStatus is idle and serializable", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(initialStatus())), {
    running: false,
    phase: "idle",
    message: "idle",
    currentVersion: null,
    latestVersion: null,
    targetVersion: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    logs: [],
  });
});

test("single-flight lease allows one run and releases after success or failure", async () => {
  const gate = deferred();
  let calls = 0;
  const flight = createSingleFlight(async () => {
    calls += 1;
    if (calls === 1) await gate.promise;
    else if (calls === 2) throw new Error("expected test failure");
  });

  const first = flight.tryStart("first");
  assert.ok(first);
  assert.equal(flight.isRunning(), true);
  assert.equal(flight.tryStart("duplicate"), null);
  assert.equal(calls, 1);

  gate.resolve();
  await first;
  assert.equal(flight.isRunning(), false);

  const failed = flight.tryStart("failed");
  assert.ok(failed);
  await assert.rejects(failed, /expected test failure/);
  assert.equal(flight.isRunning(), false);

  const retried = flight.tryStart("retry");
  assert.ok(retried);
  await retried;
  assert.equal(calls, 3);
});

test("unexpected failure is recorded before lease release and cannot overwrite a retry", async () => {
  const failure = deferred();
  let calls = 0;
  let competingStart;
  const state = { running: false, phase: "idle", error: null };
  const flight = createSingleFlight(async () => {
    calls += 1;
    state.running = true;
    state.phase = "running";
    state.error = null;
    if (calls === 1) await failure.promise;
    state.phase = "completed";
  }, {
    onError(error) {
      state.phase = "failed";
      state.error = String(error);
    },
    onSettled() {
      state.running = false;
    },
  });

  const first = flight.tryStart("first");
  assert.ok(first);
  failure.reject(new Error("unexpected first failure"));
  queueMicrotask(() => {
    competingStart = flight.tryStart("too-early");
  });
  await first;

  assert.equal(competingStart, null);
  assert.deepEqual(state, {
    running: false,
    phase: "failed",
    error: "Error: unexpected first failure",
  });
  assert.equal(flight.isRunning(), false);

  const retry = flight.tryStart("retry");
  assert.ok(retry);
  assert.deepEqual({ ...state }, { running: true, phase: "completed", error: null });
  await retry;
  assert.deepEqual(state, { running: false, phase: "completed", error: null });
  assert.equal(calls, 2);
});

test("concurrent update handlers start exactly one run after body parsing", async () => {
  const firstBody = deferred();
  const secondBody = deferred();
  const runGate = deferred();
  const startedTargets = [];
  const flight = createSingleFlight(async (targetVersion) => {
    startedTargets.push(targetVersion);
    await runGate.promise;
  });
  const handler = createHandle({
    authorize: () => true,
    readRequestJson: (request) => request.bodyResult.promise,
    startUpdate: (targetVersion) => flight.tryStart(targetVersion),
    getPublicStatus: () => ({ running: flight.isRunning(), starts: startedTargets.length }),
  });
  const first = responseRecorder();
  const second = responseRecorder();
  const firstRequest = {
    method: "POST",
    url: "/update",
    headers: { host: "updater.test" },
    bodyResult: firstBody,
  };
  const secondRequest = {
    method: "POST",
    url: "/update",
    headers: { host: "updater.test" },
    bodyResult: secondBody,
  };

  const firstResponse = handler(firstRequest, first.response);
  const secondResponse = handler(secondRequest, second.response);
  firstBody.resolve({ targetVersion: "1.2.3" });
  secondBody.resolve({ targetVersion: "1.2.3" });
  await Promise.all([firstResponse, secondResponse]);

  assert.deepEqual([first.result.status, second.result.status].sort(), [202, 409]);
  assert.deepEqual(startedTargets, ["1.2.3"]);
  const conflict = [first.result, second.result].find((result) => result.status === 409);
  assert.equal(conflict.body.error, "update already running");
  assert.equal(conflict.body.status.starts, 1);

  runGate.resolve();
  while (flight.isRunning()) await new Promise((resolve) => setImmediate(resolve));

  const retry = responseRecorder();
  const retryBody = deferred();
  const retryResponse = handler({
    method: "POST",
    url: "/update",
    headers: { host: "updater.test" },
    bodyResult: retryBody,
  }, retry.response);
  retryBody.resolve({ targetVersion: "1.2.4" });
  await retryResponse;
  assert.equal(retry.result.status, 202);
  assert.deepEqual(startedTargets, ["1.2.3", "1.2.4"]);
});
