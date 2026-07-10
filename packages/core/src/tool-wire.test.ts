import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolActivityBody, parseToolInventoryBody, ToolWireParseError } from "./tool-wire";

const validActivity = {
  dedupKey: "a".repeat(64),
  providerKey: "codex",
  sessionId: "session-1",
  host: "macbook.local",
  ts: "2026-07-10T00:00:00Z",
  activityKind: "skill",
  itemKey: "brainstorming",
  displayName: "brainstorming",
  pluginKey: "superpowers",
  outcome: "unknown",
  detection: "derived_load",
};

const validItem = {
  kind: "skill",
  itemKey: "brainstorming",
  displayName: "brainstorming",
  sourceProvider: "codex",
  pluginKey: "superpowers",
  version: "6.1.1",
  enabled: true,
};

const validInventory = {
  host: "macbook.local",
  fingerprint: "b".repeat(64),
  observedAt: "2026-07-10T00:00:00Z",
  items: [validItem],
};

test("도구 활동은 안전한 메타데이터만 파싱한다", () => {
  const [event] = parseToolActivityBody([validActivity]);
  assert.equal(event?.activityKind, "skill");
  assert.equal(event?.detection, "derived_load");
  assert.equal(event?.ts.toISOString(), "2026-07-10T00:00:00.000Z");
});

test("도구 활동은 호출 인자와 출력을 거부한다", () => {
  assert.throws(
    () => parseToolActivityBody([{ ...validActivity, arguments: "secret" }]),
    (error) => error instanceof ToolWireParseError && /허용되지 않은 필드: arguments/.test(error.message),
  );
  assert.throws(
    () => parseToolActivityBody([{ ...validActivity, output: "secret" }]),
    (error) => error instanceof ToolWireParseError && /허용되지 않은 필드: output/.test(error.message),
  );
});

test("도구 활동은 enum, 이름 길이, 배치 상한을 검증한다", () => {
  assert.throws(() => parseToolActivityBody([{ ...validActivity, activityKind: "builtin" }]), /activityKind/);
  assert.throws(() => parseToolActivityBody([{ ...validActivity, itemKey: "x".repeat(201) }]), /itemKey/);
  assert.throws(() => parseToolActivityBody(Array.from({ length: 501 }, () => validActivity)), /최대 500/);
});

test("인벤토리는 안전한 현재 상태만 파싱한다", () => {
  const inventory = parseToolInventoryBody(validInventory);
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0]?.kind, "skill");
  assert.equal(inventory.observedAt.toISOString(), "2026-07-10T00:00:00.000Z");
});

test("인벤토리는 endpoint와 로컬 경로를 거부한다", () => {
  assert.throws(
    () => parseToolInventoryBody({ ...validInventory, items: [{ ...validItem, endpoint: "https://internal" }] }),
    /허용되지 않은 필드: endpoint/,
  );
  assert.throws(
    () => parseToolInventoryBody({ ...validInventory, items: [{ ...validItem, path: "/Users/me/.codex" }] }),
    /허용되지 않은 필드: path/,
  );
});

test("인벤토리는 fingerprint와 항목 상한을 검증한다", () => {
  assert.throws(() => parseToolInventoryBody({ ...validInventory, fingerprint: "bad" }), /fingerprint/);
  assert.throws(
    () => parseToolInventoryBody({ ...validInventory, items: Array.from({ length: 2001 }, () => validItem) }),
    /최대 2000/,
  );
});
