import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES,
  MigrationContractError,
  migrationContractErrorCode,
  parseE2eeManagedCommit,
  parseE2eeManagedLimit,
  parseE2eeManagedState,
} from "./e2ee-to-managed-contract";

const DIGEST = Buffer.alloc(32, 7).toString("base64url");
const ITEM = { id: "1", sourceDigest: DIGEST, text: "private prompt" };

test("commit parser는 exact JSON shape, 1~25건, 중복 없는 canonical id/digest를 요구한다", () => {
  assert.deepEqual(parseE2eeManagedCommit({ items: [ITEM] }), [ITEM]);
  assert.throws(() => parseE2eeManagedCommit({ items: [] }), /1~25/);
  assert.throws(() => parseE2eeManagedCommit({ items: Array(26).fill(ITEM) }), /1~25/);
  assert.throws(() => parseE2eeManagedCommit({ items: [ITEM, ITEM] }), /DUPLICATE_ID/);
  for (const id of ["0", "01", "+1", "1.0", 1, " 1", "9223372036854775808"]) {
    assert.throws(() => parseE2eeManagedCommit({ items: [{ ...ITEM, id }] }), MigrationContractError);
  }
  for (const sourceDigest of [DIGEST + "=", DIGEST.slice(1), Buffer.alloc(31).toString("base64url")]) {
    assert.throws(() => parseE2eeManagedCommit({ items: [{ ...ITEM, sourceDigest }] }), MigrationContractError);
  }
  assert.throws(() => parseE2eeManagedCommit({ items: [ITEM], extra: true }), MigrationContractError);
  for (const extra of [Symbol("secret"), "hidden"] as const) {
    const raw = { items: [ITEM] } as Record<PropertyKey, unknown>;
    Object.defineProperty(raw, extra, { value: "secret", enumerable: false });
    assert.throws(() => parseE2eeManagedCommit(raw), /INVALID_MIGRATION_BATCH/);
  }
  const hiddenItem = { ...ITEM };
  Object.defineProperty(hiddenItem, "text", { value: ITEM.text, enumerable: false });
  assert.throws(() => parseE2eeManagedCommit({ items: [hiddenItem] }), /INVALID_MIGRATION_BATCH/);
  assert.throws(() => parseE2eeManagedCommit(Object.assign(Object.create({ polluted: true }), { items: [ITEM] })), MigrationContractError);
});

test("unbranded prototype forgery와 Proxy error는 allowlisted code여도 generic이다", () => {
  const forged = Object.assign(Object.create(MigrationContractError.prototype), { code: "INVALID_MIGRATION_TEXT" });
  const proxy = new Proxy(forged, {});
  assert.equal(migrationContractErrorCode(forged), null);
  assert.equal(migrationContractErrorCode(proxy), null);
});

test("text는 비어 있지 않은 1MiB 이하 well-formed UTF-8 문자열이고 오류에 평문을 싣지 않는다", () => {
  assert.equal(parseE2eeManagedCommit({ items: [{ ...ITEM, text: "가".repeat(349_525) }] })[0]?.text.length, 349_525);
  for (const text of ["", "a".repeat(1_048_577), "\ud800", "sensitive-secret"]) {
    try {
      const raw = text === "sensitive-secret"
        ? { items: [{ ...ITEM, text }], unexpected: text }
        : { items: [{ ...ITEM, text }] };
      if (text === "sensitive-secret") Object.defineProperty(raw.items[0]!, "text", { get() { throw new Error(text); }, enumerable: true });
      parseE2eeManagedCommit(raw);
      assert.fail("expected parser failure");
    } catch (error) {
      assert.equal(String(error).includes(text || "private prompt"), false);
    }
  }
  const proxy = new Proxy({}, { ownKeys() { throw new Error("private prompt"); } });
  assert.throws(() => parseE2eeManagedCommit(proxy), /INVALID_MIGRATION_BATCH/);
  const brandedProxy = new Proxy({}, { ownKeys() { throw new MigrationContractError("private prompt"); } });
  assert.throws(() => parseE2eeManagedCommit(brandedProxy), /INVALID_MIGRATION_BATCH/);
});

test("limit/state parser도 canonical bounded 입력만 받는다", () => {
  assert.equal(parseE2eeManagedLimit(null), 25);
  assert.equal(parseE2eeManagedLimit("99"), 25);
  assert.equal(parseE2eeManagedLimit("1"), 1);
  assert.equal(parseE2eeManagedLimit("0"), 1);
  assert.equal(parseE2eeManagedLimit("-7"), 1);
  for (const value of ["1.5", "NaN", " 2", "02"]) assert.throws(() => parseE2eeManagedLimit(value));
  assert.deepEqual(parseE2eeManagedState({ action: "block", confirmation: "KEY_UNAVAILABLE" }), { action: "block", confirmation: "KEY_UNAVAILABLE" });
  assert.deepEqual(parseE2eeManagedState({ action: "resume" }), { action: "resume" });
  assert.throws(() => parseE2eeManagedState({ action: "block", confirmation: "wrong" }), /BLOCK_CONFIRMATION_REQUIRED/);
  assert.equal(E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES, 4_194_304);
});
