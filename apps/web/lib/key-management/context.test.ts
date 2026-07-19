import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalKeyContext,
  decodeUserKeyPayload,
  encodeUserKeyPayload,
} from "./context";
import type { KeyContext } from "./types";

const CONTEXT: KeyContext = {
  installationId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
  userId: "01900000-0000-7000-8000-000000000001",
  keyVersion: 1,
  purpose: "prompt-history",
};

test("context payload는 정해진 필드 순서와 정확히 68바이트를 사용한다", () => {
  const uck = Buffer.alloc(32, 7);
  const canonical = Buffer.from(
    '{"installationId":"018f47d0-4d47-7b04-950b-7d18a86e1b43","userId":"01900000-0000-7000-8000-000000000001","keyVersion":1,"purpose":"prompt-history"}',
    "utf8",
  );

  assert.deepEqual(canonicalKeyContext(CONTEXT), canonical);
  const payload = encodeUserKeyPayload(uck, CONTEXT);
  assert.equal(payload.length, 68);
  assert.deepEqual(payload.subarray(0, 4), Buffer.from("TUK1"));
  assert.deepEqual(
    payload.subarray(4, 36),
    createHash("sha256").update(canonical).digest(),
  );
  assert.deepEqual(payload.subarray(36), uck);
  assert.deepEqual(decodeUserKeyPayload(payload, CONTEXT), uck);
});

test("context payload는 다른 사용자와 설치에서 열리지 않는다", () => {
  const payload = encodeUserKeyPayload(Buffer.alloc(32, 7), CONTEXT);

  assert.throws(
    () => decodeUserKeyPayload(payload, { ...CONTEXT, userId: "another-user" }),
    /USER_KEY_CONTEXT_MISMATCH/,
  );
  assert.throws(
    () => decodeUserKeyPayload(payload, { ...CONTEXT, installationId: "another-installation" }),
    /USER_KEY_CONTEXT_MISMATCH/,
  );
});

test("context payload는 잘못된 UCK, magic, 길이를 거부한다", () => {
  assert.throws(
    () => encodeUserKeyPayload(Buffer.alloc(31), CONTEXT),
    /USER_KEY_LENGTH_INVALID/,
  );
  assert.throws(
    () => decodeUserKeyPayload(Buffer.alloc(68), CONTEXT),
    /USER_KEY_PAYLOAD_INVALID/,
  );
  assert.throws(
    () => decodeUserKeyPayload(Buffer.from("TUK1"), CONTEXT),
    /USER_KEY_PAYLOAD_INVALID/,
  );
});
