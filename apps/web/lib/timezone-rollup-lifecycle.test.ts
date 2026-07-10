import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_ACTIVE_ROLLUP_TIMEZONES,
  TIMEZONE_ROLLUP_DAY_PREWARM_DAYS,
  TIMEZONE_ROLLUP_HOUR_PREWARM_DAYS,
  TIMEZONE_ROLLUP_PREWARM_CHUNK_BUCKETS,
  activatePersistedTimezoneRollupsWith,
  activateTimezoneRollupWith,
  type TimezoneRollupJob,
  type TimezoneRollupRegistration,
  type TimezoneRollupRepository,
  type TimezoneRollupResolution,
} from "./timezone-rollup";
import { resolveViewerTimezoneWith } from "./viewer-time";

const jobKey = (resolution: TimezoneRollupResolution, timezone: string, bucket: Date) =>
  `${resolution}:${timezone}:${bucket.toISOString()}`;

function lifecycleRepository(initialTimezones: string[] = []) {
  const registered = new Set(initialTimezones);
  const jobs = new Map<string, TimezoneRollupJob>();
  const coverage = new Set<string>();
  const chunks: Array<{ resolution: TimezoneRollupResolution; buckets: Date[] }> = [];
  let sequence = 0;

  const repository: TimezoneRollupRepository = {
    async ensureRegisteredTimezone(timezone, maximum): Promise<TimezoneRollupRegistration> {
      assert.equal(maximum, MAX_ACTIVE_ROLLUP_TIMEZONES);
      if (registered.has(timezone)) return "existing";
      if (registered.size >= maximum) return "capacity";
      registered.add(timezone);
      return "created";
    },
    async prewarmMissingJobs(resolution, timezone, buckets) {
      chunks.push({ resolution, buckets: [...buckets] });
      let inserted = 0;
      for (const bucket of buckets) {
        const key = jobKey(resolution, timezone, bucket);
        if (coverage.has(key) || jobs.has(key)) continue;
        jobs.set(key, {
          id: `job-${++sequence}`,
          resolution,
          timezone,
          bucket,
          status: "pending",
        });
        inserted++;
      }
      return inserted;
    },
    async claimJobs() {
      return [];
    },
    async withAdvisoryLock() {
      return { acquired: false } as const;
    },
    async markDone(id) {
      const job = [...jobs.values()].find((candidate) => candidate.id === id);
      if (!job) return;
      job.status = "done";
      coverage.add(jobKey(job.resolution, job.timezone, job.bucket));
    },
    async markPending(id) {
      const job = [...jobs.values()].find((candidate) => candidate.id === id);
      if (job) job.status = "pending";
    },
    async disableTimezone(timezone) {
      registered.delete(timezone);
    },
  };

  return {
    repository,
    registered,
    jobs,
    coverage,
    chunks,
    completeAll() {
      for (const job of jobs.values()) {
        job.status = "done";
        coverage.add(jobKey(job.resolution, job.timezone, job.bucket));
      }
    },
  };
}

test("신규 activation은 최근 400 local day와 32 local day의 hour를 16 bucket chunk로 prewarm한다", async () => {
  const fixture = lifecycleRepository();
  const result = await activateTimezoneRollupWith(
    fixture.repository,
    "America/Los_Angeles",
    new Date("2026-03-10T12:00:00.000Z"),
  );

  assert.equal(result.registration, "created");
  assert.equal(TIMEZONE_ROLLUP_DAY_PREWARM_DAYS, 400);
  assert.equal(TIMEZONE_ROLLUP_HOUR_PREWARM_DAYS, 32);
  assert.equal(TIMEZONE_ROLLUP_PREWARM_CHUNK_BUCKETS, 16);
  assert.equal([...fixture.jobs.values()].filter((job) => job.resolution === "day").length, 400);
  assert.equal(
    [...fixture.jobs.values()].filter((job) => job.resolution === "hour").length,
    767,
    "spring-forward가 포함된 최근 32 local days는 실제 767시간이어야 한다",
  );
  assert.ok(fixture.chunks.every(({ buckets }) => buckets.length > 0 && buckets.length <= 16));
  assert.deepEqual(result.prewarmed, { day: 400, hour: 767 });
});

test("재시작·replica의 반복 activation은 done job과 durable coverage를 보존한다", async () => {
  const fixture = lifecycleRepository();
  const now = new Date("2026-07-10T12:00:00.000Z");
  await activateTimezoneRollupWith(fixture.repository, "Asia/Seoul", now);
  fixture.completeAll();
  const beforeCoverage = new Set(fixture.coverage);

  const result = await activateTimezoneRollupWith(fixture.repository, "Asia/Seoul", now);

  assert.equal(result.registration, "existing");
  assert.deepEqual(result.prewarmed, { day: 0, hour: 0 });
  assert.ok([...fixture.jobs.values()].every((job) => job.status === "done"));
  assert.deepEqual(fixture.coverage, beforeCoverage);
});

test("기존 registry는 coverage와 job이 모두 빠진 bucket만 다시 prewarm한다", async () => {
  const fixture = lifecycleRepository();
  const now = new Date("2026-07-10T12:00:00.000Z");
  await activateTimezoneRollupWith(fixture.repository, "Asia/Seoul", now);
  fixture.completeAll();
  const missing = [...fixture.jobs.entries()].find(([, job]) => job.resolution === "hour");
  assert.ok(missing);
  fixture.jobs.delete(missing[0]);
  fixture.coverage.delete(missing[0]);

  const result = await activateTimezoneRollupWith(fixture.repository, "Asia/Seoul", now);

  assert.deepEqual(result.prewarmed, { day: 0, hour: 1 });
  assert.equal(fixture.jobs.get(missing[0])?.status, "pending");
});

test("registry가 실제 64개면 신규 timezone activation을 거부한다", async () => {
  const fixture = lifecycleRepository(
    Array.from({ length: MAX_ACTIVE_ROLLUP_TIMEZONES }, (_, index) => `Etc/GMT${index === 0 ? "" : index > 12 ? `+${index - 12}` : `-${index}`}`),
  );

  await assert.rejects(
    activateTimezoneRollupWith(fixture.repository, "Asia/Seoul"),
    /64개/,
  );
});

test("startup seed는 ORG_TIMEZONE과 saved timezone을 canonicalize/capability-check하고 실패를 격리한다", async () => {
  const activated: string[] = [];
  const result = await activatePersistedTimezoneRollupsWith(
    {
      orgTimezone: "US/Pacific",
      savedTimezones: ["America/Los_Angeles", "Asia/Seoul", "Invalid/Timezone", null],
    },
    async (timezone) => timezone !== "Asia/Seoul",
    async (timezone) => {
      activated.push(timezone);
      if (timezone === "America/Los_Angeles") throw new Error("temporary postgres failure");
    },
  );

  assert.deepEqual(activated, ["America/Los_Angeles"]);
  assert.deepEqual(result, {
    activated: [],
    skipped: ["Asia/Seoul", "Invalid/Timezone"],
    failed: ["America/Los_Angeles"],
  });

  const retried: string[] = [];
  const retry = await activatePersistedTimezoneRollupsWith(
    { orgTimezone: "US/Pacific", savedTimezones: [] },
    async () => true,
    async (timezone) => { retried.push(timezone); },
  );
  assert.deepEqual(retried, ["America/Los_Angeles"]);
  assert.deepEqual(retry.failed, []);
});

test("viewer resolver는 saved와 ORG_TIMEZONE 선택도 process-local activation gate에 전달한다", async () => {
  const activated: string[] = [];
  const resolveTimezone = async (timezone: string) => timezone === "UTC" ? "UTC" : timezone;
  const activate = (timezone: string) => { activated.push(timezone); };

  assert.equal(await resolveViewerTimezoneWith({
    savedTimezone: "Asia/Seoul",
    cookieTimezone: "Europe/London",
    orgTimezone: "UTC",
    resolveTimezone,
    activate,
  }), "Asia/Seoul");
  assert.deepEqual(activated, ["Asia/Seoul"]);

  activated.length = 0;
  assert.equal(await resolveViewerTimezoneWith({
    savedTimezone: null,
    cookieTimezone: null,
    orgTimezone: "UTC",
    resolveTimezone,
    activate,
  }), "UTC");
  assert.deepEqual(activated, ["UTC"]);
});

test("startup과 rollout CLI는 persisted timezone seed를 non-blocking·비대화형으로 연결한다", () => {
  const instrumentation = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("./viewer-time.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const script = new URL("../../../scripts/activate-timezone-rollups.ts", import.meta.url);

  assert.match(instrumentation, /activatePersistedTimezoneRollupsNonBlocking\(\)/);
  assert.doesNotMatch(instrumentation, /close(?:Pool|Storage)\(/);
  assert.doesNotMatch(viewer, /close(?:Pool|Storage)\(/);
  assert.equal(packageJson.scripts?.["rollup:activate-timezones"], "tsx scripts/activate-timezone-rollups.ts");
  assert.equal(existsSync(script), true);
  const scriptSource = readFileSync(script, "utf8");
  assert.match(scriptSource, /activatePersistedTimezoneRollups\(\)/);
  assert.match(scriptSource, /finally\s*{[\s\S]*await closeStorage\(\)[\s\S]*await closePool\(\)/);
});
