import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { encryptManagedContent } from "../apps/web/lib/managed-content-crypto";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { searchMyHistorySessions } from "../apps/web/lib/prompt-history";
import type { PromptRecordWire } from "../apps/web/lib/prompt-wire";

const execFileAsync = promisify(execFile);
const INSTALLATION_ID = "018f47d0-4d47-7b04-950b-7d18a86e1b43";
const UCK = Buffer.alloc(32, 0x27);

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      return;
    } catch (error) {
      lastError = error;
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function migrationUps(): Promise<Array<{ name: string; sql: string }>> {
  const names = (await readdir("migrations"))
    .filter((name) => /^17000000\d+.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map(async (name) => ({
    name,
    sql: (await readFile(`migrations/${name}`, "utf8")).split("-- Down Migration", 1)[0]!,
  })));
}

function runtime(userId: string): ManagedContentRuntime {
  return {
    installationId: INSTALLATION_ID,
    registry: {} as ManagedContentRuntime["registry"],
    health: {} as ManagedContentRuntime["health"],
    userKeys: {
      async withActiveUserKey() {
        throw new Error("UNUSED");
      },
      async withUserKeyVersion(requestedUserId, version, fn) {
        assert.equal(requestedUserId, userId);
        assert.equal(version, 1);
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

test("managed history search executes real PostgreSQL filters and signed cursor pagination", { timeout: 120_000 }, async () => {
  const container = `toard-history-search-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let app: Client | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432",
      "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port, `failed to resolve PostgreSQL port from: ${stdout}`);
    const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(adminUrl);
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query("CREATE ROLE toard_app LOGIN PASSWORD 'integration-app-password' NOSUPERUSER NOBYPASSRLS");
    for (const migration of await migrationUps()) {
      await admin.query(migration.sql).catch((error: unknown) => {
        throw new Error(`failed migration ${migration.name}`, { cause: error });
      });
    }
    await admin.query(`
      GRANT USAGE ON SCHEMA public TO toard_app;
      GRANT SELECT ON users, providers, prompt_records TO toard_app;
    `);

    const userId = randomUUID();
    const otherUserId = randomUUID();
    await admin.query(
      "INSERT INTO users(id,email) VALUES ($1,'history-search@example.test'),($2,'history-search-other@example.test')",
      [userId, otherUserId],
    );
    await admin.query(
      "INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES ('codex','Codex',ARRAY['codex'],'logfile')",
    );

    const insert = async (record: PromptRecordWire, ownerId: string, agentId: string | null) => {
      const encrypted = encryptManagedContent(record, UCK, INSTALLATION_ID, ownerId, 1);
      await admin!.query(
        `INSERT INTO prompt_records
           (dedup_key,user_id,session_id,provider_key,turn_role,ts,
            key_version,wrapped_dek,iv,ciphertext,auth_tag,encryption_scheme,
            content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version,
            agent_id,parent_agent_id,agent_depth,agent_name,agent_role)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'managed_v1',
                NULL,$7,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          record.dedupKey,
          ownerId,
          record.sessionId,
          record.providerKey,
          record.turnRole,
          record.ts,
          encrypted.contentKeyVersion,
          encrypted.wrappedDek,
          encrypted.iv,
          encrypted.ciphertext,
          encrypted.authTag,
          encrypted.dekWrapIv,
          encrypted.dekWrapAuthTag,
          encrypted.aadVersion,
          agentId,
          agentId ? "main" : null,
          agentId ? 1 : null,
          agentId ? "Search agent" : null,
          agentId ? "researcher" : null,
        ],
      );
    };

    await insert({
      dedupKey: "1".repeat(64), sessionId: "session-new", providerKey: "codex",
      turnRole: "assistant", ts: new Date("2026-07-22T02:00:00.000Z"),
      text: "OAuth 로그인 오류를 최신 세션에서 해결했습니다.",
    }, userId, "agent-new");
    await insert({
      dedupKey: "2".repeat(64), sessionId: "session-old", providerKey: "codex",
      turnRole: "user", ts: new Date("2026-07-21T02:00:00.000Z"),
      text: "이전 세션의 로그인 오류도 찾아주세요.",
    }, userId, "agent-old");
    await insert({
      dedupKey: "3".repeat(64), sessionId: "session-main", providerKey: "codex",
      turnRole: "user", ts: new Date("2026-07-23T02:00:00.000Z"),
      text: "메인 에이전트의 로그인 오류는 필터에서 제외됩니다.",
    }, userId, null);
    await insert({
      dedupKey: "4".repeat(64), sessionId: "session-other-user", providerKey: "codex",
      turnRole: "user", ts: new Date("2026-07-24T02:00:00.000Z"),
      text: "다른 사용자의 로그인 오류는 절대 보이면 안 됩니다.",
    }, otherUserId, "agent-other");
    await assert.rejects(
      insert({
        dedupKey: "5".repeat(64), sessionId: "s".repeat(256), providerKey: "codex",
        turnRole: "user", ts: new Date("2026-07-25T02:00:00.000Z"),
        text: "DB 경계에서도 장문 session id를 거부해야 합니다.",
      }, userId, null),
      (error: unknown) => {
        assert.equal((error as { constraint?: string }).constraint, "prompt_records_session_id_length");
        return true;
      },
    );

    app = new Client({
      connectionString: `postgresql://toard_app:integration-app-password@127.0.0.1:${port}/toard`,
    });
    await app.connect();
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const filter = {
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
      providerKey: "codex",
      agentScope: "subagent" as const,
    };
    const dependencies = { db: app, runtime: runtime(userId), legacyKek: null };
    const first = await searchMyHistorySessions(
      userId, filter, "로그인 오류", undefined, "cursor-secret", 1, dependencies,
    );
    assert.deepEqual(first.sessions.map((session) => session.key), ["session-new"]);
    assert.match(first.sessions[0]!.preview, /로그인 오류/);
    assert.ok(first.nextCursor);

    const second = await searchMyHistorySessions(
      userId, filter, "로그인 오류", first.nextCursor!, "cursor-secret", 1, dependencies,
    );
    assert.deepEqual(second.sessions.map((session) => session.key), ["session-old"]);
    assert.equal(second.nextCursor, null);
    await app.query("ROLLBACK");
  } finally {
    await app?.query("ROLLBACK").catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
