import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createDeviceControlRepository,
  type DeviceControlDb,
} from "./device-control-repository";

type Call = { sql: string; params?: unknown[] };

function scriptedDb(
  handler: (sql: string, params?: unknown[]) => Array<Record<string, unknown>>,
): DeviceControlDb & { calls: Call[]; released: boolean } {
  const calls: Call[] = [];
  let released = false;
  const client = {
    async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: handler(sql, params) as T[], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    get released() {
      return released;
    },
    query: client.query,
    async connect() {
      return client;
    },
  };
}

const fingerprint = "a".repeat(64);
const commandId = "11111111-1111-4111-8111-111111111111";

test("migration은 desired, observed, command, audit을 만들고 자유 형식 결과를 금지한다", () => {
  const sql = readFileSync(
    new URL("../../../migrations/1700000050_device_control.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "device_control_policies",
    "device_control_observations",
    "device_control_commands",
    "device_control_audit",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(sql, /command_type IN \('collect', 'doctor'\)/);
  assert.match(sql, /desired_content_mode IN \('off', 'server_v1', 'e2ee_v1'\)/);
  assert.doesNotMatch(sql, /stdout|stderr|log_output|token_value|secret_value/);
});

test("설정 화면은 localhost popup 대신 서버 경유 headless 제어를 사용한다", () => {
  const page = readFileSync(
    new URL("../app/(dashboard)/settings/page.tsx", import.meta.url),
    "utf8",
  );
  const actions = readFileSync(
    new URL("../app/(dashboard)/settings/device-actions.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(page, /LocalShimPanel|localShimTargetId/);
  assert.doesNotMatch(actions, /127\.0\.0\.1|window\.open|navigator\.clipboard/);
  assert.match(actions, /setDeviceHistoryAction/);
  assert.match(actions, /enqueueDeviceCommandAction/);
});

test("첫 sync는 현재 로컬 정책을 desired 초기값으로 보존하고 command를 claim한다", async () => {
  const db = scriptedDb((sql) => {
    if (/SELECT EXISTS/.test(sql)) return [{ exists: true }];
    if (/RETURNING command\.id/.test(sql)) {
      return [{ id: commandId, command_type: "collect" }];
    }
    if (/SELECT generation, desired_content_mode/.test(sql)) {
      return [{
        generation: "1",
        desired_content_mode: "server_v1",
        desired_content_since: "2026-07-24T00:00:00.000Z",
      }];
    }
    return [];
  });
  const repository = createDeviceControlRepository(db);
  const now = new Date("2026-07-24T01:00:00.000Z");
  const since = new Date("2026-07-24T00:00:00.000Z");
  const result = await repository.sync(
    { userId: "user-1", tokenId: "token-1" },
    {
      deviceFingerprint: fingerprint,
      host: "box",
      shimVersion: "0.15.51",
      daemonActive: true,
      appliedGeneration: 0,
      appliedContentMode: "server_v1",
      appliedContentSince: since,
      errorCode: null,
      commandResults: [],
    },
    now,
  );

  const policyInsert = db.calls.find((call) =>
    /INSERT INTO device_control_policies/.test(call.sql)
  );
  assert.deepEqual(policyInsert?.params?.slice(3), ["server_v1", since]);
  assert.deepEqual(result, {
    desired: { generation: 1, contentMode: "server_v1", contentSince: since },
    commands: [{ id: commandId, type: "collect" }],
  });
  assert.equal(db.released, true);
});

test("sync command 결과는 소유 target의 claimed ID에만 반영한다", async () => {
  const db = scriptedDb((sql) => {
    if (/SELECT EXISTS/.test(sql)) return [{ exists: true }];
    if (/SELECT generation, desired_content_mode/.test(sql)) {
      return [{ generation: 2, desired_content_mode: "off", desired_content_since: null }];
    }
    return [];
  });
  const repository = createDeviceControlRepository(db);
  await repository.sync(
    { userId: "user-1", tokenId: "token-1" },
    {
      deviceFingerprint: fingerprint,
      host: null,
      shimVersion: "0.15.51",
      daemonActive: true,
      appliedGeneration: 2,
      appliedContentMode: "off",
      appliedContentSince: null,
      errorCode: null,
      commandResults: [{
        commandId,
        status: "failed",
        resultCode: "doctor_failed",
      }],
    },
  );

  const update = db.calls.find((call) =>
    /UPDATE device_control_commands\s+SET status = \$1/.test(call.sql)
  );
  assert.deepEqual(update?.params?.slice(0, 2), ["failed", "doctor_failed"]);
  assert.deepEqual(update?.params?.slice(3), [
    commandId,
    "user-1",
    "token-1",
    fingerprint,
  ]);
});

test("content mode 변경은 generation과 ON 시점을 올리고 같은 transaction에 감사 기록을 남긴다", async () => {
  const db = scriptedDb((sql) => {
    if (/SELECT EXISTS/.test(sql)) return [{ exists: true }];
    if (/SELECT generation, desired_content_mode/.test(sql)) {
      return [{ generation: 4, desired_content_mode: "off", desired_content_since: null }];
    }
    return [];
  });
  const repository = createDeviceControlRepository(db);
  const now = new Date("2026-07-24T02:00:00.000Z");
  const saved = await repository.setDesiredContentMode({
    actorUserId: "user-1",
    tokenId: "token-1",
    deviceFingerprint: fingerprint,
    contentMode: "server_v1",
    now,
  });

  assert.equal(saved, true);
  const upsert = db.calls.find((call) =>
    /INSERT INTO device_control_policies/.test(call.sql)
  );
  assert.deepEqual(upsert?.params?.slice(3, 7), [5, "server_v1", now, now]);
  assert.ok(db.calls.some((call) => /INSERT INTO device_control_audit/.test(call.sql)));
  assert.equal(db.calls.at(-1)?.sql.trim(), "COMMIT");
});

test("command 생성은 active 중복을 재사용하고 allow-list 정보만 감사 기록에 저장한다", async () => {
  let insertAttempt = 0;
  const db = scriptedDb((sql) => {
    if (/SELECT EXISTS/.test(sql)) return [{ exists: true }];
    if (/INSERT INTO device_control_commands/.test(sql)) {
      insertAttempt += 1;
      return insertAttempt === 1 ? [] : [{ id: commandId }];
    }
    if (/SELECT id\s+FROM device_control_commands/.test(sql)) return [{ id: commandId }];
    return [];
  });
  const repository = createDeviceControlRepository(db);
  const id = await repository.enqueueCommand({
    actorUserId: "user-1",
    tokenId: "token-1",
    deviceFingerprint: fingerprint,
    commandType: "doctor",
  });

  assert.equal(id, commandId);
  const expire = db.calls.find((call) =>
    /SET status = 'expired'/.test(call.sql)
  );
  const insert = db.calls.find((call) =>
    /INSERT INTO device_control_commands/.test(call.sql)
  );
  assert.ok(expire && insert);
  assert.ok(db.calls.indexOf(expire) < db.calls.indexOf(insert));
  const audit = db.calls.find((call) => /INSERT INTO device_control_audit/.test(call.sql));
  assert.match(String(audit?.params?.[3]), /"commandType":"doctor"/);
  assert.doesNotMatch(JSON.stringify(db.calls), /stdout|private|secret/);
});
