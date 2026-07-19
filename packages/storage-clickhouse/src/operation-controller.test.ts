import assert from "node:assert/strict";
import test from "node:test";
import { ClickHouseError } from "@clickhouse/client";
import {
  ClickHouseAdmissionTimeoutError,
  ClickHouseOperationController,
  ClickHouseOverloadError,
} from "./operation-controller";

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

type OperationControllerModule = typeof import("./operation-controller");

function importControllerCopy(copy: string): Promise<OperationControllerModule> {
  const url = new URL(`./operation-controller.ts?copy=${copy}`, import.meta.url);
  return import(url.href) as Promise<OperationControllerModule>;
}

test("서로 다른 module 평가는 process-wide 기본 controller와 max-4 FIFO queue를 공유한다", async () => {
  const [firstModule, secondModule] = await Promise.all([
    importControllerCopy("first"),
    importControllerCopy("second"),
  ]);
  const controllers = [
    firstModule.defaultClickHouseOperationController,
    secondModule.defaultClickHouseOperationController,
  ];
  let releaseFirst!: () => void;
  const firstBlocker = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseRemaining!: () => void;
  const remainingBlocker = new Promise<void>((resolve) => {
    releaseRemaining = resolve;
  });
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;
  const jobs = Array.from({ length: 8 }, (_, index) =>
    controllers[index % controllers.length]!.run(`copy-job-${index}`, async () => {
      started.push(index);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await (index === 0 ? firstBlocker : remainingBlocker);
      active -= 1;
      return index;
    }),
  );

  await nextTurn();
  const initiallyStarted = [...started];
  releaseFirst();
  await nextTurn();
  const afterFirstRelease = [...started];
  releaseRemaining();
  await Promise.all(jobs);

  assert.notStrictEqual(firstModule, secondModule);
  assert.strictEqual(controllers[0], controllers[1]);
  assert.deepEqual(initiallyStarted, [0, 1, 2, 3]);
  assert.deepEqual(afterFirstRelease, [0, 1, 2, 3, 4]);
  assert.equal(maxActive, 4);
});

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

test("retryTransient 없이 Code 202가 반복되면 한 번 sleep 후 typed overload로 끝난다", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    log: () => undefined,
  });

  await assert.rejects(
    controller.run("usage_insert", async () => {
      attempts += 1;
      throw Object.assign(new Error("overloaded"), { code: 202 });
    }),
    ClickHouseOverloadError,
  );

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [100]);
});

test("retryTransient 없이 Code 202가 한 번 발생하면 두 번째 attempt 결과를 반환한다", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    log: () => undefined,
  });

  const result = await controller.run("usage_command", async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("overloaded"), { code: "202" });
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [100]);
});

test("ClickHouseError의 code와 type을 인식하고 numeric code만 안전하게 기록한다", async () => {
  const records: unknown[] = [];
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async () => undefined,
    random: () => 0,
    log: (record) => records.push(record),
  });

  await assert.rejects(
    controller.run("usage_command", async () => {
      attempts += 1;
      throw new ClickHouseError({
        message: "SELECT private FROM usage_events",
        code: "202",
        type: "TOO_MANY_SIMULTANEOUS_QUERIES",
      });
    }),
    ClickHouseOverloadError,
  );

  assert.equal(attempts, 2);
  assert.deepEqual(records, [{
    event: "clickhouse_operation_failed",
    backend: "clickhouse",
    operation: "usage_command",
    errorClass: "overload",
    errorCode: "202",
    attempt: 2,
    durationMs: (records[0] as { durationMs: number }).durationMs,
    queueWaitMs: (records[0] as { queueWaitMs: number }).queueWaitMs,
    inFlight: (records[0] as { inFlight: number }).inFlight,
  }]);
  assert.doesNotMatch(JSON.stringify(records), /SELECT|private|usage_events/);
});

test("code가 없는 ClickHouse type도 overload로 인식한다", async () => {
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async () => undefined,
    log: () => undefined,
  });

  await assert.rejects(
    controller.run("usage_command", async () => {
      attempts += 1;
      throw Object.assign(new Error("request failed"), {
        cause: Object.assign(new Error("overloaded"), {
          type: "TOO_MANY_SIMULTANEOUS_QUERIES",
        }),
      });
    }),
    ClickHouseOverloadError,
  );

  assert.equal(attempts, 2);
});

test("문자열 overload code도 한 번 재시도하고 overload로 기록한다", async () => {
  const records: unknown[] = [];
  const sleeps: number[] = [];
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    log: (record) => records.push(record),
  });

  await assert.rejects(
    controller.run(
      "organization_dashboard_usage",
      async () => {
        attempts += 1;
        throw Object.assign(new Error("overloaded"), {
          code: "TOO_MANY_SIMULTANEOUS_QUERIES",
        });
      },
      { retryTransient: true },
    ),
    ClickHouseOverloadError,
  );

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [100]);
  assert.equal(records.length, 1);
  assert.equal(
    (records[0] as { errorClass?: unknown }).errorClass,
    "overload",
  );
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

test("cyclic cause 오류는 원래 오류를 전달하고 안전하게 분류한다", async () => {
  const records: unknown[] = [];
  const cyclicError = Object.assign(new Error("SELECT private FROM usage_events"), {
    code: "ECONNRESET",
    type: "NETWORK_ERROR",
    cause: undefined as unknown,
  });
  cyclicError.cause = cyclicError;
  const controller = new ClickHouseOperationController({
    log: (record) => records.push(record),
  });

  await assert.rejects(
    controller.run("usage_insert", async () => {
      throw cyclicError;
    }),
    (error) => error === cyclicError,
  );

  assert.equal(records.length, 1);
  const record = records[0] as { errorClass?: unknown; errorCode?: unknown };
  assert.equal(record.errorClass, "network");
  assert.equal(record.errorCode, "ECONNRESET");
  assert.doesNotMatch(JSON.stringify(records), /SELECT|private|usage_events/);
});

test("logger가 실패해도 원래 operation 오류 object를 그대로 전달한다", async () => {
  const operationError = Object.assign(new Error("query failed"), { code: "SYNTAX_ERROR" });
  const loggerError = new Error("logger failed");
  const controller = new ClickHouseOperationController({
    log: () => {
      throw loggerError;
    },
  });

  await assert.rejects(
    controller.run("invalid_query", async () => {
      throw operationError;
    }),
    (error: unknown) => error === operationError,
  );
});

test("logger가 실패해도 typed overload와 원래 cause를 보존한다", async () => {
  const operationError = Object.assign(new Error("overloaded"), { code: 202 });
  const loggerError = new Error("logger failed");
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async () => undefined,
    log: () => {
      throw loggerError;
    },
  });

  await assert.rejects(
    controller.run("usage_insert", async () => {
      attempts += 1;
      throw operationError;
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClickHouseOverloadError);
      assert.strictEqual(error.cause, operationError);
      assert.notStrictEqual(error, loggerError);
      return true;
    },
  );
  assert.equal(attempts, 2);
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

test("retryTransient 없는 overload backoff 동안에도 slot을 반환한다", async () => {
  let releaseSleep!: () => void;
  let sleepStarted = false;
  let retryAttempts = 0;
  const controller = new ClickHouseOperationController({
    maxConcurrent: 1,
    sleep: () => new Promise<void>((resolve) => {
      releaseSleep = resolve;
      sleepStarted = true;
    }),
    log: () => undefined,
  });
  const retrying = controller.run("usage_insert", async () => {
    retryAttempts += 1;
    if (retryAttempts === 1) {
      throw Object.assign(new Error("overloaded"), { code: 202 });
    }
    return "retried";
  });
  const outcome = retrying.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  await nextTurn();
  if (sleepStarted) {
    assert.equal(await controller.run("other", async () => "other"), "other");
    releaseSleep();
  }
  const settled = await outcome;

  assert.equal(sleepStarted, true);
  assert.equal(settled.ok, true);
  if (settled.ok) assert.equal(settled.value, "retried");
  assert.equal(retryAttempts, 2);
});
