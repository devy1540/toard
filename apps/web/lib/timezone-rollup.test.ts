import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalTimezoneId } from "@toard/core";
import {
  MAX_ACTIVE_ROLLUP_TIMEZONES,
  TIMEZONE_ROLLUP_JOBS_PER_TICK,
  activateTimezoneRollupWith,
  createTimezoneRollupActivationGate,
  enqueueTimezoneRollupWith,
  resolveSupportedRollupTimezone,
  runTimezoneRollupWorkerWith,
  type TimezoneRollupJob,
  type TimezoneRollupRepository,
} from "./timezone-rollup";

function fakeTimezoneRollupRepository(options: { capacity?: boolean } = {}) {
  const jobs = new Map<string, TimezoneRollupJob>();
  const chunks: Date[][] = [];
  const lockKeys: string[] = [];
  const activeTimezones = new Set<string>();
  let sequence = 0;
  let lockHeld = false;
  const key = (resolution: string, timezone: string, bucket: Date) =>
    `${resolution}:${timezone}:${bucket.toISOString()}`;

  const repo: TimezoneRollupRepository = {
    async activateTimezone(timezone, maximum) {
      assert.equal(maximum, MAX_ACTIVE_ROLLUP_TIMEZONES);
      activeTimezones.add(timezone);
      return options.capacity ?? true;
    },
    async enqueueJobs(resolution, timezone, buckets) {
      chunks.push([...buckets]);
      for (const bucket of buckets) {
        const jobKey = key(resolution, timezone, bucket);
        if (!jobs.has(jobKey)) {
          jobs.set(jobKey, {
            id: `job-${++sequence}`,
            resolution,
            timezone,
            bucket,
            status: "pending",
          });
        }
      }
    },
    async claimJobs(limit) {
      return [...jobs.values()]
        .filter((job) => job.status === "pending")
        .slice(0, limit)
        .map((job) => {
          job.status = "inflight";
          return { ...job };
        });
    },
    async withAdvisoryLock(lockKey, operation) {
      lockKeys.push(lockKey);
      lockHeld = true;
      try {
        return { acquired: true, value: await operation() };
      } finally {
        lockHeld = false;
      }
    },
    async markDone(id) {
      assert.equal(lockHeld, false, "상태 갱신은 advisory lock client를 중첩 점유하지 않아야 함");
      const job = [...jobs.values()].find((candidate) => candidate.id === id);
      if (job) job.status = "done";
    },
    async markPending(id) {
      const job = [...jobs.values()].find((candidate) => candidate.id === id);
      if (job) job.status = "pending";
    },
    async disableTimezone(timezone) {
      activeTimezones.delete(timezone);
      for (const job of jobs.values()) {
        if (job.timezone === timezone) job.status = "done";
      }
    },
  };

  return { repo, jobs, chunks, lockKeys, activeTimezones };
}

test("같은 시간대·해상도·버킷 작업은 한 번만 enqueue한다", async () => {
  const fixture = fakeTimezoneRollupRepository();
  const bucket = new Date("2026-07-01T00:00:00Z");

  await enqueueTimezoneRollupWith(fixture.repo, "day", "Asia/Seoul", bucket);
  await enqueueTimezoneRollupWith(fixture.repo, "day", "Asia/Seoul", bucket);

  assert.equal(fixture.jobs.size, 1);
});

test("활성화는 최근 400개 로컬 일별 버킷을 최대 16개 chunk로 enqueue한다", async () => {
  const fixture = fakeTimezoneRollupRepository();

  await activateTimezoneRollupWith(
    fixture.repo,
    "America/Los_Angeles",
    new Date("2026-03-10T12:00:00.000Z"),
  );

  assert.equal(fixture.chunks.flat().length, 400);
  assert.equal(fixture.chunks.length, 25);
  assert.ok(fixture.chunks.every((chunk) => chunk.length > 0 && chunk.length <= 16));

  const starts = new Set(fixture.chunks.flat().map((bucket) => bucket.toISOString()));
  assert.equal(starts.has("2026-03-08T08:00:00.000Z"), true);
  assert.equal(starts.has("2026-03-09T07:00:00.000Z"), true);
  assert.equal(
    new Date("2026-03-09T07:00:00.000Z").getTime() -
      new Date("2026-03-08T08:00:00.000Z").getTime(),
    23 * 60 * 60 * 1000,
  );
});

test("활성화는 IANA 시간대만 허용하고 registry 64개 상한을 강제한다", async () => {
  const fixture = fakeTimezoneRollupRepository();
  await assert.rejects(
    activateTimezoneRollupWith(fixture.repo, "UTC'); DROP TABLE users; --"),
    /유효한 IANA/,
  );
  await assert.rejects(
    activateTimezoneRollupWith(fixture.repo, "PST"),
    /유효한 IANA/,
  );

  const full = fakeTimezoneRollupRepository({ capacity: false });
  await assert.rejects(
    activateTimezoneRollupWith(full.repo, "Asia/Seoul"),
    /64개/,
  );
  assert.equal(full.chunks.length, 0);
});

test("alias activation은 canonical registry와 job key 하나로 합쳐진다", async () => {
  const fixture = fakeTimezoneRollupRepository();
  const now = new Date("2026-03-10T12:00:00.000Z");

  await activateTimezoneRollupWith(fixture.repo, "US/Pacific", now);
  await activateTimezoneRollupWith(fixture.repo, "America/Los_Angeles", now);

  assert.deepEqual([...fixture.activeTimezones], ["America/Los_Angeles"]);
  assert.equal(fixture.jobs.size, 400);
  assert.equal(canonicalTimezoneId("US/Pacific"), "America/Los_Angeles");
});

test("ClickHouse 미지원 timezone은 registry와 prewarm 전에 거부한다", async () => {
  const fixture = fakeTimezoneRollupRepository();

  await assert.rejects(
    activateTimezoneRollupWith(
      fixture.repo,
      "America/Coyhaique",
      new Date("2026-03-10T12:00:00.000Z"),
      async () => false,
    ),
    /ClickHouse가 지원하지 않는/,
  );
  assert.equal(fixture.activeTimezones.size, 0);
  assert.equal(fixture.jobs.size, 0);
});

test("지원 여부 resolver는 canonical ID로 capability를 확인한다", async () => {
  const checked: string[] = [];
  const supported = async (timezone: string) => {
    checked.push(timezone);
    return timezone !== "America/Coyhaique";
  };

  assert.equal(
    await resolveSupportedRollupTimezone("US/Pacific", supported),
    "America/Los_Angeles",
  );
  assert.equal(await resolveSupportedRollupTimezone("America/Coyhaique", supported), null);
  assert.deepEqual(checked, ["America/Los_Angeles", "America/Coyhaique"]);
});

test("Santiago 자정 gap 날짜 prewarm은 실제 local date 첫 instant를 사용한다", async () => {
  const fixture = fakeTimezoneRollupRepository();

  await activateTimezoneRollupWith(
    fixture.repo,
    "America/Santiago",
    new Date("2026-07-10T12:00:00.000Z"),
  );

  const starts = new Set(fixture.chunks.flat().map((bucket) => bucket.toISOString()));
  assert.equal(starts.has("2025-09-07T04:00:00.000Z"), true);
  assert.equal(starts.has("2025-09-07T03:00:00.000Z"), false);
});

test("worker는 최대 8개를 advisory lock으로 처리하고 실패 작업은 pending으로 복귀한다", async () => {
  const fixture = fakeTimezoneRollupRepository();
  for (let i = 0; i < 9; i++) {
    await enqueueTimezoneRollupWith(
      fixture.repo,
      i === 1 ? "hour" : "day",
      "Asia/Seoul",
      new Date(Date.UTC(2026, 6, 1 + i)),
    );
  }

  const result = await runTimezoneRollupWorkerWith(fixture.repo, {
    async supportsTimezone() {
      return true;
    },
    async compactTimezoneRollup(_resolution, _timezone, bucket) {
      if (bucket.toISOString() === "2026-07-02T00:00:00.000Z") throw new Error("ClickHouse unavailable");
      return 3;
    },
  });

  assert.deepEqual(result, { jobs: 7, rows: 21 });
  assert.equal(fixture.lockKeys.length, TIMEZONE_ROLLUP_JOBS_PER_TICK);
  assert.equal(fixture.lockKeys[0], "timezone-rollup:day:Asia/Seoul");
  assert.equal(fixture.lockKeys[1], "timezone-rollup:hour:Asia/Seoul");
  assert.equal([...fixture.jobs.values()].filter((job) => job.status === "done").length, 7);
  assert.equal([...fixture.jobs.values()].filter((job) => job.status === "pending").length, 2);
});

test("ClickHouse capability가 사라진 timezone job은 한 tick에 drain되어 정상 queue를 굶기지 않는다", async () => {
  const fixture = fakeTimezoneRollupRepository();
  for (let index = 0; index < 8; index++) {
    await enqueueTimezoneRollupWith(
      fixture.repo,
      "day",
      "America/Coyhaique",
      new Date(Date.UTC(2026, 0, index + 1)),
    );
  }
  await enqueueTimezoneRollupWith(
    fixture.repo,
    "day",
    "Asia/Seoul",
    new Date("2026-01-09T00:00:00.000Z"),
  );
  const compactor = {
    async supportsTimezone(timezone: string) {
      return timezone !== "America/Coyhaique";
    },
    async compactTimezoneRollup() {
      return 3;
    },
  };

  assert.deepEqual(await runTimezoneRollupWorkerWith(fixture.repo, compactor), { jobs: 0, rows: 0 });
  assert.equal(
    [...fixture.jobs.values()].filter((job) => job.timezone === "America/Coyhaique" && job.status !== "done").length,
    0,
  );
  assert.deepEqual(await runTimezoneRollupWorkerWith(fixture.repo, compactor), { jobs: 1, rows: 3 });
});

test("cookie activation gate는 같은 process의 동일 시간대 요청을 한 번만 실행한다", async () => {
  let activations = 0;
  let resolveActivation: (() => void) | undefined;
  const gate = createTimezoneRollupActivationGate(async () => {
    activations++;
    await new Promise<void>((resolve) => {
      resolveActivation = resolve;
    });
  });

  gate("Asia/Kathmandu");
  gate("Asia/Kathmandu");
  assert.equal(activations, 1);
  resolveActivation?.();
  await new Promise((resolve) => setImmediate(resolve));
  gate("Asia/Kathmandu");
  assert.equal(activations, 1);
});

test("설정 저장과 cookie fallback은 DB 성공 뒤 non-blocking activation을 연결한다", () => {
  const actions = readFileSync(new URL("../app/(dashboard)/settings/actions.ts", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("./viewer-time.ts", import.meta.url), "utf8");
  const outbox = readFileSync(new URL("./clickhouse-outbox.ts", import.meta.url), "utf8");
  const rollup = readFileSync(new URL("./timezone-rollup.ts", import.meta.url), "utf8");

  assert.match(
    actions,
    /await getPool\(\)\.query\("UPDATE users SET timezone[\s\S]*void activateTimezoneRollup\(tz\)/,
  );
  assert.match(viewer, /activateTimezoneRollupNonBlocking\(resolvedCookie\)/);
  assert.match(actions, /resolveSupportedRollupTimezone\(raw\)/);
  assert.match(viewer, /resolveSupportedRollupTimezone\(cookieTz\)/);
  assert.match(outbox, /compactClickHouseTimezoneRollups/);
  assert.match(
    rollup,
    /ON CONFLICT \(resolution, timezone, bucket\) DO UPDATE[\s\S]*status = 'pending'/,
  );
  assert.match(rollup, /WHERE id = \$1[\s\S]*AND status = 'inflight'/);
  assert.match(rollup, /DELETE FROM clickhouse_timezone_rollup_coverage/);
  assert.match(
    rollup,
    /INSERT INTO clickhouse_timezone_rollup_coverage[\s\S]*FROM completed/,
  );
});
