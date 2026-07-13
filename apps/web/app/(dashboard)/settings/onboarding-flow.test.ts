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
