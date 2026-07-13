import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAppCgroupLimits,
  assertBenchmarkTarget,
  assertDashboardResponse,
  assertLocalBenchmarkTarget,
  assertNonProductionBenchmarkEnvironment,
  assertReferenceContainerLimits,
  assertTimezoneFixtureCoverage,
  benchmarkExecutionMode,
  benchmarkPercentiles,
  dashboardFixtureStart,
  effectiveNanoCpus,
  parseDashboardBenchmarkOptions,
  REFERENCE_RESOURCE_LIMITS,
} from "./benchmark-dashboard-http-lib";

test("timezone benchmark coverage는 eligible을 모두 소진하고 finalized 대기만 허용한다", () => {
  assert.doesNotThrow(() => assertTimezoneFixtureCoverage({
    eligible: 0,
    dayJobs: 400,
    dayCoverage: 399,
    dayWaiting: 1,
    hourJobs: 768,
    hourCoverage: 753,
    hourWaiting: 15,
  }));
  assert.throws(() => assertTimezoneFixtureCoverage({
    eligible: 1,
    dayJobs: 400,
    dayCoverage: 399,
    dayWaiting: 1,
    hourJobs: 768,
    hourCoverage: 753,
    hourWaiting: 15,
  }), /eligible/);
  assert.throws(() => assertTimezoneFixtureCoverage({
    eligible: 0,
    dayJobs: 400,
    dayCoverage: 398,
    dayWaiting: 1,
    hourJobs: 768,
    hourCoverage: 753,
    hourWaiting: 15,
  }), /coverage/);
});

test("dashboard benchmark only accepts the fixed release-gate fixture", () => {
  assert.deepEqual(parseDashboardBenchmarkOptions([]), {
    fixture: "dashboard-http-v1",
    events: 1_000_000,
    days: 400,
    users: 100,
    providers: 5,
    models: 10,
    runs: 100,
    app: "start",
  });
  assert.throws(
    () => parseDashboardBenchmarkOptions(["--runs=99"]),
    /--runs must be 100/,
  );
  assert.throws(
    () => parseDashboardBenchmarkOptions(["--app=existing"]),
    /unsupported dashboard benchmark argument/,
  );
  assert.equal(parseDashboardBenchmarkOptions(["--"]).runs, 100);
});

test("dashboard fixture keeps all 400 dates inside TTL and finalize boundaries", () => {
  assert.equal(
    dashboardFixtureStart(new Date("2026-07-10T14:00:00Z")).toISOString(),
    "2025-06-06T00:00:00.000Z",
  );
  assert.equal(
    dashboardFixtureStart(new Date("2026-07-10T01:00:00Z")).toISOString(),
    "2025-06-05T02:00:00.000Z",
  );
});

test("dashboard benchmark rejects non-local application and database targets", () => {
  assert.equal(assertLocalBenchmarkTarget("APP_BASE_URL", "http://localhost:3117"), "http://localhost:3117");
  assert.equal(assertLocalBenchmarkTarget("DATABASE_URL", "postgresql://toard:toard@127.0.0.1:5432/toard"), "postgresql://toard:toard@127.0.0.1:5432/toard");
  assert.throws(
    () => assertLocalBenchmarkTarget("APP_BASE_URL", "https://dashboard.example.com"),
    /localhost/,
  );
});

test("dashboard benchmark refuses production environment markers before setup", () => {
  assert.doesNotThrow(() => assertNonProductionBenchmarkEnvironment({ NODE_ENV: "test" }));
  assert.throws(
    () => assertNonProductionBenchmarkEnvironment({ TOARD_ENV: "production" }),
    /forbidden in production/,
  );
});

test("dashboard benchmark uses the specified sorted p50 and p95 indexes", () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 - index);
  assert.deepEqual(benchmarkPercentiles(values), { p50: 50, p95: 95 });
});

test("dashboard benchmark rejects login redirects and missing page markers", async () => {
  await assert.rejects(
    () => assertDashboardResponse(new Response("", { status: 307, headers: { location: "/login" } }), "data-page=org"),
    /login redirect/,
  );
  await assert.rejects(
    () => assertDashboardResponse(new Response("<html>wrong</html>"), "data-page=org"),
    /expected page marker/,
  );
  await assert.doesNotReject(
    () => assertDashboardResponse(
      new Response('<html><main data-dashboard-ready="org-overview">ready</main></html>'),
      'data-dashboard-ready="org-overview"',
    ),
  );
  await assert.rejects(
    () => assertDashboardResponse(
      new Response('<nav>Overview</nav><main data-dashboard-error>temporarily unavailable</main>'),
      "Overview",
    ),
    /streamed dashboard error/,
  );
});

test("release benchmark requires exact Docker reference limits", () => {
  assert.doesNotThrow(() => assertReferenceContainerLimits(REFERENCE_RESOURCE_LIMITS));
  assert.throws(
    () => assertReferenceContainerLimits([
      ...REFERENCE_RESOURCE_LIMITS.filter(({ service }) => service !== "clickhouse"),
      { service: "clickhouse", nanoCpus: 1_500_000_000, memoryBytes: 2 * 1024 ** 3 },
    ]),
    /resource limit mismatch/,
  );
  assert.equal(effectiveNanoCpus({ NanoCpus: 1_500_000_000 }), 1_500_000_000);
  assert.equal(effectiveNanoCpus({ CpuQuota: 150_000, CpuPeriod: 100_000 }), 1_500_000_000);
});

test("release app rechecks its own cgroup and verified execution mode", () => {
  assert.doesNotThrow(() => assertAppCgroupLimits("150000 100000\n", `${2 * 1024 ** 3}\n`));
  assert.throws(() => assertAppCgroupLimits("max 100000", `${2 * 1024 ** 3}`), /app cgroup CPU/);
  assert.equal(benchmarkExecutionMode({}), "diagnostic");
  assert.equal(
    benchmarkExecutionMode({ BENCHMARK_RELEASE_MODE: "1", BENCHMARK_LIMITS_VERIFIED: "docker-inspect" }),
    "release",
  );
  assert.throws(
    () => benchmarkExecutionMode({ BENCHMARK_RELEASE_MODE: "1" }),
    /Docker limits were not verified/,
  );
});

test("release mode only accepts compose services and a localhost app URL", () => {
  assert.equal(
    assertBenchmarkTarget("DATABASE_URL", "postgresql://toard:toard@postgres:5432/toard", "release"),
    "postgresql://toard:toard@postgres:5432/toard",
  );
  assert.equal(
    assertBenchmarkTarget("CLICKHOUSE_URL", "http://clickhouse:8123", "release"),
    "http://clickhouse:8123",
  );
  assert.equal(assertBenchmarkTarget("APP_BASE_URL", "http://localhost:3117", "release"), "http://localhost:3117");
  assert.throws(
    () => assertBenchmarkTarget("DATABASE_URL", "postgresql://prod.example.com/toard", "release"),
    /benchmark compose service/,
  );
  assert.throws(
    () => assertBenchmarkTarget("CLICKHOUSE_URL", "https://clickhouse.example.com", "diagnostic"),
    /localhost/,
  );
});
