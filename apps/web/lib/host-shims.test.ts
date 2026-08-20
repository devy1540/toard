import assert from "node:assert/strict";
import test from "node:test";
import { worstShimByUser, type HostShimRow } from "./host-shims";

const at = new Date("2026-08-20T00:00:00Z");

test("공개 버전 재시작 뒤에는 레거시 v0.15.55 shim을 가장 뒤처진 버전으로 고른다", () => {
  const rows: HostShimRow[] = [
    { userId: "user-1", host: "new", shimVersion: "0.0.1", lastSeenAt: at },
    { userId: "user-1", host: "legacy", shimVersion: "0.15.55", lastSeenAt: at },
    { userId: "user-2", host: "next", shimVersion: "0.0.2", lastSeenAt: at },
    { userId: "user-2", host: "baseline", shimVersion: "0.0.1", lastSeenAt: at },
  ];

  assert.deepEqual(
    Object.fromEntries(worstShimByUser(rows)),
    { "user-1": "0.15.55", "user-2": "0.0.1" },
  );
});
