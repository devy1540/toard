import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const MIGRATION = "migrations/1700000053_utilization_cache_generation.sql";

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

function databaseUrl(port: string, role = "postgres"): string {
  const password = role === "postgres" ? "postgres" : "integration-password";
  return `postgresql://${role}:${password}@127.0.0.1:${port}/toard`;
}

test("공유 활용 지수 generation은 전 replica key와 진행 중 cache 우회를 위한 상태를 보존한다", { timeout: 120_000 }, async () => {
  const migration = await readFile(MIGRATION, "utf8");
  const [up = "", down = ""] = migration.split("-- Down Migration");
  const container = `toard-utilization-cache-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let app: Client | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    await waitForPostgres(databaseUrl(port));

    admin = new Client({ connectionString: databaseUrl(port) });
    await admin.connect();
    await admin.query("CREATE ROLE toard_app LOGIN PASSWORD 'integration-password' NOSUPERUSER NOBYPASSRLS");
    await admin.query("GRANT USAGE ON SCHEMA public TO toard_app");
    await admin.query(`
      CREATE TABLE usage_events (dedup_key TEXT PRIMARY KEY, user_id UUID, provider_key TEXT);
      CREATE TABLE tool_activity_events (dedup_key TEXT PRIMARY KEY, user_id UUID, provider_key TEXT);
      CREATE TABLE clickhouse_usage_outbox (
        dedup_key TEXT PRIMARY KEY,
        user_id UUID,
        provider_key TEXT,
        delivered_at TIMESTAMPTZ
      );
      CREATE TABLE pricing_repair_status (
        singleton BOOLEAN PRIMARY KEY,
        reconciled_events BIGINT NOT NULL DEFAULT 0
      );
      INSERT INTO pricing_repair_status (singleton) VALUES (true);
    `);
    await admin.query(up);

    app = new Client({ connectionString: databaseUrl(port, "toard_app") });
    await app.connect();
    await assert.rejects(app.query("SELECT * FROM utilization_cache_generations"), /permission denied/);
    await assert.rejects(app.query("SELECT * FROM utilization_cache_change_leases"), /permission denied/);

    const userId = "11111111-1111-1111-1111-111111111111";
    const read = async () => (await app!.query(
      "SELECT * FROM read_utilization_cache_generation($1::uuid)",
      [userId],
    )).rows[0];
    assert.deepEqual(await read(), {
      personal_user_generation: "0",
      personal_user_pending: 0,
      personal_all_generation: "0",
      personal_all_pending: 0,
      organization_generation: "0",
      organization_pending: 0,
    });

    await admin.query(
      "INSERT INTO usage_events (dedup_key, user_id, provider_key) VALUES ('usage-1', $1, 'codex')",
      [userId],
    );
    await admin.query("DELETE FROM usage_events WHERE dedup_key = 'usage-1'");
    await admin.query(
      "INSERT INTO tool_activity_events (dedup_key, user_id, provider_key) VALUES ('tool-ignored', $1, 'gemini')",
      [userId],
    );
    await admin.query(
      "INSERT INTO tool_activity_events (dedup_key, user_id, provider_key) VALUES ('tool-used', $1, 'codex')",
      [userId],
    );
    await admin.query(
      "INSERT INTO clickhouse_usage_outbox (dedup_key, user_id, provider_key) VALUES ('outbox-1', $1, 'codex')",
      [userId],
    );
    await admin.query("UPDATE clickhouse_usage_outbox SET delivered_at = now() WHERE dedup_key = 'outbox-1'");
    await admin.query("DELETE FROM clickhouse_usage_outbox WHERE dedup_key = 'outbox-1'");
    await admin.query("UPDATE pricing_repair_status SET reconciled_events = reconciled_events + 1 WHERE singleton");
    const oldPodMutations = await read();
    assert.equal(oldPodMutations.personal_user_generation, "6");
    assert.equal(oldPodMutations.personal_all_generation, "1");
    assert.equal(oldPodMutations.organization_generation, "7");

    await admin.query("UPDATE utilization_cache_generations SET generation = 0");

    const lease1 = (await app.query<{ lease_id: string }>(
      "SELECT begin_user_utilization_cache_change($1::uuid)::text AS lease_id",
      [userId],
    )).rows[0]!.lease_id;
    const lease2 = (await app.query<{ lease_id: string }>(
      "SELECT begin_user_utilization_cache_change($1::uuid)::text AS lease_id",
      [userId],
    )).rows[0]!.lease_id;
    assert.equal((await read()).personal_user_pending, 2);
    assert.equal((await read()).organization_pending, 2);
    await admin.query(
      "INSERT INTO usage_events (dedup_key, user_id, provider_key) VALUES ('usage-leased', $1, 'codex')",
      [userId],
    );
    assert.equal((await read()).personal_user_generation, "0");
    assert.equal((await read()).organization_generation, "0");

    await app.query(
      "SELECT finish_user_utilization_cache_change($1::uuid, $2::uuid, false)",
      [lease1, userId],
    );
    const onePending = await read();
    assert.equal(onePending.personal_user_generation, "1");
    assert.equal(onePending.personal_user_pending, 1);
    assert.equal(onePending.organization_generation, "1");
    assert.equal(onePending.organization_pending, 1);

    await app.query(
      "SELECT finish_user_utilization_cache_change($1::uuid, $2::uuid, false)",
      [lease2, userId],
    );
    const settled = await read();
    assert.equal(settled.personal_user_generation, "2");
    assert.equal(settled.personal_user_pending, 0);
    assert.equal(settled.organization_generation, "2");
    assert.equal(settled.organization_pending, 0);

    const allLease = (await app.query<{ lease_id: string }>(
      "SELECT begin_all_utilization_cache_change()::text AS lease_id",
    )).rows[0]!.lease_id;
    await admin.query(
      "INSERT INTO usage_events (dedup_key, user_id, provider_key) VALUES ('usage-global-leased', $1, 'codex')",
      [userId],
    );
    await app.query("SELECT finish_all_utilization_cache_change($1::uuid, false)", [allLease]);
    const global = await read();
    assert.equal(global.personal_all_generation, "1");
    assert.equal(global.personal_all_pending, 0);
    assert.equal(global.organization_generation, "3");
    assert.equal(global.organization_pending, 0);

    const racingLease = (await app.query<{ lease_id: string }>(
      "SELECT begin_user_utilization_cache_change($1::uuid)::text AS lease_id",
      [userId],
    )).rows[0]!.lease_id;
    await admin.query("BEGIN");
    await admin.query(
      "INSERT INTO usage_events (dedup_key, user_id, provider_key) VALUES ('usage-racing-leased', $1, 'codex')",
      [userId],
    );
    let finishResolved = false;
    const racingFinish = app.query(
      "SELECT finish_user_utilization_cache_change($1::uuid, $2::uuid, false)",
      [racingLease, userId],
    ).then(() => { finishResolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(finishResolved, false, "finish는 uncommitted trigger dirty update를 기다려야 한다");
    await admin.query("COMMIT");
    await racingFinish;
    const raced = await read();
    assert.equal(raced.personal_user_generation, "3");
    assert.equal(raced.organization_generation, "4");

    const staleLease = (await app.query<{ lease_id: string }>(
      "SELECT begin_user_utilization_cache_change($1::uuid)::text AS lease_id",
      [userId],
    )).rows[0]!.lease_id;
    await admin.query(
      "UPDATE utilization_cache_change_leases SET heartbeat_at = now() - interval '6 minutes' WHERE lease_id = $1",
      [staleLease],
    );
    const recovered = await read();
    assert.equal(recovered.personal_user_generation, "4");
    assert.equal(recovered.personal_user_pending, 0);
    assert.equal(recovered.organization_generation, "5");
    assert.equal(recovered.organization_pending, 0);

    // stale 회수 뒤 늦은 finish가 와도 generation을 다시 전진시켜 회수-완료 사이 cache를 폐기한다.
    await app.query(
      "SELECT finish_user_utilization_cache_change($1::uuid, $2::uuid, true)",
      [staleLease, userId],
    );
    const lateFinish = await read();
    assert.equal(lateFinish.personal_user_generation, "5");
    assert.equal(lateFinish.organization_generation, "6");

    await app.end();
    app = null;
    await admin.query(down);
    assert.equal((await admin.query(
      "SELECT to_regclass('public.utilization_cache_generations') AS table_name",
    )).rows[0].table_name, null);
  } finally {
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
