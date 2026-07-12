import assert from "node:assert/strict";
import test from "node:test";
import { createRollupStatusRequestGate } from "../app/(dashboard)/admin/rollup-status-request-gate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("old poll은 control 뒤 새 refresh가 반영된 상태를 덮지 못한다", async () => {
  const gate = createRollupStatusRequestGate();
  const oldResponse = deferred<string>();
  const duringControlResponse = deferred<string>();
  const newResponse = deferred<string>();
  let rendered = "initial";

  const apply = async (
    ticket: ReturnType<typeof gate.begin>,
    response: Promise<string>,
  ) => {
    const value = await response;
    if (gate.canCommit(ticket)) rendered = value;
  };

  const oldPoll = gate.begin();
  const oldApply = apply(oldPoll, oldResponse.promise);

  gate.invalidate(); // control 시작
  const duringControlPoll = gate.begin();
  const duringControlApply = apply(duringControlPoll, duringControlResponse.promise);

  gate.invalidate(); // control 성공
  const newRefresh = gate.begin();
  const newApply = apply(newRefresh, newResponse.promise);

  assert.equal(oldPoll.signal.aborted, true);
  assert.equal(duringControlPoll.signal.aborted, true);
  assert.equal(newRefresh.signal.aborted, false);

  newResponse.resolve("paused:new");
  await newApply;
  assert.equal(rendered, "paused:new");

  oldResponse.resolve("running:old");
  duringControlResponse.resolve("running:during-control");
  await Promise.all([oldApply, duringControlApply]);
  assert.equal(rendered, "paused:new");
});

test("unmount dispose는 진행 중 GET을 abort하고 이후 completion을 무시한다", async () => {
  const gate = createRollupStatusRequestGate();
  const response = deferred<string>();
  const ticket = gate.begin();
  let rendered = "initial";
  const apply = response.promise.then((value) => {
    if (gate.canCommit(ticket)) rendered = value;
  });

  gate.dispose();
  assert.equal(ticket.signal.aborted, true);
  assert.equal(gate.canCommit(ticket), false);

  response.resolve("late-after-unmount");
  await apply;
  assert.equal(rendered, "initial");
});
