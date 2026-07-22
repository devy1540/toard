import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeHistorySearchQueryToken,
  encodeHistorySearchQueryToken,
} from "./history-search-token";

const SECRET = "history-search-token-test-secret";

test("history search query token round-trips without exposing plaintext", () => {
  const token = encodeHistorySearchQueryToken("  민감한\n프로젝트 이름  ", SECRET, "user-a");
  assert.equal(decodeHistorySearchQueryToken(token, SECRET, "user-a"), "민감한 프로젝트 이름");
  assert.doesNotMatch(token, /민감한|프로젝트/);
});

test("history search query token rejects tampering, another secret, and another user", () => {
  const token = encodeHistorySearchQueryToken("private query", SECRET, "user-a");
  assert.equal(decodeHistorySearchQueryToken(`${token}x`, SECRET, "user-a"), null);
  assert.equal(decodeHistorySearchQueryToken(token, "another-secret", "user-a"), null);
  assert.equal(decodeHistorySearchQueryToken(token, SECRET, "user-b"), null);
  assert.equal(decodeHistorySearchQueryToken(undefined, SECRET, "user-a"), null);
});
