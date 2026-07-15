import assert from "node:assert/strict";
import test from "node:test";
import { initialE2eeHistoryState, reduceE2eeHistory } from "./e2ee-history-state";

test("PRF가 없어도 연결 기기 승인으로 unlock된다", () => {
  let state = reduceE2eeHistory(initialE2eeHistoryState, {
    type: "status",
    hasLocalKey: false,
    hasPasskeyWrapper: false,
  });
  assert.equal(state.kind, "locked");
  state = reduceE2eeHistory(state, { type: "approval-created", requestId: "r1", code: "381204" });
  assert.equal(state.kind, "approvalPending");
  state = reduceE2eeHistory(state, { type: "uck-unwrapped" });
  assert.equal(state.kind, "unlocked");
});

test("한 레코드 인증 실패는 페이지 전체를 막지 않는다", () => {
  const unlocked = reduceE2eeHistory(initialE2eeHistoryState, { type: "uck-unwrapped" });
  const state = reduceE2eeHistory(unlocked, { type: "record-failed", dedupKey: "bad" });
  assert.deepEqual(state.unavailable, new Set(["bad"]));
  assert.equal(state.kind, "unlocked");
});

test("잠그면 복호화 실패 목록과 승인 정보를 버린다", () => {
  let state = reduceE2eeHistory(initialE2eeHistoryState, { type: "uck-unwrapped" });
  state = reduceE2eeHistory(state, { type: "record-failed", dedupKey: "bad" });
  state = reduceE2eeHistory(state, { type: "lock" });
  assert.equal(state.kind, "locked");
  assert.equal(state.unavailable.size, 0);
  assert.equal(state.approval, null);
});
