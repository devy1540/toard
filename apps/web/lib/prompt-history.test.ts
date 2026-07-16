import assert from "node:assert/strict";
import { test } from "node:test";
import { encryptContent } from "./legacy-content-crypto";
import { encryptManagedContent } from "./managed-content-crypto";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import type { PromptRecordWire } from "./prompt-wire";
import {
  getMyHistorySession,
  getMyHistorySessions,
  type HistoryDependencies,
  toHistoryPreview,
} from "./prompt-history";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "018f47d0-4d47-7b04-950b-7d18a86e1b43";
const UCK = Buffer.alloc(32, 7);
const LEGACY_KEK = Buffer.alloc(32, 11);
const FILTER = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-08-01T00:00:00.000Z"),
};

type HistoryDbRow = Record<string, unknown>;

type RecordingHistoryDb = {
  calls: Array<{ sql: string; params: unknown[] }>;
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: HistoryDbRow[]; rowCount: number }>;
};

function prompt(
  overrides: Partial<PromptRecordWire> = {},
): PromptRecordWire {
  return {
    dedupKey: "managed-user-1",
    sessionId: "session-1",
    providerKey: "codex",
    turnRole: "user",
    ts: new Date("2026-07-17T03:04:05.678Z"),
    text: "managed secret",
    ...overrides,
  };
}

function managedRow(
  record: PromptRecordWire,
  keyVersion: number,
  key = UCK,
): HistoryDbRow {
  const encrypted = encryptManagedContent(
    record,
    key,
    INSTALLATION_ID,
    USER_ID,
    keyVersion,
  );
  return {
    dedup_key: record.dedupKey,
    session_id: record.sessionId,
    provider_key: record.providerKey,
    turn_role: record.turnRole,
    ts: record.ts,
    encryption_scheme: encrypted.encryptionScheme,
    content_key_version: encrypted.contentKeyVersion,
    aad_version: encrypted.aadVersion,
    key_version: encrypted.contentKeyVersion,
    wrapped_dek: encrypted.wrappedDek,
    dek_wrap_iv: encrypted.dekWrapIv,
    dek_wrap_auth_tag: encrypted.dekWrapAuthTag,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    auth_tag: encrypted.authTag,
    // DB/body에서 들어온 식별자가 trusted 함수 인자를 덮으면 안 된다.
    user_id: OTHER_USER_ID,
    installation_id: "poisoned-installation",
  };
}

function legacyRow(record: PromptRecordWire): HistoryDbRow {
  const encrypted = encryptContent(record.text, LEGACY_KEK);
  return {
    dedup_key: record.dedupKey,
    session_id: record.sessionId,
    provider_key: record.providerKey,
    turn_role: record.turnRole,
    ts: record.ts,
    encryption_scheme: "server_v1",
    content_key_version: null,
    aad_version: null,
    key_version: encrypted.keyVersion,
    wrapped_dek: encrypted.wrappedDek,
    dek_wrap_iv: null,
    dek_wrap_auth_tag: null,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    auth_tag: encrypted.authTag,
  };
}

function runtime(options: {
  failVersions?: ReadonlySet<number>;
  requestedVersions?: number[];
  calls?: { count: number };
} = {}): ManagedContentRuntime {
  return {
    installationId: INSTALLATION_ID,
    registry: {} as ManagedContentRuntime["registry"],
    health: {} as ManagedContentRuntime["health"],
    userKeys: {
      async withActiveUserKey() {
        throw new Error("UNUSED");
      },
      async withUserKeyVersion(userId, keyVersion, fn) {
        options.calls && (options.calls.count += 1);
        options.requestedVersions?.push(keyVersion);
        assert.equal(userId, USER_ID);
        if (options.failVersions?.has(keyVersion)) {
          throw new Error(`KMS leaked detail for ${keyVersion}`);
        }
        const key = Buffer.from(UCK);
        try {
          return await fn(key);
        } finally {
          key.fill(0);
        }
      },
    },
  };
}

function historyDb(input: {
  ownerId?: string;
  groups?: HistoryDbRow[];
  previews?: HistoryDbRow[];
  details?: HistoryDbRow[];
}): RecordingHistoryDb {
  const calls: RecordingHistoryDb["calls"] = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (params[0] !== (input.ownerId ?? USER_ID)) {
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT DISTINCT ON/.test(sql)) {
        return { rows: input.previews ?? [], rowCount: input.previews?.length ?? 0 };
      }
      if (/GROUP BY gkey/.test(sql)) {
        return { rows: input.groups ?? [], rowCount: input.groups?.length ?? 0 };
      }
      return { rows: input.details ?? [], rowCount: input.details?.length ?? 0 };
    },
  };
}

function deps(
  db: RecordingHistoryDb,
  options: {
    managedRuntime?: ManagedContentRuntime | null;
    legacyKek?: Buffer | null;
  } = {},
): HistoryDependencies {
  return {
    db,
    runtime: options.managedRuntime === undefined ? runtime() : options.managedRuntime,
    legacyKek: options.legacyKek === undefined ? LEGACY_KEK : options.legacyKek,
  };
}

test("toHistoryPreview extracts the request after generated attachment metadata", () => {
  const text = `# Files mentioned by the user:

## codex-clipboard-6f8ff59c.png: /var/folders/demo/codex-clipboard-6f8ff59c.png

## My request for Codex:
내 히스토리쪽이 지금 보기도 어렵고 개선이 필요할꺼같아.
<image name="capture" path="/tmp/capture.png">ignored</image>`;

  assert.equal(toHistoryPreview(text), "내 히스토리쪽이 지금 보기도 어렵고 개선이 필요할꺼같아.");
});

test("toHistoryPreview removes attachment-only preambles", () => {
  const text = `# File mentioned by the user:

## codex-clipboard-da9e61ae.png: /var/folders/demo/codex-clipboard-da9e61ae.png`;

  assert.equal(toHistoryPreview(text), "");
});

test("toHistoryPreview keeps normal prompts compact", () => {
  assert.equal(toHistoryPreview("정리하면 신규 파이프라인을 이용해서 진행할까?\n\n1번 작업은 어떻게 할까?"), "정리하면 신규 파이프라인을 이용해서 진행할까? 1번 작업은 어떻게 할까?");
});

test("history decrypts mixed managed rows with each content key version and isolates one failed turn", async () => {
  const requestedVersions: number[] = [];
  const calls = { count: 0 };
  const first = prompt();
  const failed = prompt({
    dedupKey: "managed-assistant-failed",
    turnRole: "assistant",
    ts: new Date("2026-07-17T03:04:06.678Z"),
    text: "must not leak from failure",
  });
  const legacy = prompt({
    dedupKey: "legacy-assistant",
    turnRole: "assistant",
    ts: new Date("2026-07-17T03:04:07.678Z"),
    text: "legacy secret",
  });
  const db = historyDb({
    details: [
      managedRow(first, 1),
      managedRow(failed, 2),
      legacyRow(legacy),
    ],
  });

  const result = await getMyHistorySession(USER_ID, "session-1", deps(db, {
    managedRuntime: runtime({
      requestedVersions,
      calls,
      failVersions: new Set([2]),
    }),
  }));

  assert.equal(result.enabled, true);
  assert.equal(result.session?.turns[0]?.text, "managed secret");
  assert.equal(result.session?.turns[0]?.contentUnavailable, undefined);
  assert.equal(result.session?.turns[1]?.text, "");
  assert.equal(result.session?.turns[1]?.contentUnavailable, true);
  assert.equal(result.session?.turns[2]?.text, "legacy secret");
  assert.deepEqual(requestedVersions, [1, 2]);
  assert.equal(calls.count, 2);
  assert.equal(result.hasManagedContent, true);
  assert.equal(result.hasLegacyContent, true);
});

test("another user cannot select or decrypt managed rows and SQL keeps explicit user_id", async () => {
  const calls = { count: 0 };
  const db = historyDb({ details: [managedRow(prompt(), 1)] });
  const result = await getMyHistorySession(
    OTHER_USER_ID,
    "session-1",
    deps(db, { managedRuntime: runtime({ calls }) }),
  );

  assert.equal(result.session, null);
  assert.equal(calls.count, 0);
  const query = db.calls.at(-1);
  assert.ok(query);
  assert.match(query.sql, /WHERE user_id = \$1/);
  assert.equal(query.params[0], OTHER_USER_ID);
  assert.doesNotMatch(query.sql, /user_id\s*=\s*\$2/);
});

test("managed-only list decrypts one representative preview per page group", async () => {
  const requestedVersions: number[] = [];
  const record = prompt({ text: "managed list preview\nsecond line" });
  const db = historyDb({
    groups: [{
      gkey: "session-1",
      is_session: true,
      provider_key: "codex",
      turn_count: "2",
      first_ts: record.ts,
      latest_ts: record.ts,
      total_groups: "1",
      has_managed_content: true,
      has_legacy_content: false,
    }],
    previews: [{ ...managedRow(record, 3), gkey: "session-1" }],
  });

  const result = await getMyHistorySessions(
    USER_ID,
    FILTER,
    0,
    20,
    deps(db, {
      managedRuntime: runtime({ requestedVersions }),
      legacyKek: null,
    }),
  );

  assert.equal(result.enabled, true);
  assert.equal(result.sessions[0]?.preview, "managed list preview second line");
  assert.deepEqual(requestedVersions, [3]);
  assert.equal(result.hasManagedContent, true);
  assert.equal(result.hasLegacyContent, false);
  const groupQuery = db.calls.find((call) => /GROUP BY gkey/.test(call.sql));
  const previewQuery = db.calls.find((call) => /SELECT DISTINCT ON/.test(call.sql));
  assert.ok(groupQuery);
  assert.ok(previewQuery);
  assert.equal(groupQuery.params.at(-2), 20);
  assert.deepEqual(previewQuery.params.at(-1), ["session-1"]);
  assert.match(groupQuery.sql, /encryption_scheme IN \('server_v1', 'managed_v1'\)/);
  assert.match(previewQuery.sql, /encryption_scheme IN \('server_v1', 'managed_v1'\)/);
  for (const column of [
    "encryption_scheme",
    "content_key_version",
    "aad_version",
    "dek_wrap_iv",
    "dek_wrap_auth_tag",
    "dedup_key",
    "provider_key",
    "turn_role",
    "ts",
  ]) {
    assert.match(previewQuery.sql, new RegExp(`\\b${column}\\b`));
  }
});

test("malformed managed preview is isolated without failing other page groups", async () => {
  const valid = prompt({ dedupKey: "valid", sessionId: "session-valid", text: "valid preview" });
  const invalid = {
    ...managedRow(
      prompt({ dedupKey: "invalid", sessionId: "session-invalid", text: "hidden preview" }),
      1,
    ),
    gkey: "session-invalid",
    dek_wrap_auth_tag: null,
  };
  const db = historyDb({
    groups: [
      {
        gkey: "session-valid",
        is_session: true,
        provider_key: "codex",
        turn_count: "1",
        first_ts: valid.ts,
        latest_ts: valid.ts,
        total_groups: "2",
        has_managed_content: true,
        has_legacy_content: false,
      },
      {
        gkey: "session-invalid",
        is_session: true,
        provider_key: "codex",
        turn_count: "1",
        first_ts: valid.ts,
        latest_ts: valid.ts,
        total_groups: "2",
        has_managed_content: true,
        has_legacy_content: false,
      },
    ],
    previews: [
      { ...managedRow(valid, 1), gkey: "session-valid" },
      invalid,
    ],
  });

  const result = await getMyHistorySessions(USER_ID, FILTER, 0, 20, deps(db, {
    legacyKek: null,
  }));
  assert.equal(result.sessions[0]?.preview, "valid preview");
  assert.equal(result.sessions[1]?.preview, "");
});

test("history capability is enabled for managed-only or legacy-only and disabled with neither", async () => {
  const managedDb = historyDb({ details: [] });
  assert.equal(
    (await getMyHistorySession(USER_ID, "missing", deps(managedDb, {
      managedRuntime: runtime(),
      legacyKek: null,
    }))).enabled,
    true,
  );

  const legacyDb = historyDb({ details: [] });
  assert.equal(
    (await getMyHistorySession(USER_ID, "missing", deps(legacyDb, {
      managedRuntime: null,
      legacyKek: LEGACY_KEK,
    }))).enabled,
    true,
  );

  const disabledDb = historyDb({ details: [managedRow(prompt(), 1)] });
  const disabled = await getMyHistorySession(USER_ID, "session-1", deps(disabledDb, {
    managedRuntime: null,
    legacyKek: null,
  }));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.session, null);
  assert.equal(disabledDb.calls.length, 0);
});

test("legacy-only runtime decrypts server_v1 while managed-only leaves legacy turns unavailable", async () => {
  const legacyRecord = prompt({ dedupKey: "legacy-only", text: "legacy only secret" });
  const legacyOnly = await getMyHistorySession(
    USER_ID,
    "session-1",
    deps(historyDb({ details: [legacyRow(legacyRecord)] }), {
      managedRuntime: null,
      legacyKek: LEGACY_KEK,
    }),
  );
  assert.equal(legacyOnly.session?.turns[0]?.text, "legacy only secret");
  assert.equal(legacyOnly.session?.turns[0]?.contentUnavailable, undefined);

  const managedRecord = prompt({ dedupKey: "managed-only", text: "managed survives" });
  const managedOnly = await getMyHistorySession(
    USER_ID,
    "session-1",
    deps(historyDb({
      details: [
        managedRow(managedRecord, 1),
        legacyRow(legacyRecord),
      ],
    }), {
      managedRuntime: runtime(),
      legacyKek: null,
    }),
  );
  assert.equal(managedOnly.session?.turns[0]?.text, "managed survives");
  assert.equal(managedOnly.session?.turns[1]?.text, "");
  assert.equal(managedOnly.session?.turns[1]?.contentUnavailable, true);
});

test("detail query is bounded and selects managed AAD/wrapper metadata", async () => {
  const db = historyDb({ details: [] });
  await getMyHistorySession(USER_ID, "session-1", deps(db));
  const query = db.calls.at(-1);
  assert.ok(query);
  assert.equal(query.params[2], 500);
  assert.match(query.sql, /LIMIT \$3/);
  assert.match(query.sql, /encryption_scheme IN \('server_v1', 'managed_v1'\)/);
  for (const column of [
    "encryption_scheme",
    "content_key_version",
    "aad_version",
    "dek_wrap_iv",
    "dek_wrap_auth_tag",
    "dedup_key",
    "session_id",
    "provider_key",
    "turn_role",
    "ts",
  ]) {
    assert.match(query.sql, new RegExp(`\\b${column}\\b`));
  }
});
