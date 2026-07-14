export type E2eeHistoryKind =
  | "loading"
  | "locked"
  | "approvalPending"
  | "unlocked"
  | "recordUnavailable"
  | "fatal";

export type E2eeHistoryState = {
  kind: E2eeHistoryKind;
  approval: { requestId: string; code: string } | null;
  unavailable: Set<string>;
  error: string | null;
};

export type E2eeHistoryAction =
  | { type: "status"; hasLocalKey: boolean; hasPasskeyWrapper: boolean }
  | { type: "approval-created"; requestId: string; code: string }
  | { type: "uck-unwrapped" }
  | { type: "record-failed"; dedupKey: string }
  | { type: "lock" }
  | { type: "fatal"; error: string };

export const initialE2eeHistoryState: E2eeHistoryState = {
  kind: "loading",
  approval: null,
  unavailable: new Set(),
  error: null,
};

export function reduceE2eeHistory(
  state: E2eeHistoryState,
  action: E2eeHistoryAction,
): E2eeHistoryState {
  switch (action.type) {
    case "status":
      return { ...state, kind: action.hasLocalKey ? "loading" : "locked", error: null };
    case "approval-created":
      return {
        ...state,
        kind: "approvalPending",
        approval: { requestId: action.requestId, code: action.code },
        error: null,
      };
    case "uck-unwrapped":
      return { ...state, kind: "unlocked", approval: null, error: null };
    case "record-failed": {
      const unavailable = new Set(state.unavailable);
      unavailable.add(action.dedupKey);
      return { ...state, kind: state.kind === "unlocked" ? "unlocked" : "recordUnavailable", unavailable };
    }
    case "lock":
      return { kind: "locked", approval: null, unavailable: new Set(), error: null };
    case "fatal":
      return { ...state, kind: "fatal", error: action.error };
  }
}
