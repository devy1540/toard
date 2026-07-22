import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { closePool } from "../apps/web/lib/db";
import { reconcilePromptAgentMetadata } from "../apps/web/lib/prompt-records";
import type { PromptAgentMetadataReconciliationWire } from "../apps/web/lib/prompt-wire";

const execFileAsync = promisify(execFile);

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

async function allMigrationUps(): Promise<Array<{ name: string; sql: string }>> {
  const names = (await readdir("migrations"))
    .filter((name) => /^17000000\d+.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map(async (name) => {
    const source = await readFile(`migrations/${name}`, "utf8");
    const [up] = source.split("-- Down Migration", 1);
    assert.ok(up, `missing Up migration in ${name}`);
    return { name, sql: up };
  }));
}

function reconciliation(
  dedupKey: string,
  providerKey = "codex",
  agentId = "agent-reviewer",
): PromptAgentMetadataReconciliationWire {
  return {
    dedupKey,
    providerKey,
    agent: {
      id: agentId,
      parentId: "root-session",
      depth: 1,
      name: "Reviewer",
      role: "reviewer",
    },
  };
}

test("prompt agent metadata reconciliation은 실제 PostgreSQL에서 RLS와 불변 본문을 보장한다", { timeout: 120_000 }, async () => {
  const container = `toard-prompt-agent-reconcile-${randomUUID().slice(0, 8)}`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let admin: Client | null = null;

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
    for (const migration of await allMigrationUps()) {
      await admin.query(migration.sql).catch((error: unknown) => {
        throw new Error(`failed migration ${migration.name}`, { cause: error });
      });
    }
    await admin.query(`
      GRANT USAGE ON SCHEMA public TO toard_app;
      GRANT SELECT, UPDATE ON prompt_records TO toard_app;
    `);

    const userA = randomUUID();
    const userB = randomUUID();
    await admin.query(
      `INSERT INTO users(id,email) VALUES
         ($1,'agent-reconcile-a@example.test'),
         ($2,'agent-reconcile-b@example.test')`,
      [userA, userB],
    );
    await admin.query(
      `INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES
         ('codex','Codex',ARRAY['codex'],'logfile'),
         ('claude_code','Claude Code',ARRAY['claude_code'],'logfile')`,
    );

    const keys = {
      target: "1".repeat(64),
      otherUser: "2".repeat(64),
      otherProvider: "3".repeat(64),
      classified: "4".repeat(64),
      untouched: "5".repeat(64),
    };
    const insert = async (
      dedupKey: string,
      userId: string,
      providerKey: string,
      agentId: string | null = null,
    ) => admin!.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,session_id,provider_key,turn_role,ts,
          key_version,wrapped_dek,iv,ciphertext,auth_tag,
          agent_id,parent_agent_id,agent_depth,agent_name,agent_role)
       VALUES($1,$2,$3,$4,'assistant','2026-07-22T00:00:00.000Z',
              1,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        dedupKey,
        userId,
        `session-${dedupKey[0]}`,
        providerKey,
        Buffer.alloc(32, Number.parseInt(dedupKey[0]!, 16)),
        Buffer.alloc(12, 0x22),
        Buffer.from(`ciphertext-${dedupKey[0]}`),
        Buffer.alloc(16, 0x44),
        agentId,
        agentId === null ? null : "existing-root",
        agentId === null ? null : 1,
        agentId === null ? null : "Existing",
        agentId === null ? null : "existing",
      ],
    );
    await insert(keys.target, userA, "codex");
    await insert(keys.otherUser, userB, "codex");
    await insert(keys.otherProvider, userA, "claude_code");
    await insert(keys.classified, userA, "codex", "agent-existing");
    await insert(keys.untouched, userA, "codex");

    const snapshotSql = `
      SELECT dedup_key,user_id::text,session_id,provider_key,turn_role,ts::text,
             key_version,encode(wrapped_dek,'hex') AS wrapped_dek,
             encode(iv,'hex') AS iv,encode(ciphertext,'hex') AS ciphertext,
             encode(auth_tag,'hex') AS auth_tag,encryption_scheme,received_at::text
      FROM prompt_records ORDER BY dedup_key`;
    const before = (await admin.query(snapshotSql)).rows;

    await closePool();
    process.env.DATABASE_URL = `postgresql://toard_app:integration-app-password@127.0.0.1:${port}/toard`;
    assert.deepEqual(
      await reconcilePromptAgentMetadata(userA, [
        reconciliation(keys.target),
        reconciliation(keys.otherUser),
        reconciliation(keys.otherProvider),
        reconciliation(keys.classified, "codex", "agent-overwrite"),
      ]),
      { reconciled: 1 },
    );
    assert.deepEqual(
      await reconcilePromptAgentMetadata(userA, [reconciliation(keys.target)]),
      { reconciled: 0 },
    );

    const after = (await admin.query(snapshotSql)).rows;
    assert.deepEqual(after, before, "본문·암호문·세션·시각 메타데이터는 바뀌면 안 됨");

    const agents = await admin.query(`
      SELECT dedup_key,agent_id,parent_agent_id,agent_depth,agent_name,agent_role
      FROM prompt_records ORDER BY dedup_key
    `);
    assert.deepEqual(agents.rows, [
      {
        dedup_key: keys.target,
        agent_id: "agent-reviewer",
        parent_agent_id: "root-session",
        agent_depth: 1,
        agent_name: "Reviewer",
        agent_role: "reviewer",
      },
      { dedup_key: keys.otherUser, agent_id: null, parent_agent_id: null, agent_depth: null, agent_name: null, agent_role: null },
      { dedup_key: keys.otherProvider, agent_id: null, parent_agent_id: null, agent_depth: null, agent_name: null, agent_role: null },
      {
        dedup_key: keys.classified,
        agent_id: "agent-existing",
        parent_agent_id: "existing-root",
        agent_depth: 1,
        agent_name: "Existing",
        agent_role: "existing",
      },
      { dedup_key: keys.untouched, agent_id: null, parent_agent_id: null, agent_depth: null, agent_name: null, agent_role: null },
    ]);
  } finally {
    await closePool().catch(() => undefined);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
