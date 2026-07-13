import type { InstallPlatform } from "@/lib/onboarding-install";

export type OnboardingStep =
  | "intro"
  | "platform"
  | "install"
  | "verifying"
  | "success"
  | "stalled";

export type OnboardingState = {
  step: OnboardingStep;
  platform: InstallPlatform | null;
  token: string | null;
  tokenId: string | null;
  lastHost: string | null;
};

export type OnboardingAction =
  | { type: "start" }
  | { type: "select-platform"; platform: InstallPlatform }
  | { type: "continue" }
  | { type: "issued"; token: string; tokenId: string }
  | { type: "verify" }
  | { type: "connected"; lastHost: string | null }
  | { type: "timeout" }
  | { type: "retry" }
  | { type: "reset" };

export const initialOnboardingState: OnboardingState = {
  step: "intro",
  platform: null,
  token: null,
  tokenId: null,
  lastHost: null,
};

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case "start":
      return { ...state, step: "platform" };
    case "select-platform":
      return { ...state, platform: action.platform };
    case "continue":
      return state.platform ? state : { ...state, step: "platform" };
    case "issued":
      return {
        ...state,
        step: "install",
        token: action.token,
        tokenId: action.tokenId,
      };
    case "verify":
      return state.tokenId ? { ...state, step: "verifying" } : state;
    case "connected":
      return { ...state, step: "success", lastHost: action.lastHost };
    case "timeout":
      return { ...state, step: "stalled" };
    case "retry":
      return { ...state, step: "install" };
    case "reset":
      return initialOnboardingState;
  }
}
