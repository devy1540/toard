import assert from "node:assert/strict";
import test from "node:test";
import { initialOnboardingState, onboardingReducer } from "./onboarding-flow";

test("does not issue before platform selection", () => {
  const state = onboardingReducer(initialOnboardingState, { type: "continue" });

  assert.equal(state.step, "platform");
  assert.equal(state.token, null);
});

test("advances install through verification to success", () => {
  let state = onboardingReducer(initialOnboardingState, { type: "start" });
  state = onboardingReducer(state, { type: "select-platform", platform: "windows" });
  state = onboardingReducer(state, { type: "issued", token: "tk_test", tokenId: "token-1" });
  state = onboardingReducer(state, { type: "verify" });
  state = onboardingReducer(state, { type: "connected", lastHost: null });

  assert.equal(state.step, "success");
});

test("E2EE 선택 시 recovery 확인 전 success로 가지 않는다", () => {
  let state = onboardingReducer(initialOnboardingState, { type: "set-e2ee", enabled: true });
  state = onboardingReducer(state, { type: "start" });
  state = onboardingReducer(state, { type: "select-platform", platform: "macos" });
  state = onboardingReducer(state, { type: "issued", token: "tk_test", tokenId: "token-1" });
  state = onboardingReducer(state, { type: "verify" });
  state = onboardingReducer(state, { type: "connected", lastHost: "MacBook" });
  assert.equal(state.step, "recovery");
  state = onboardingReducer(state, { type: "recovery-confirmed" });
  assert.equal(state.step, "success");
});

test("shows recovery after polling timeout", () => {
  const state = onboardingReducer(
    {
      ...initialOnboardingState,
      step: "verifying",
      platform: "linux",
      token: "tk_test",
      tokenId: "token-1",
    },
    { type: "timeout" },
  );

  assert.equal(state.step, "stalled");
});
