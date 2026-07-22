import assert from "node:assert/strict";
import test from "node:test";
import { E2EE_MAX_CIPHERTEXT_BYTES } from "./e2ee-contract";
import { VALID_E2EE_RECORD } from "./e2ee-test-fixtures";
import {
  parsePromptAgentMetadataReconciliationBody,
  parsePromptBatch,
  parsePromptRecordWire,
} from "./prompt-wire";

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

test("sessionId는 검색 cursor와 동일하게 255자로 제한한다", () => {
  assert.equal(
    parsePromptRecordWire({ ...validRecord, sessionId: "s".repeat(255), text: "valid" }).sessionId?.length,
    255,
  );
  assert.throws(
    () => parsePromptRecordWire({ ...validRecord, sessionId: "s".repeat(256), text: "invalid" }),
    /sessionId.*1~255자/,
  );
});

test("schema 없는 기존 shim payload는 plaintext_v1으로 해석한다", () => {
  const batch = parsePromptBatch([{ ...validRecord, text: "secret prompt" }]);

  assert.equal(batch.schema, "plaintext_v1");
  assert.equal(batch.records.length, 1);
});

test("빈 기존 shim payload도 plaintext_v1으로 해석한다", () => {
  assert.deepEqual(parsePromptBatch([]), { schema: "plaintext_v1", records: [] });
});

test("e2ee_v1 exact parser와 혼합 batch fail-closed를 유지한다", () => {
  assert.equal(parsePromptBatch([VALID_E2EE_RECORD]).schema, "e2ee_v1");
  assert.throws(
    () => parsePromptBatch([
      VALID_E2EE_RECORD,
      { ...validRecord, text: "secret prompt" },
    ]),
    /혼합할 수 없습니다/,
  );
});

test("알 수 있는 schema가 있는 plaintext-shaped record는 fail-closed한다", () => {
  assert.throws(
    () => parsePromptBatch([
      { ...validRecord, schema: "managed_v1", text: "secret prompt" },
    ]),
    /지원하지 않는 prompt schema/,
  );
});

test("prompt agent metadata를 파싱하고 기존 payload는 root로 호환한다", () => {
  const root = parsePromptRecordWire({ ...validRecord, text: "root" });
  assert.equal(root.agent, null);

  const subagent = parsePromptRecordWire({
    ...validRecord,
    text: "subagent",
    agent: {
      id: "agent-1",
      parentId: "session-1",
      depth: 1,
      name: "Galileo",
      role: "explorer",
    },
  });
  assert.deepEqual(subagent.agent, {
    id: "agent-1",
    parentId: "session-1",
    depth: 1,
    name: "Galileo",
    role: "explorer",
  });
  assert.throws(
    () => parsePromptRecordWire({
      ...validRecord,
      text: "invalid",
      agent: { id: "agent-1", parentId: null, depth: 0, name: null, role: null },
    }),
    /agent\.depth/,
  );
});

test("agent metadata reconciliation은 본문 없이 정확한 SHA 키와 지원 provider만 받는다", () => {
  const record = {
    dedupKey: "a".repeat(64),
    providerKey: "codex",
    agent: {
      id: "agent-1",
      parentId: "root-1",
      depth: 1,
      name: "Reviewer",
      role: "reviewer",
    },
  };
  assert.deepEqual(
    parsePromptAgentMetadataReconciliationBody({ records: [record] }),
    [record],
  );
  assert.throws(
    () => parsePromptAgentMetadataReconciliationBody({ records: [{ ...record, dedupKey: "short" }] }),
    /SHA-256/,
  );
  assert.throws(
    () => parsePromptAgentMetadataReconciliationBody({ records: [{ ...record, providerKey: "gemini" }] }),
    /providerKey/,
  );
  assert.throws(
    () => parsePromptAgentMetadataReconciliationBody({ records: [{ ...record, agent: null }] }),
    /agent가 필요/,
  );
  assert.throws(
    () => parsePromptAgentMetadataReconciliationBody({
      records: Array.from({ length: 1_001 }, () => record),
    }),
    /최대 1000개/,
  );
});
