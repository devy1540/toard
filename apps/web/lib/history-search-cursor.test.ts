import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeHistorySearchCursor,
  encodeHistorySearchCursor,
  type HistorySearchCursorState,
} from "./history-search-cursor";

const SECRET = "history-search-test-secret";
const SCOPE = "scope-1";
const STATE: HistorySearchCursorState = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-08-01T00:00:00.000Z"),
  afterGroup: {
    latestTs: new Date("2026-07-22T01:02:03.456Z"),
    key: "session-1",
  },
  resume: {
    group: {
      latestTs: new Date("2026-07-21T01:02:03.456Z"),
      key: "session-2",
    },
    afterRecordId: "42",
  },
};

test("history search cursor round-trips snapshot and resume state only in the same scope", () => {
  const cursor = encodeHistorySearchCursor(STATE, SCOPE, SECRET);
  assert.deepEqual(decodeHistorySearchCursor(cursor, SCOPE, SECRET), STATE);
  assert.equal(decodeHistorySearchCursor(cursor, "other-scope", SECRET), null);
});

test("history search cursor rejects tampering and malformed payloads", () => {
  const cursor = encodeHistorySearchCursor(STATE, SCOPE, SECRET);
  assert.equal(decodeHistorySearchCursor(`${cursor}x`, SCOPE, SECRET), null);
  assert.equal(decodeHistorySearchCursor("not-a-cursor", SCOPE, SECRET), null);
  assert.equal(decodeHistorySearchCursor(undefined, SCOPE, SECRET), null);
});

test("history search cursor encoder and decoder share the same long-key contract", () => {
  const longKeyState: HistorySearchCursorState = {
    ...STATE,
    afterGroup: { latestTs: STATE.afterGroup!.latestTs, key: "s".repeat(256) },
    resume: null,
  };
  const cursor = encodeHistorySearchCursor(longKeyState, SCOPE, SECRET);
  assert.deepEqual(decodeHistorySearchCursor(cursor, SCOPE, SECRET), longKeyState);
});
