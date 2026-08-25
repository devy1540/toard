import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_PERSONAL_UTILIZATION_CACHE_TAG,
  invalidateAllUtilization,
  invalidateUtilizationForUser,
  ORGANIZATION_UTILIZATION_CACHE_TAG,
  personalUtilizationCacheTag,
  utilizationCacheTagsForUser,
} from "./utilization-cache";

test("활용 지수 cache tag는 개인 사용자와 조직 집계를 분리한다", () => {
  assert.equal(personalUtilizationCacheTag("user-1"), "utilization:personal:v2:user-1");
  assert.equal(ORGANIZATION_UTILIZATION_CACHE_TAG, "utilization:organization:v2");
  assert.deepEqual(utilizationCacheTagsForUser("user-1"), [
    "utilization:personal:v2:user-1",
    "utilization:organization:v2",
  ]);
  assert.notEqual(personalUtilizationCacheTag("user-1"), personalUtilizationCacheTag("user-2"));
});

test("사용자 입력 변경은 해당 개인 tag와 조직 tag를 즉시 무효화한다", () => {
  const invalidated: string[] = [];

  invalidateUtilizationForUser("user-1", (tag) => invalidated.push(tag));

  assert.deepEqual(invalidated, [
    "utilization:personal:v2:user-1",
    "utilization:organization:v2",
  ]);
});

test("여러 사용자에 걸친 자동 보정은 전체 개인 tag와 조직 tag를 무효화한다", () => {
  const invalidated: string[] = [];

  invalidateAllUtilization((tag) => invalidated.push(tag));

  assert.deepEqual(invalidated, [
    ALL_PERSONAL_UTILIZATION_CACHE_TAG,
    ORGANIZATION_UTILIZATION_CACHE_TAG,
  ]);
});
