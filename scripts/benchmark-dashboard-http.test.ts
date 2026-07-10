import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDashboardResponse,
  assertLocalBenchmarkTarget,
  assertNonProductionBenchmarkEnvironment,
  benchmarkPercentiles,
  dashboardFixtureStart,
  parseDashboardBenchmarkOptions,
} from "./benchmark-dashboard-http-lib";

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
    () => assertDashboardResponse(new Response("<html>data-page=org</html>"), "data-page=org"),
  );
});
