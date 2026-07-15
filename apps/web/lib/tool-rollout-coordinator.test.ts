import assert from "node:assert/strict";
import test from "node:test";
import { runToolRolloutCoordinator, type OpenToolRollout, type ToolRolloutRepository } from "./tool-rollout-coordinator";

function rollout(overrides: Partial<OpenToolRollout> = {}): OpenToolRollout {
  return {
    id: "rollout-1", phase: "canary", eligible: 10, attempted: 1, failed: 0,
    phaseStartedAt: new Date("2026-07-15T00:00:00Z"), ...overrides,
  };
}

function fake(input: { lease?: boolean; rollouts?: OpenToolRollout[] } = {}) {
  const updates: unknown[] = [];
  const repository: ToolRolloutRepository = {
    async tryLease() { return input.lease ?? true; },
    async releaseLease() { updates.push({ action: "release" }); },
    async listOpenRollouts() { return input.rollouts ?? []; },
    async advance(id, phase, percent) { updates.push({ id, phase, percent }); },
    async rollbackToLastKnownGood(id, _now, reason) { updates.push({ id, phase: "rollback", target: "last-known-good", percent: 100, reason }); },
  };
  return { repository, updates };
}

test("coordinator는 advisory lease 보유자만 phase를 전진한다", async () => {
  const state = fake({ lease: false, rollouts: [rollout()] });
  await runToolRolloutCoordinator(state.repository, new Date("2026-07-15T00:31:00Z"));
  assert.deepEqual(state.updates, []);
});

test("preflight는 canary로 시작하고 canary 성공은 50퍼센트로 확대한다", async () => {
  const state = fake({ rollouts: [rollout({ id: "preflight", phase: "preflight" }), rollout()] });
  await runToolRolloutCoordinator(state.repository, new Date("2026-07-15T00:31:00Z"));
  assert.deepEqual(state.updates.slice(0, 2), [
    { id: "preflight", phase: "canary", percent: 10 },
    { id: "rollout-1", phase: "expand", percent: 50 },
  ]);
});

test("실패 임계값은 last-known-good rollback으로 원자 전환한다", async () => {
  const state = fake({ rollouts: [rollout({ attempted: 2, failed: 2 })] });
  await runToolRolloutCoordinator(state.repository, new Date("2026-07-15T00:05:00Z"));
  assert.deepEqual(state.updates[0], {
    id: "rollout-1", phase: "rollback", target: "last-known-good", percent: 100, reason: "failure_threshold",
  });
});
