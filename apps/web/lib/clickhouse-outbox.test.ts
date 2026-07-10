import assert from "node:assert/strict";
import test from "node:test";
import {
  getTimezoneRollupReadinessAt,
  toTimezoneRollupReadyPayload,
} from "./clickhouse-outbox";

function readyPool(watermark: Date, pendingJobs = 0) {
  return {
    query: async (sql: string) => {
      if (sql.includes("clickhouse_rollup_watermarks")) {
        return { rows: [{ watermark }] };
      }
      if (sql.includes("clickhouse_timezone_rollup_jobs")) {
        return { rows: [{ pending_jobs: pendingJobs }] };
      }
      return { rows: [] };
    },
  };
}

test("legacy flag가 남아 있으면 ready는 HTTP 차단 대신 fallback migration 상태를 노출한다", async () => {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  const now = new Date("2026-07-11T00:00:00.000Z");
  const readiness = await getTimezoneRollupReadinessAt(
    readyPool(new Date("2026-07-10T23:30:00.000Z")),
    { CLICKHOUSE_READ_ROLLUP: "1" },
    now,
  ).finally(() => {
    console.warn = originalWarn;
  });

  assert.deepEqual(readiness, {
    status: "fallback",
    watermark: "2026-07-10T23:30:00.000Z",
    lagSeconds: 0,
    pendingJobs: 0,
    legacyFlagMigration: "deprecated_alias",
  });
  assert.deepEqual(toTimezoneRollupReadyPayload(readiness), {
    timezone: "fallback",
    timezoneWatermark: "2026-07-10T23:30:00.000Z",
    timezoneLagSeconds: 0,
    timezonePendingJobs: 0,
    legacyFlagMigration: "deprecated_alias",
  });
});

test("새 flag가 명시되면 legacy alias보다 우선하되 남은 legacy 값은 migration 상태로 보인다", async () => {
  const readiness = await getTimezoneRollupReadinessAt(
    readyPool(new Date("2026-07-10T23:30:00.000Z")),
    {
      CLICKHOUSE_READ_ROLLUP: "1",
      CLICKHOUSE_READ_TIMEZONE_ROLLUP: "0",
    },
    new Date("2026-07-11T00:00:00.000Z"),
  );

  assert.equal(readiness.status, "fallback");
  assert.equal(readiness.watermark, null);
  assert.equal(readiness.legacyFlagMigration, "deprecated_alias");
});
