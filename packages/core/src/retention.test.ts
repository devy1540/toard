import assert from "node:assert/strict";
import test from "node:test";
import {
  CLICKHOUSE_RAW_RETENTION_DAYS,
  CLICKHOUSE_RAW_RETENTION_SAFETY_DAYS,
  USAGE_EVENT_LOGICAL_RETENTION_DAYS,
} from "./retention";

test("logical late acceptance는 90일이고 raw 물리 보존은 7일 grace를 더한 97일이다", () => {
  assert.equal(USAGE_EVENT_LOGICAL_RETENTION_DAYS, 90);
  assert.equal(CLICKHOUSE_RAW_RETENTION_SAFETY_DAYS, 7);
  assert.equal(
    CLICKHOUSE_RAW_RETENTION_DAYS,
    USAGE_EVENT_LOGICAL_RETENTION_DAYS + CLICKHOUSE_RAW_RETENTION_SAFETY_DAYS,
  );
  assert.equal(CLICKHOUSE_RAW_RETENTION_DAYS, 97);
});
