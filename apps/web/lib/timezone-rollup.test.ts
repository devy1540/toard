import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  addLocalCalendarDays,
  canonicalTimezoneId,
  firstInstantOfLocalDate,
} from "@toard/core";
import type { Pool } from "pg";
import {
  MAX_ACTIVE_ROLLUP_TIMEZONES,
  PgTimezoneRollupRepository,
  TIMEZONE_ROLLUP_DAY_PREWARM_DAYS,
  TIMEZONE_ROLLUP_HOUR_PREWARM_DAYS,
  TIMEZONE_ROLLUP_JOBS_PER_TICK,
  activateTimezoneRollupWith,
  createTimezoneRollupActivationGate,
  enqueueTimezoneRollupWith,
  resolveSupportedRollupTimezone,
  runTimezoneRollupWorkerWith,
  timezoneCoverageCutoffs,
  timezonePrewarmWindows,
  type TimezoneRollupJob,
  type TimezoneRollupRepository,
} from "./timezone-rollup";

test("retention coverage 경계는 prewarm local day window와 같은 상수를 사용한다", () => {
  const timezone = "America/Los_Angeles";
  const cutoffs = timezoneCoverageCutoffs(
    timezone,
    new Date("2026-11-02T12:00:00.000Z"),
  );

  assert.equal(
    cutoffs.day.toISOString(),
    firstInstantOfLocalDate(
      addLocalCalendarDays("2026-11-02", -(TIMEZONE_ROLLUP_DAY_PREWARM_DAYS - 1)),
      timezone,
    ).toISOString(),
  );
  assert.equal(
    cutoffs.hour.toISOString(),
    firstInstantOfLocalDate(
      addLocalCalendarDays("2026-11-02", -(TIMEZONE_ROLLUP_HOUR_PREWARM_DAYS - 1)),
      timezone,
    ).toISOString(),
  );
});

test("day sourceTo는 DST 다음 로컬 날짜 경계다", () => {
  const timezone = "America/Los_Angeles";
  const spring = timezonePrewarmWindows(
    "day",
    timezone,
    new Date("2026-03-10T12:00:00.000Z"),
  ).find(({ bucket }) => bucket.toISOString() === "2026-03-08T08:00:00.000Z");
  const fall = timezonePrewarmWindows(
    "day",
    timezone,
    new Date("2026-11-03T12:00:00.000Z"),
  ).find(({ bucket }) => bucket.toISOString() === "2026-11-01T07:00:00.000Z");

  assert.ok(spring);
  assert.ok(fall);
  assert.equal(spring.sourceTo.getTime() - spring.bucket.getTime(), 23 * 60 * 60 * 1_000);
  assert.equal(fall.sourceTo.getTime() - fall.bucket.getTime(), 25 * 60 * 60 * 1_000);
});

function fakeTimezoneRollupRepository(options: { capacity?: boolean } = {}) {
  const jobs = new Map<string, TimezoneRollupJob>();
  const chunks: Date[][] = [];
  const coverage = new Set<string>();
  const lockKeys: string[] = [];
  const claimLimits: number[] = [];
  const activeTimezones = new Set<string>();
  let sequence = 0;
  let lockHeld = false;
  const key = (resolution: string, timezone: string, bucket: Date) =>
    `${resolution}:${timezone}:${bucket.toISOString()}`;

  const repo: TimezoneRollupRepository = {
    async ensureRegisteredTimezone(timezone, maximum) {
      assert.equal(maximum, MAX_ACTIVE_ROLLUP_TIMEZONES);
      if (!(options.capacity ?? true)) return "capacity";
      if (activeTimezones.has(timezone)) return "existing";
      activeTimezones.add(timezone);
      return "created";
    },
    async prewarmMissingJobs(resolution, timezone, windows) {
      chunks.push(windows.map(({ bucket }) => bucket));
      let inserted = 0;
      for (const { bucket, sourceTo } of windows) {
        const jobKey = key(resolution, timezone, bucket);
        if (!jobs.has(jobKey) && !coverage.has(jobKey)) {
          jobs.set(jobKey, {
            id: `job-${++sequence}`,
            resolution,
            timezone,
            bucket,
            sourceTo,
            generation: 0,
            status: "pending",
          });
          inserted++;
        }
      }
      return inserted;
    },
    async claimJobs(limit) {
      claimLimits.push(limit);
      return [...jobs.values()]
        .filter((job) => job.status === "pending")
        .slice(0, limit)
        .map((job) => {
          job.status = "inflight";
          return { ...job };
        });
    },
    async countBacklog() {
      const eligible = [...jobs.values()].filter((job) => job.status === "pending").length;
      return { eligible, waitingForBase: 0 };
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
    async markDone(id, generation) {
      assert.equal(lockHeld, false, "상태 갱신은 advisory lock client를 중첩 점유하지 않아야 함");
      const job = [...jobs.values()].find((candidate) => candidate.id === id);
      if (job && job.generation === generation) {
        job.status = "done";
        coverage.add(key(job.resolution, job.timezone, job.bucket));
        return true;
      }
      return false;
    },
    async markPending(id, generation) {
      const job = [...jobs.values()].find((candidate) => candidate.id === id);
      if (job?.generation === generation) job.status = "pending";
    },
    async disableTimezone(timezone) {
      activeTimezones.delete(timezone);
      for (const job of jobs.values()) {
        if (job.timezone === timezone) job.status = "done";
      }
    },
  };

  return { repo, jobs, chunks, lockKeys, claimLimits, activeTimezones };
}

test("같은 시간대·해상도·버킷 작업은 한 번만 enqueue한다", async () => {
  const fixture = fakeTimezoneRollupRepository();
  const bucket = new Date("2026-07-01T00:00:00Z");

  await enqueueTimezoneRollupWith(fixture.repo, "day", "Asia/Seoul", bucket);
  await enqueueTimezoneRollupWith(fixture.repo, "day", "Asia/Seoul", bucket);

  assert.equal(fixture.jobs.size, 1);
});

test("활성화는 최근 400개 로컬 일별 버킷을 최대 16개 chunk로 prewarm한다", async () => {
  const fixture = fakeTimezoneRollupRepository();

  await activateTimezoneRollupWith(
    fixture.repo,
    "America/Los_Angeles",
    new Date("2026-03-10T12:00:00.000Z"),
  );

  const dayJobs = [...fixture.jobs.values()].filter((job) => job.resolution === "day");
  assert.equal(dayJobs.length, 400);
  assert.ok(fixture.chunks.every((chunk) => chunk.length > 0 && chunk.length <= 16));

  const starts = new Set(dayJobs.map((job) => job.bucket.toISOString()));
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
  assert.equal([...fixture.jobs.values()].filter((job) => job.resolution === "day").length, 400);
  assert.ok([...fixture.jobs.values()].some((job) => job.resolution === "hour"));
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

  const starts = new Set(
    [...fixture.jobs.values()]
      .filter((job) => job.resolution === "day")
      .map((job) => job.bucket.toISOString()),
  );
  assert.equal(starts.has("2025-09-07T04:00:00.000Z"), true);
  assert.equal(starts.has("2025-09-07T03:00:00.000Z"), false);
});

test("worker는 기본 8개를 처리하고 실패 작업은 pending 복귀 후 tick을 실패시킨다", async () => {
  const fixture = fakeTimezoneRollupRepository();
  for (let i = 0; i < 9; i++) {
    await enqueueTimezoneRollupWith(
      fixture.repo,
      i === 1 ? "hour" : "day",
      "Asia/Seoul",
      new Date(Date.UTC(2026, 6, 1 + i)),
    );
  }

  await assert.rejects(
    runTimezoneRollupWorkerWith(fixture.repo, {
      async supportsTimezone() {
        return true;
      },
      async compactTimezoneRollup(_resolution, _timezone, bucket) {
        if (bucket.toISOString() === "2026-07-02T00:00:00.000Z") throw new Error("ClickHouse unavailable");
        return 3;
      },
    }),
    /ClickHouse unavailable/,
  );

  assert.equal(fixture.lockKeys.length, TIMEZONE_ROLLUP_JOBS_PER_TICK);
  assert.equal(fixture.lockKeys[0], "timezone-rollup:day:Asia/Seoul");
  assert.equal(fixture.lockKeys[1], "timezone-rollup:hour:Asia/Seoul");
  assert.equal([...fixture.jobs.values()].filter((job) => job.status === "done").length, 7);
  assert.equal([...fixture.jobs.values()].filter((job) => job.status === "pending").length, 2);
});

test("worker는 adaptive job 한도를 queue claim에 전달한다", async () => {
  const fixture = fakeTimezoneRollupRepository();
  for (let index = 0; index < 5; index++) {
    await enqueueTimezoneRollupWith(
      fixture.repo,
      "hour",
      "Asia/Seoul",
      new Date(Date.UTC(2026, 6, 1, index)),
    );
  }

  const result = await runTimezoneRollupWorkerWith(fixture.repo, {
    async supportsTimezone() {
      return true;
    },
    async compactTimezoneRollup() {
      return 1;
    },
  }, 3);

  assert.deepEqual(result, { jobs: 3, rows: 3 });
  assert.deepEqual(fixture.claimLimits, [3]);
});

test("PostgreSQL queue claim은 adaptive 한도를 기존 기본값 8로 다시 제한하지 않는다", async () => {
  let requestedLimit: unknown;
  const pool = {
    async query(_sql: string, params?: unknown[]) {
      requestedLimit = params?.[0];
      return { rows: [] };
    },
  } as unknown as Pool;
  const repository = new PgTimezoneRollupRepository(pool);

  await repository.claimJobs(20);

  assert.equal(requestedLimit, 20);
});

test("PostgreSQL queue는 watermark 이전이고 dirty가 없는 job만 claim한다", async () => {
  let query = "";
  const pool = {
    async query(sql: string) {
      query = sql;
      return {
        rows: [{
          id: "finalized-hour",
          resolution: "hour",
          timezone: "Asia/Seoul",
          bucket: new Date("2026-07-01T00:00:00.000Z"),
          source_to: new Date("2026-07-01T01:00:00.000Z"),
          generation: "4",
        }],
      };
    },
  } as unknown as Pool;

  const claimed = await new PgTimezoneRollupRepository(pool).claimJobs(32);

  assert.deepEqual(claimed.map((job) => job.id), ["finalized-hour"]);
  assert.equal(claimed[0]?.sourceTo.toISOString(), "2026-07-01T01:00:00.000Z");
  assert.equal(claimed[0]?.generation, 4);
  assert.match(query, /source_to <= watermark\.watermark/);
  assert.match(query, /NOT EXISTS[\s\S]*clickhouse_rollup_dirty_buckets/);
  assert.match(query, /dirty\.bucket >= job\.bucket/);
  assert.match(query, /dirty\.bucket < job\.source_to/);
});

test("claim 뒤 generation이 바뀌면 coverage를 승인하지 않는다", async () => {
  let query = "";
  const pool = {
    async query(sql: string) {
      query = sql;
      return { rows: [{ completed: 0 }], rowCount: 1 };
    },
  } as unknown as Pool;

  const accepted = await new PgTimezoneRollupRepository(pool).markDone("job", 4);

  assert.equal(accepted, false);
  assert.match(query, /generation = \$2/);
  assert.match(query, /source_to <= watermark\.watermark/);
  assert.match(query, /NOT EXISTS[\s\S]*clickhouse_rollup_dirty_buckets/);
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

test("activation gate는 같은 process의 동일 시간대 요청을 한 번만 실행한다", async () => {
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

test("설정 저장·viewer resolver·startup은 non-blocking activation을 연결한다", () => {
  const actions = readFileSync(new URL("../app/(dashboard)/settings/actions.ts", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("./viewer-time.ts", import.meta.url), "utf8");
  const outbox = readFileSync(new URL("./clickhouse-outbox.ts", import.meta.url), "utf8");
  const rollup = readFileSync(new URL("./timezone-rollup.ts", import.meta.url), "utf8");

  assert.match(
    actions,
    /await getPool\(\)\.query\("UPDATE users SET timezone[\s\S]*void activateTimezoneRollup\(tz\)/,
  );
  assert.match(viewer, /activate:\s*activateTimezoneRollupNonBlocking/);
  assert.match(actions, /resolveSupportedRollupTimezone\(raw\)/);
  assert.match(viewer, /resolveTimezone:\s*resolveSupportedRollupTimezone/);
  assert.match(rollup, /SELECT DISTINCT timezone[\s\S]*FROM users/);
  assert.match(outbox, /compactClickHouseTimezoneRollups/);
  assert.match(
    rollup,
    /ON CONFLICT \(resolution, timezone, bucket\) DO NOTHING/,
  );
  assert.match(rollup, /WHERE job\.id = \$1[\s\S]*AND job\.status = 'inflight'/);
  assert.doesNotMatch(rollup, /markPending[\s\S]*DELETE FROM clickhouse_timezone_rollup_coverage/);
  assert.match(
    rollup,
    /INSERT INTO clickhouse_timezone_rollup_coverage[\s\S]*FROM completed/,
  );
});
