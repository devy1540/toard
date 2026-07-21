import assert from "node:assert/strict";
import test from "node:test";
import { fromBase64Url } from "./e2ee-contract";
import { VALID_E2EE_RECORD, createRecordingDb } from "./e2ee-test-fixtures";
import { decryptManagedContent } from "./managed-content-crypto";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import type { PromptRecordWire } from "./prompt-wire";
import { saveE2eePromptRecords, saveManagedPromptRecords } from "./prompt-records";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const UCK = Buffer.alloc(32, 7);
const PROMPT: PromptRecordWire = {
  dedupKey: "managed-record-1",
  sessionId: "session-1",
  providerKey: "codex",
  turnRole: "user",
  ts: new Date("2026-07-17T03:04:05.678Z"),
  text: "secret prompt",
};

type RecordingPromptDb = {
  calls: Array<{ sql: string; params: unknown[] }>;
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
};

function createManagedDb(rowCounts: number[] = [1]): RecordingPromptDb {
  const calls: RecordingPromptDb["calls"] = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [], rowCount: rowCounts.shift() ?? 0 };
    },
  };
}

function createManagedRuntime(
  options: {
    failWith?: Error;
    onKey?: (userId: string) => void;
    beforeCallback?: Promise<void>;
  } = {},
): ManagedContentRuntime {
  return {
    installationId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
    registry: {} as ManagedContentRuntime["registry"],
    health: {} as ManagedContentRuntime["health"],
    userKeys: {
      async withActiveUserKey(userId, fn) {
        options.onKey?.(userId);
        if (options.failWith) throw options.failWith;
        await options.beforeCallback;
        const key = Buffer.from(UCK);
        try {
          return await fn(key, 3);
        } finally {
          key.fill(0);
        }
      },
      async withUserKeyVersion() {
        throw new Error("UNUSED");
      },
    },
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("plaintext records are encrypted as managed_v1 before INSERT", async () => {
  const db = createManagedDb();
  const result = await saveManagedPromptRecords(
    USER_ID,
    [PROMPT],
    createManagedRuntime(),
    db,
  );
  assert.deepEqual(result, { inserted: 1, deduped: 0 });
  const insert = db.calls.find((call) => /INSERT INTO prompt_records/.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /'managed_v1'/);
  assert.match(insert.sql, /content_owner_id/);
  assert.match(insert.sql, /aad_version/);
  assert.equal(insert.params.includes(PROMPT.text), false);
  assert.equal(
    insert.params.some(
      (value) =>
        Buffer.isBuffer(value)
        && value.includes(Buffer.from(PROMPT.text, "utf8")),
    ),
    false,
  );
  assert.equal(insert.params[1], USER_ID);
  assert.equal(insert.params[11], 3);
  assert.equal(insert.params[16], null);
  assert.equal(insert.params[17], 3);
  assert.equal(insert.params[20], 2);
});

test("managed records preserve subagent identity columns", async () => {
  const db = createManagedDb();
  await saveManagedPromptRecords(
    USER_ID,
    [{
      ...PROMPT,
      agent: {
        id: "agent-reviewer",
        parentId: "session-1",
        depth: 2,
        name: "Reviewer",
        role: "reviewer",
      },
    }],
    createManagedRuntime(),
    db,
  );

  const insert = db.calls.find((call) => /INSERT INTO prompt_records/.test(call.sql));
  assert.ok(insert);
  assert.deepEqual(insert.params.slice(6, 11), [
    "agent-reviewer",
    "session-1",
    2,
    "Reviewer",
    "reviewer",
  ]);
});

test("managed 저장은 trusted userId와 암호화한 canonical metadata만 사용한다", async () => {
  const db = createManagedDb();
  const poisoned = {
    ...PROMPT,
    userId: OTHER_USER_ID,
    dedupKey: "managed-record-poisoned",
  } as PromptRecordWire & { userId: string };
  let requestedUserId = "";
  await saveManagedPromptRecords(
    USER_ID,
    [poisoned],
    createManagedRuntime({ onKey: (userId) => {
      requestedUserId = userId;
    } }),
    db,
  );
  const insert = db.calls.find((call) => /INSERT INTO prompt_records/.test(call.sql));
  assert.ok(insert);
  assert.equal(requestedUserId, USER_ID);
  assert.equal(insert.params[0], poisoned.dedupKey);
  assert.equal(insert.params[1], USER_ID);
  assert.equal(insert.params[2], poisoned.sessionId);
  assert.equal(insert.params[3], poisoned.providerKey);
  assert.equal(insert.params[4], poisoned.turnRole);
  assert.deepEqual(insert.params[5], poisoned.ts);
  assert.notEqual(insert.params[5], poisoned.ts);
  assert.equal(insert.params.includes(OTHER_USER_ID), false);
});

test("managed 저장은 첫 await 전 snapshot으로 원본 object와 Date 변이를 격리한다", async () => {
  const db = createManagedDb();
  const callbackEntered = deferred();
  const callbackRelease = deferred();
  const initialTs = new Date("2026-07-17T05:06:07.890Z");
  const initial = {
    dedupKey: "snapshot-dedup",
    sessionId: "snapshot-session",
    providerKey: "codex",
    turnRole: "user" as const,
    ts: initialTs,
    text: "snapshot secret",
  };
  const original: PromptRecordWire = { ...initial };
  const saving = saveManagedPromptRecords(
    USER_ID,
    [original],
    createManagedRuntime({
      onKey: () => callbackEntered.resolve(),
      beforeCallback: callbackRelease.promise,
    }),
    db,
  );

  await callbackEntered.promise;
  original.dedupKey = "mutated-dedup";
  original.sessionId = "mutated-session";
  original.providerKey = "mutated-provider";
  original.turnRole = "assistant";
  original.text = "mutated plaintext";
  original.ts.setTime(new Date("2030-01-02T03:04:05.678Z").getTime());
  callbackRelease.resolve();
  await saving;

  const insert = db.calls.find((call) => /INSERT INTO prompt_records/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params[0], initial.dedupKey);
  assert.equal(insert.params[2], initial.sessionId);
  assert.equal(insert.params[3], initial.providerKey);
  assert.equal(insert.params[4], initial.turnRole);
  assert.deepEqual(insert.params[5], new Date("2026-07-17T05:06:07.890Z"));
  assert.equal(insert.params.includes(original.text), false);

  const plaintext = decryptManagedContent(
    {
      dedupKey: initial.dedupKey,
      providerKey: initial.providerKey,
      turnRole: initial.turnRole,
      ts: new Date("2026-07-17T05:06:07.890Z"),
      encryptionScheme: "managed_v1",
      contentKeyVersion: insert.params[17] as number,
      aadVersion: 2,
      wrappedDek: insert.params[12] as Buffer,
      iv: insert.params[13] as Buffer,
      ciphertext: insert.params[14] as Buffer,
      authTag: insert.params[15] as Buffer,
      dekWrapIv: insert.params[18] as Buffer,
      dekWrapAuthTag: insert.params[19] as Buffer,
    },
    UCK,
    "018f47d0-4d47-7b04-950b-7d18a86e1b43",
    USER_ID,
  );
  assert.equal(plaintext, initial.text);
});

test("managed snapshot은 invalid Date를 KMS와 DB 전에 비민감 오류로 거부한다", async () => {
  const db = createManagedDb();
  let keyCalls = 0;
  const invalid = {
    ...PROMPT,
    ts: new Date("invalid"),
    text: "plaintext must not enter the error",
  };
  await assert.rejects(
    saveManagedPromptRecords(
      USER_ID,
      [invalid],
      createManagedRuntime({ onKey: () => {
        keyCalls += 1;
      } }),
      db,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "CONTENT_RECORD_SNAPSHOT_FAILED");
      assert.doesNotMatch(error.message, /plaintext|invalid date/i);
      return true;
    },
  );
  assert.equal(keyCalls, 0);
  assert.equal(db.calls.length, 0);
});

test("encryption failure writes no row", async () => {
  const db = createManagedDb();
  await assert.rejects(
    saveManagedPromptRecords(
      USER_ID,
      [PROMPT],
      createManagedRuntime({ failWith: new Error("KMS_UNAVAILABLE") }),
      db,
    ),
    /KMS_UNAVAILABLE/,
  );
  assert.equal(db.calls.length, 0);
});

test("managed batch는 전체 암호화 후 저장하고 dedup 수를 정확히 계산한다", async () => {
  const db = createManagedDb([1, 0]);
  const second = {
    ...PROMPT,
    dedupKey: "managed-record-2",
    turnRole: "assistant" as const,
    text: "second secret",
  };
  const result = await saveManagedPromptRecords(
    USER_ID,
    [PROMPT, second],
    createManagedRuntime(),
    db,
  );
  assert.deepEqual(result, { inserted: 1, deduped: 1 });
  assert.equal(db.calls.length, 2);
});

test("managed batch의 뒤 레코드 암호화 실패도 prompt transaction을 시작하지 않는다", async () => {
  const db = createManagedDb();
  const invalidSecond = {
    ...PROMPT,
    dedupKey: "managed-record-invalid",
    text: "",
  };
  await assert.rejects(
    saveManagedPromptRecords(
      USER_ID,
      [PROMPT, invalidSecond],
      createManagedRuntime(),
      db,
    ),
    /CONTENT_ENCRYPT_FAILED/,
  );
  assert.equal(db.calls.length, 0);
});

test("empty managed batch는 user key와 DB를 사용하지 않는다", async () => {
  const db = createManagedDb();
  let keyCalls = 0;
  const result = await saveManagedPromptRecords(
    USER_ID,
    [],
    createManagedRuntime({ onKey: () => {
      keyCalls += 1;
    } }),
    db,
  );
  assert.deepEqual(result, { inserted: 0, deduped: 0 });
  assert.equal(keyCalls, 0);
  assert.equal(db.calls.length, 0);
});

test("e2ee records are inserted byte-for-byte without server plaintext or KEK", async () => {
  const db = createRecordingDb({ contentState: "active" });
  const result = await saveE2eePromptRecords("user-1", [VALID_E2EE_RECORD], db);
  assert.deepEqual(result, { inserted: 1, deduped: 0 });
  const insert = db.calls.find((call) => /INSERT INTO prompt_records/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.sql.includes("secret prompt"), false);
  assert.equal(insert.params.includes("secret prompt"), false);
  assert.deepEqual(
    insert.params.find((value) => Buffer.isBuffer(value) && value.length === 24),
    fromBase64Url(VALID_E2EE_RECORD.ciphertext, "ciphertext"),
  );
});

test("e2ee records preserve subagent identity columns", async () => {
  const db = createRecordingDb({ contentState: "active" });
  await saveE2eePromptRecords(
    "user-1",
    [{
      ...VALID_E2EE_RECORD,
      agent: {
        id: "agent-cursor-1",
        parentId: VALID_E2EE_RECORD.sessionId,
        depth: 1,
        name: null,
        role: null,
      },
    }],
    db,
  );

  const insert = db.calls.find((call) => /INSERT INTO prompt_records/.test(call.sql));
  assert.ok(insert);
  assert.deepEqual(insert.params.slice(6, 11), [
    "agent-cursor-1",
    VALID_E2EE_RECORD.sessionId,
    1,
    null,
    null,
  ]);
});

test("e2ee owner는 active 또는 migrated이고 ingest-token user에 속해야 한다", async () => {
  const mismatch = createRecordingDb({ ownerUserId: "user-a", contentState: "active" });
  await assert.rejects(
    saveE2eePromptRecords("user-b", [VALID_E2EE_RECORD], mismatch),
    /CONTENT_OWNER_MISMATCH/,
  );
  const pending = createRecordingDb({ contentState: "pending" });
  await assert.rejects(
    saveE2eePromptRecords("user-1", [VALID_E2EE_RECORD], pending),
    /CONTENT_ACCOUNT_INACTIVE/,
  );
  const migrated = createRecordingDb({ contentState: "migrated" as never });
  assert.deepEqual(
    await saveE2eePromptRecords("user-1", [VALID_E2EE_RECORD], migrated),
    { inserted: 1, deduped: 0 },
  );
});
