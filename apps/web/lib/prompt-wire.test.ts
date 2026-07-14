import assert from "node:assert/strict";
import test from "node:test";
import { E2EE_MAX_CIPHERTEXT_BYTES } from "./e2ee-contract";
import { parsePromptRecordWire } from "./prompt-wire";

const validRecord = {
  dedupKey: "legacy-1",
  sessionId: "session-1",
  providerKey: "codex",
  turnRole: "user",
  ts: "2026-07-14T00:00:00.000Z",
};

test("legacy prompt text는 E2EE ciphertext와 같은 byte 상한을 사용한다", () => {
  assert.equal(
    parsePromptRecordWire({ ...validRecord, text: "x".repeat(E2EE_MAX_CIPHERTEXT_BYTES) }).text.length,
    E2EE_MAX_CIPHERTEXT_BYTES,
  );
  assert.throws(
    () => parsePromptRecordWire({ ...validRecord, text: "x".repeat(E2EE_MAX_CIPHERTEXT_BYTES + 1) }),
    /text.*byte/i,
  );
});
