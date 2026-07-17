import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const MIGRATION = "migrations/1700000039_managed_key_distribution.sql";
const OLD = "local:111111111111111111111111";
const TARGET = "aws-kms:222222222222222222222222";

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      last = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw last;
}

async function migrationUpsBefore39(): Promise<string[]> {
  const names = (await readdir("migrations"))
    .filter((name) => /^17000000\d+.*\.sql$/.test(name) && name < "1700000039")
    .sort();
  return Promise.all(names.map(async (name) => (
    await readFile(`migrations/${name}`, "utf8")
  ).split("-- Down Migration", 1)[0]!));
}

async function distribution(client: Client): Promise<Array<Record<string, unknown>>> {
  return (await client.query(`
    SELECT provider,provider_fingerprint,state,wrapper_count::text
      FROM managed_content_key_distribution
     ORDER BY provider,provider_fingerprint,state
  `)).rows;
}

function insertWrapper(
  client: Client,
  userId: string,
  provider: "local" | "aws-kms",
  fingerprint: string,
  state: "active" | "pending" | "retiring",
): Promise<unknown> {
  return client.query(
    `INSERT INTO managed_content_keys
       (user_id,key_version,provider,provider_key_ref,provider_fingerprint,
        wrapped_user_key,wrapper_metadata,state)
     VALUES($1,1,$2,$3,$4,$5,'{}',$6)`,
    [userId, provider, `${provider}:test-key`, fingerprint, Buffer.alloc(64, 0x44), state],
  );
}

test("migration 39 exposes an exact secret-free wrapper distribution and keeps it transactionally synchronized", { timeout: 180_000 }, async () => {
  // TDD RED: 이 read가 migration 구현 전 ENOENT로 실패해야 한다.
  const source = await readFile(MIGRATION, "utf8");
  const [up = "", down = ""] = source.split("-- Down Migration", 2);
  assert.ok(up && down);
  const container = `toard-key-distribution-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let app: Client | null = null;
  let concurrentA: Client | null = null;
  let concurrentB: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(adminUrl);
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query("CREATE ROLE toard_app LOGIN PASSWORD 'integration-password' NOSUPERUSER NOBYPASSRLS");
    for (const sql of await migrationUpsBefore39()) await admin.query(sql);
    await admin.query("GRANT USAGE ON SCHEMA public TO toard_app");

    const userA = randomUUID();
    const userB = randomUUID();
    const userC = randomUUID();
    const userD = randomUUID();
    await admin.query(
      `INSERT INTO users(id,email) VALUES
         ($1,'dist-a@example.com'),($2,'dist-b@example.com'),
         ($3,'dist-c@example.com'),($4,'dist-d@example.com')`,
      [userA, userB, userC, userD],
    );
    await insertWrapper(admin, userA, "local", OLD, "active");
    await insertWrapper(admin, userB, "local", OLD, "active");
    await admin.query(up);

    const columns = (await admin.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='managed_content_key_distribution'
       ORDER BY column_name
    `)).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ["provider", "provider_fingerprint", "state", "wrapper_count"]);
    assert.deepEqual(await distribution(admin), [{
      provider: "local", provider_fingerprint: OLD, state: "active", wrapper_count: "2",
    }]);

    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.equal((await admin.query(
        "SELECT has_table_privilege('toard_app','managed_content_key_distribution',$1) AS ok",
        [privilege],
      )).rows[0].ok, false, privilege);
    }
    assert.equal((await admin.query(
      "SELECT has_table_privilege('toard_app','managed_content_key_distribution','SELECT') AS ok",
    )).rows[0].ok, true);

    app = new Client({ connectionString: `postgresql://toard_app:integration-password@127.0.0.1:${port}/toard` });
    await app.connect();
    assert.deepEqual(await distribution(app), [{
      provider: "local", provider_fingerprint: OLD, state: "active", wrapper_count: "2",
    }]);
    await assert.rejects(
      app.query("UPDATE managed_content_key_distribution SET wrapper_count=0"),
      /permission denied/,
    );

    await admin.query("BEGIN");
    await admin.query(
      `UPDATE managed_content_keys
          SET provider='aws-kms',provider_key_ref='aws-kms:test-key',provider_fingerprint=$2,state='pending'
        WHERE user_id=$1`,
      [userA, TARGET],
    );
    assert.deepEqual(await distribution(admin), [
      { provider: "aws-kms", provider_fingerprint: TARGET, state: "pending", wrapper_count: "1" },
      { provider: "local", provider_fingerprint: OLD, state: "active", wrapper_count: "1" },
    ]);
    await admin.query("ROLLBACK");
    assert.deepEqual(await distribution(admin), [{
      provider: "local", provider_fingerprint: OLD, state: "active", wrapper_count: "2",
    }]);

    concurrentA = new Client({ connectionString: adminUrl });
    concurrentB = new Client({ connectionString: adminUrl });
    await Promise.all([concurrentA.connect(), concurrentB.connect()]);
    await Promise.all([
      insertWrapper(concurrentA, userC, "aws-kms", TARGET, "retiring"),
      insertWrapper(concurrentB, userD, "aws-kms", TARGET, "retiring"),
    ]);
    assert.deepEqual(await distribution(admin), [
      { provider: "aws-kms", provider_fingerprint: TARGET, state: "retiring", wrapper_count: "2" },
      { provider: "local", provider_fingerprint: OLD, state: "active", wrapper_count: "2" },
    ]);

    await admin.query("BEGIN");
    await admin.query("DELETE FROM managed_content_keys WHERE user_id=$1", [userC]);
    assert.equal((await distribution(admin))[0]!.wrapper_count, "1");
    await admin.query("ROLLBACK");
    assert.equal((await distribution(admin))[0]!.wrapper_count, "2");

    await admin.query(
      `UPDATE managed_content_key_distribution SET wrapper_count=0
        WHERE provider='local' AND provider_fingerprint=$1 AND state='active'`,
      [OLD],
    );
    await assert.rejects(
      admin.query("DELETE FROM managed_content_keys WHERE user_id=$1", [userA]),
      /distribution underflow/i,
    );
    assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM managed_content_keys WHERE user_id=$1", [userA])).rows[0].count, 1);
    await admin.query(
      `UPDATE managed_content_key_distribution SET wrapper_count=2
        WHERE provider='local' AND provider_fingerprint=$1 AND state='active'`,
      [OLD],
    );

    await admin.query(
      `UPDATE managed_content_key_distribution SET wrapper_count=9223372036854775807
        WHERE provider='local' AND provider_fingerprint=$1 AND state='active'`,
      [OLD],
    );
    const overflowUser = randomUUID();
    await admin.query("INSERT INTO users(id,email) VALUES($1,'dist-overflow@example.com')", [overflowUser]);
    await assert.rejects(
      insertWrapper(admin, overflowUser, "local", OLD, "active"),
      /distribution overflow/i,
    );
    assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM managed_content_keys WHERE user_id=$1", [overflowUser])).rows[0].count, 0);
    await admin.query(
      `UPDATE managed_content_key_distribution SET wrapper_count=2
        WHERE provider='local' AND provider_fingerprint=$1 AND state='active'`,
      [OLD],
    );

    await admin.query(
      `UPDATE managed_content_key_distribution SET wrapper_count=999
        WHERE provider='local' AND provider_fingerprint=$1 AND state='active'`,
      [OLD],
    );
    await assert.rejects(admin.query(down), /distribution mismatch/i);
    assert.equal((await admin.query("SELECT to_regclass('managed_content_key_distribution') IS NOT NULL AS ok")).rows[0].ok, true);
    await admin.query(
      `UPDATE managed_content_key_distribution SET wrapper_count=2
        WHERE provider='local' AND provider_fingerprint=$1 AND state='active'`,
      [OLD],
    );
    await admin.query(down);
    assert.equal((await admin.query("SELECT to_regclass('managed_content_key_distribution') IS NULL AS ok")).rows[0].ok, true);
    assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM managed_content_keys")).rows[0].count, 4);
  } finally {
    await concurrentB?.end().catch(() => undefined);
    await concurrentA?.end().catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
