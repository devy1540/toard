import assert from "node:assert/strict";
import test from "node:test";
import {
  postDeviceControlSyncResponse,
  type DeviceControlApiDependencies,
} from "./device-control-api";

const fingerprint = "a".repeat(64);
const commandId = "11111111-1111-4111-8111-111111111111";

function dependencies(): DeviceControlApiDependencies & { observations: unknown[] } {
  const observations: unknown[] = [];
  return {
    observations,
    async authenticate() {
      return { userId: "user-1", tokenId: "token-1" };
    },
    async sync(_owner, observation) {
      observations.push(observation);
      return {
        desired: {
          generation: 3,
          contentMode: "server_v1",
          contentSince: new Date("2026-07-24T00:00:00.000Z"),
        },
        commands: [{ id: commandId, type: "collect" }],
      };
    },
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    deviceFingerprint: fingerprint,
    host: "my-mac.local",
    shimVersion: "0.15.51",
    daemonActive: true,
    appliedGeneration: 2,
    appliedContentMode: "off",
    appliedContentSince: null,
    errorCode: null,
    commandResults: [],
    ...overrides,
  };
}

function request(value: unknown, authorization = "Bearer token") {
  return new Request("http://localhost/api/v1/device-control/sync", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

test("sync API는 desired state와 allow-list command만 no-store로 반환한다", async () => {
  const deps = dependencies();
  const response = await postDeviceControlSyncResponse(request(body()), deps);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    desired: {
      generation: 3,
      contentMode: "server_v1",
      contentSince: "2026-07-24T00:00:00.000Z",
    },
    commands: [{ id: commandId, type: "collect" }],
    nextSyncSeconds: 60,
  });
  assert.equal(deps.observations.length, 1);
});

test("sync API는 unknown field와 임의 command result를 거부한다", async () => {
  const deps = dependencies();
  const unknown = await postDeviceControlSyncResponse(
    request(body({ token: "must-not-be-accepted" })),
    deps,
  );
  assert.equal(unknown.status, 400);

  const forged = await postDeviceControlSyncResponse(
    request(body({
      commandResults: [{
        commandId,
        status: "succeeded",
        resultCode: null,
        output: "private doctor output",
      }],
    })),
    deps,
  );
  assert.equal(forged.status, 400);
  assert.equal(deps.observations.length, 0);
});

test("sync API는 인증·소유권·프로토콜을 fail closed 처리한다", async () => {
  const unauthorizedDeps = dependencies();
  unauthorizedDeps.authenticate = async () => null;
  assert.equal(
    (await postDeviceControlSyncResponse(request(body(), ""), unauthorizedDeps)).status,
    401,
  );

  const forbiddenDeps = dependencies();
  forbiddenDeps.sync = async () => null;
  assert.equal(
    (await postDeviceControlSyncResponse(request(body()), forbiddenDeps)).status,
    403,
  );

  const protocolDeps = dependencies();
  assert.equal(
    (await postDeviceControlSyncResponse(
      request(body({ schemaVersion: 2 })),
      protocolDeps,
    )).status,
    426,
  );
});

test("sync API는 결과 ID 중복과 자유 형식 오류를 거부한다", async () => {
  const deps = dependencies();
  const duplicated = {
    commandId,
    status: "failed",
    resultCode: "collect_failed",
  };
  const response = await postDeviceControlSyncResponse(
    request(body({ commandResults: [duplicated, duplicated] })),
    deps,
  );
  assert.equal(response.status, 400);

  const unsafe = await postDeviceControlSyncResponse(
    request(body({ errorCode: "path=/Users/private" })),
    deps,
  );
  assert.equal(unsafe.status, 400);
});

test("sync API는 업그레이드 첫 동기화에서 기존 E2EE 정책을 그대로 보고할 수 있다", async () => {
  const deps = dependencies();
  const response = await postDeviceControlSyncResponse(
    request(
      body({
        appliedGeneration: 0,
        appliedContentMode: "e2ee_v1",
        appliedContentSince: "2026-01-01T00:00:00.000Z",
      }),
    ),
    deps,
  );
  assert.equal(response.status, 200);
  assert.equal(
    (deps.observations[0] as { appliedContentMode: string }).appliedContentMode,
    "e2ee_v1",
  );
});
