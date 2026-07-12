import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GET as statusGet } from "../app/api/admin/rollups/status/route";
import { POST as controlPost } from "../app/api/admin/rollups/control/route";

const ADMIN = { role: "admin" } as never;
const MEMBER = { role: "member" } as never;

function controlRequest(body: string): Request {
  return new Request("http://toard/api/admin/rollups/control", {
    method: "POST",
    body,
  });
}

test("rollup status는 비로그인과 비관리자를 차단하고 no-store를 유지한다", async () => {
  const unauthorized = await statusGet.withDependencies({
    getSessionUser: async () => null,
  })();
  const forbidden = await statusGet.withDependencies({
    getSessionUser: async () => MEMBER,
  })();

  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "forbidden" });
  assert.equal(forbidden.headers.get("cache-control"), "no-store");
});

test("관리자 rollup status는 DTO만 no-store로 반환한다", async () => {
  const dto = {
    backend: "clickhouse",
    collectedAt: "2026-07-12T12:00:00.000Z",
    degraded: false,
  };
  const response = await statusGet.withDependencies({
    getSessionUser: async () => ADMIN,
    getRollupAdminStatus: async () => dto as never,
  })();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), dto);
});

test("status 내부 실패는 secret·SQL·stack 없이 고정 500으로 반환한다", async () => {
  const response = await statusGet.withDependencies({
    getSessionUser: async () => ADMIN,
    getRollupAdminStatus: async () => {
      throw new Error("password=hunter2 SELECT * FROM users\nstack: internal.ts:10");
    },
  })();
  const text = await response.text();

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(text), { error: "internal error" });
  assert.doesNotMatch(text, /hunter2|SELECT|stack|internal\.ts/);
});

test("rollup control도 비로그인과 비관리자를 차단한다", async () => {
  const unauthorized = await controlPost.withDependencies({
    getSessionUser: async () => null,
  })(controlRequest(JSON.stringify({ worker: "usage_15m_v2", action: "pause" })));
  const forbidden = await controlPost.withDependencies({
    getSessionUser: async () => MEMBER,
  })(controlRequest(JSON.stringify({ worker: "usage_15m_v2", action: "pause" })));

  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("cache-control"), "no-store");
});

test("control은 정확한 worker/action JSON 외 입력을 400으로 거부한다", async () => {
  let writes = 0;
  const post = controlPost.withDependencies({
    getSessionUser: async () => ADMIN,
    hardEnabled: () => true,
    setPaused: async (worker, paused) => {
      writes++;
      return { worker, paused };
    },
  });
  const invalidBodies = [
    "{",
    "null",
    "[]",
    JSON.stringify({ worker: "usage_15m", action: "pause" }),
    JSON.stringify({ worker: "usage_15m_v2", action: "start" }),
    JSON.stringify({ worker: "usage_15m_v2", action: "pause", extra: true }),
    JSON.stringify({ worker: "usage_15m_v2" }),
  ];

  for (const body of invalidBodies) {
    const response = await post(controlRequest(body));
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { error: "invalid request" }, body);
    assert.equal(response.headers.get("cache-control"), "no-store", body);
  }
  assert.equal(writes, 0);
});

test("hard disabled worker는 관리자 resume을 409로 거부한다", async () => {
  let writes = 0;
  const post = controlPost.withDependencies({
    getSessionUser: async () => ADMIN,
    hardEnabled: () => false,
    setPaused: async (worker, paused) => {
      writes++;
      return { worker, paused };
    },
  });
  const response = await post(controlRequest(JSON.stringify({
    worker: "usage_15m_v2",
    action: "resume",
  })));

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "disabled by server configuration" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(writes, 0);
});

test("pause/resume은 Postgres pause 상태만 멱등 갱신한다", async () => {
  const writes: Array<{ worker: string; paused: boolean }> = [];
  const post = controlPost.withDependencies({
    getSessionUser: async () => ADMIN,
    hardEnabled: () => true,
    setPaused: async (worker, paused) => {
      writes.push({ worker, paused });
      return { worker, paused };
    },
  });

  const pause = await post(controlRequest(JSON.stringify({ worker: "timezone", action: "pause" })));
  const repeatedPause = await post(controlRequest(JSON.stringify({ worker: "timezone", action: "pause" })));
  const resume = await post(controlRequest(JSON.stringify({ worker: "timezone", action: "resume" })));

  assert.deepEqual(writes, [
    { worker: "timezone", paused: true },
    { worker: "timezone", paused: true },
    { worker: "timezone", paused: false },
  ]);
  assert.deepEqual(await pause.json(), { worker: "timezone", paused: true });
  assert.deepEqual(await repeatedPause.json(), { worker: "timezone", paused: true });
  assert.deepEqual(await resume.json(), { worker: "timezone", paused: false });
  assert.equal(pause.headers.get("cache-control"), "no-store");
  assert.equal(resume.headers.get("cache-control"), "no-store");
});

test("control 저장 실패도 내부 정보를 노출하지 않는다", async () => {
  const post = controlPost.withDependencies({
    getSessionUser: async () => ADMIN,
    hardEnabled: () => true,
    setPaused: async () => {
      throw new Error("secret=abc UPDATE clickhouse_rollup_worker_status\nstack db.ts:42");
    },
  });
  const response = await post(controlRequest(JSON.stringify({
    worker: "timezone",
    action: "pause",
  })));
  const text = await response.text();

  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(text), { error: "internal error" });
  assert.doesNotMatch(text, /abc|UPDATE|stack|db\.ts/);
});

test("기본 control 경로는 Postgres repository만 갱신하고 ClickHouse를 직접 실행하지 않는다", () => {
  const source = readFileSync(
    new URL("../app/api/admin/rollups/control/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /PgRollupWorkerRepository/);
  assert.match(source, /setPaused/);
  assert.match(source, /shadowWorkerEnabled/);
  assert.doesNotMatch(source, /getStorage|compactClickHouse|ClickHouseStorage|\.command\(|\.query\(/);
});
