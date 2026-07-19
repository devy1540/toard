import assert from "node:assert/strict";
import test from "node:test";
import {
  ClickHouseAdmissionTimeoutError,
  ClickHouseOperationController,
  ClickHouseOverloadError,
} from "./operation-controller";

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

test("operation controller는 최대 4개만 실행하고 대기자를 FIFO로 시작한다", async () => {
  const controller = new ClickHouseOperationController({
    maxConcurrent: 4,
    queueTimeoutMs: 1_000,
  });
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;
  const jobs = Array.from({ length: 6 }, (_, index) =>
    controller.run(`job-${index}`, async () => {
      started.push(index);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(index, resolve));
      active -= 1;
      return index;
    }),
  );

  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3]);
  releases.get(0)!();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases.get(1)!();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  for (const index of [2, 3, 4, 5]) releases.get(index)!();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 4);
});

test("queue timeout과 abort는 항목을 제거하고 다음 작업을 막지 않는다", async () => {
  const controller = new ClickHouseOperationController({
    maxConcurrent: 1,
    queueTimeoutMs: 10,
    log: () => undefined,
  });
  let release!: () => void;
  const first = controller.run(
    "first",
    () => new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await nextTurn();

  await assert.rejects(
    controller.run("timeout", async () => undefined),
    ClickHouseAdmissionTimeoutError,
  );
  const abort = new AbortController();
  const cancelled = controller.run(
    "cancelled",
    async () => undefined,
    { signal: abort.signal },
  );
  abort.abort();
  await assert.rejects(cancelled, /aborted/i);

  release();
  await first;
  assert.equal(await controller.run("next", async () => 7), 7);
});

test("Code 202는 한 번만 재시도하고 안전한 overload 오류를 남긴다", async () => {
  const records: unknown[] = [];
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async () => undefined,
    random: () => 0,
    log: (record) => records.push(record),
  });

  await assert.rejects(
    controller.run(
      "organization_dashboard_usage",
      async () => {
        attempts += 1;
        throw Object.assign(
          new Error("SELECT secret FROM usage_events WHERE user_id='private'"),
          { code: 202 },
        );
      },
      { retryTransient: true },
    ),
    ClickHouseOverloadError,
  );

  assert.equal(attempts, 2);
  assert.equal(records.length, 1);
  assert.doesNotMatch(JSON.stringify(records), /SELECT|private|usage_events/);
});

test("retryTransient network 오류는 기존 정책대로 최대 5 attempts를 사용한다", async () => {
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async () => undefined,
    log: () => undefined,
  });

  await assert.rejects(
    controller.run(
      "usage_read",
      async () => {
        attempts += 1;
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      },
      { retryTransient: true },
    ),
    /connection reset/,
  );

  assert.equal(attempts, 5);
});

test("retryTransient 일반 query 오류는 재시도하지 않는다", async () => {
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async () => undefined,
    log: () => undefined,
  });

  await assert.rejects(
    controller.run(
      "invalid_query",
      async () => {
        attempts += 1;
        throw Object.assign(new Error("syntax error"), { code: "SYNTAX_ERROR" });
      },
      { retryTransient: true },
    ),
    /syntax error/,
  );

  assert.equal(attempts, 1);
});

test("retryTransient를 생략한 insert는 network 오류도 재시도하지 않는다", async () => {
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async () => undefined,
    log: () => undefined,
  });

  await assert.rejects(
    controller.run("usage_insert", async () => {
      attempts += 1;
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    }),
    /connection reset/,
  );

  assert.equal(attempts, 1);
});

test("재시도 backoff 동안 slot을 반환한다", async () => {
  let releaseSleep!: () => void;
  let sleepStartedResolve!: () => void;
  const sleepStarted = new Promise<void>((resolve) => {
    sleepStartedResolve = resolve;
  });
  let retryAttempts = 0;
  const controller = new ClickHouseOperationController({
    maxConcurrent: 1,
    sleep: () => new Promise<void>((resolve) => {
      releaseSleep = resolve;
      sleepStartedResolve();
    }),
    log: () => undefined,
  });
  const retrying = controller.run(
    "usage_read",
    async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      }
      return "retried";
    },
    { retryTransient: true },
  );

  await sleepStarted;
  assert.equal(await controller.run("other", async () => "other"), "other");
  releaseSleep();

  assert.equal(await retrying, "retried");
  assert.equal(retryAttempts, 2);
});
