import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const BASE_MIGRATIONS = [
  "1700000001_init.sql",
  "1700000010_prompt_records.sql",
  "1700000030_e2ee_content_foundation.sql",
  "1700000031_e2ee_legacy_retirement.sql",
  "1700000035_managed_content_foundation.sql",
] as const;
const STATE_MIGRATION = "1700000036_managed_content_migration_state.sql";

async function waitForPostgres(connectionString: string): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = new Client({
      connectionString,
      connectionTimeoutMillis: 1_000,
      query_timeout: 1_000,
    });
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

async function migrationPart(filename: string, part: "up" | "down"): Promise<string> {
  const migration = await readFile(`migrations/${filename}`, "utf8");
  const [up, down] = migration.split("-- Down Migration", 2);
  assert.ok(up);
  if (part === "down") assert.ok(down);
  return part === "up" ? up : down;
}

async function migrationStatus(client: Client) {
  const result = await client.query<{
    e2ee_migration_pending: number;
    e2ee_migration_blocked: number;
    updated_at: Date;
  }>(`
    SELECT e2ee_migration_pending::int, e2ee_migration_blocked::int, updated_at
    FROM content_encryption_status
    WHERE singleton = TRUE
  `);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function expectConstraintFailure(
  client: Client,
  sql: string,
  params: unknown[],
  pattern: RegExp,
): Promise<void> {
  await client.query("SAVEPOINT invalid_state");
  await assert.rejects(client.query(sql, params), pattern);
  await client.query("ROLLBACK TO SAVEPOINT invalid_state");
  await client.query("RELEASE SAVEPOINT invalid_state");
}

test("migration 36 models owner-scoped E2EE migration state and safe rollback", { timeout: 120_000 }, async () => {
  const container = `toard-managed-state-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;

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
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);

    client = new Client({ connectionString });
    await client.connect();
    for (const migration of BASE_MIGRATIONS.slice(0, 3)) {
      await client.query(await migrationPart(migration, "up"));
    }

    await client.query(`
      CREATE ROLE toard_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO toard_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO toard_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO toard_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO toard_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO toard_app;
    `);

    const userA = randomUUID();
    const userB = randomUUID();
    const userC = randomUUID();
    const ownerB = randomUUID();
    const ownerC = randomUUID();
    await client.query(
      `INSERT INTO users (id,email) VALUES
         ($1,'migration-a@example.com'),
         ($2,'migration-b@example.com'),
         ($3,'migration-c@example.com')`,
      [userA, userB, userC],
    );
    await client.query(
      `INSERT INTO providers (key,display_name,service_name_patterns,collection_method)
       VALUES ('codex','Codex',ARRAY['codex'],'logfile')`,
    );
    const ownerA = randomUUID();
    await client.query(
      `INSERT INTO content_accounts (user_id,content_owner_id,state,recovery_confirmed_at)
       VALUES ($1,$3,'active',now()),($2,$5,'active',now()),
              ($4,$6,'pending',NULL)`,
      [userA, userB, ownerA, userC, ownerB, ownerC],
    );
    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_owner_id,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES ('e2ee-state-source',$1,'codex','user',now(),1,$2,$3,$4,$5,
               'e2ee_v1',$6,1,$7,$8,1)`,
      [
        userA,
        Buffer.alloc(32, 1),
        Buffer.alloc(12, 2),
        Buffer.from("e2ee-state"),
        Buffer.alloc(16, 3),
        ownerA,
        Buffer.alloc(12, 4),
        Buffer.alloc(16, 5),
      ],
    );
    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag)
       VALUES ('server-not-a-source',$1,'codex','assistant',now(),1,$2,$3,$4,$5)`,
      [userB, Buffer.alloc(60, 20), Buffer.alloc(12, 21), Buffer.from("server"), Buffer.alloc(16, 22)],
    );
    for (const migration of BASE_MIGRATIONS.slice(3)) {
      await client.query(await migrationPart(migration, "up"));
    }

    const up = await migrationPart(STATE_MIGRATION, "up");
    const down = await migrationPart(STATE_MIGRATION, "down");
    await client.query(up);

    const backfill = await client.query<{
      user_id: string;
      state: string;
      started_at: Date | null;
      completed_at: Date | null;
    }>(`
      SELECT user_id,state,started_at,completed_at
      FROM content_e2ee_migrations
      ORDER BY user_id
    `);
    const byUser = new Map(backfill.rows.map((row) => [row.user_id, row]));
    assert.equal(backfill.rowCount, 2);
    assert.deepEqual(byUser.get(userA), {
      user_id: userA,
      state: "pending",
      started_at: null,
      completed_at: null,
    });
    assert.equal(byUser.get(userB)?.state, "complete");
    assert.ok(byUser.get(userB)?.started_at instanceof Date);
    assert.ok(byUser.get(userB)?.completed_at instanceof Date);
    const sourceMarkers = await client.query<{
      prompt_record_id: string;
      user_id: string;
      encryption_scheme: string;
    }>(`
      SELECT marker.prompt_record_id::text, record.user_id, record.encryption_scheme
      FROM content_e2ee_migration_sources marker
      JOIN prompt_records record ON record.id=marker.prompt_record_id
    `);
    assert.equal(sourceMarkers.rowCount, 1);
    assert.equal(sourceMarkers.rows[0].user_id, userA);
    assert.equal(sourceMarkers.rows[0].encryption_scheme, "e2ee_v1");
    assert.deepEqual(
      await migrationStatus(client).then(({ e2ee_migration_pending, e2ee_migration_blocked }) => ({
        e2ee_migration_pending,
        e2ee_migration_blocked,
      })),
      { e2ee_migration_pending: 1, e2ee_migration_blocked: 0 },
    );

    for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
      assert.equal(
        (await client.query(
          "SELECT has_table_privilege('toard_app','content_e2ee_migrations',$1) AS ok",
          [privilege],
        )).rows[0].ok,
        true,
      );
    }
    assert.equal(
      (await client.query(
        "SELECT has_table_privilege('toard_app','content_e2ee_migrations','DELETE') AS ok",
      )).rows[0].ok,
      false,
    );
    assert.equal(
      (await client.query(
        "SELECT has_table_privilege('toard_app','managed_content_keys','DELETE') AS ok",
      )).rows[0].ok,
      false,
      "managed key wrappers must retain the bootstrap least-privilege boundary",
    );
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      assert.equal(
        (await client.query(
          "SELECT has_table_privilege('toard_app','content_e2ee_migration_sources',$1) AS ok",
          [privilege],
        )).rows[0].ok,
        false,
      );
    }

    for (const sql of [
      "UPDATE content_e2ee_migration_sources SET marked_at=clock_timestamp()",
      "DELETE FROM content_e2ee_migration_sources",
      "TRUNCATE content_e2ee_migration_sources",
    ]) {
      await client.query("BEGIN");
      await assert.rejects(client.query(sql), /E2EE migration source markers are immutable/);
      await client.query("ROLLBACK");
    }
    assert.equal(
      (await client.query("SELECT COUNT(*)::int AS count FROM content_e2ee_migration_sources")).rows[0].count,
      1,
    );
    const policies = await client.query<{ policyname: string; expression: string }>(`
      SELECT policyname, COALESCE(qual, with_check) AS expression
      FROM pg_policies
      WHERE schemaname='public' AND tablename='content_e2ee_migrations'
      ORDER BY policyname
    `);
    assert.equal(policies.rowCount, 3);
    for (const policy of policies.rows) {
      assert.match(policy.expression, /current_setting\('app.current_user_id'/);
    }
    const rls = await client.query(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid='content_e2ee_migrations'::regclass
    `);
    assert.deepEqual(rls.rows[0], { relrowsecurity: true, relforcerowsecurity: true });

    await client.query("SET ROLE toard_app");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
    assert.deepEqual(
      (await client.query("SELECT user_id FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rows,
      [{ user_id: userA }],
    );
    assert.equal(
      (await client.query("SELECT user_id FROM content_e2ee_migrations WHERE user_id=$1", [userB])).rowCount,
      0,
    );
    assert.equal(
      (await client.query(
        "UPDATE content_e2ee_migrations SET state='running',started_at=now() WHERE user_id=$1 RETURNING user_id",
        [userB],
      )).rowCount,
      0,
    );
    assert.deepEqual(
      (await client.query("SELECT * FROM get_content_e2ee_migration_progress($1)", [userA])).rows,
      [{ e2ee_records: "1", migrated_records: "0" }],
    );
    await assert.rejects(
      client.query("SELECT * FROM get_content_e2ee_migration_progress($1)", [userB]),
      (error: unknown) => (error as { code?: string }).code === "42501" && /user mismatch/.test(String(error)),
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await assert.rejects(
      client.query("DELETE FROM content_e2ee_migrations WHERE user_id=$1", [userA]),
      /permission denied for table content_e2ee_migrations/,
    );
    await client.query("ROLLBACK");

    for (const sql of [
      "SELECT prompt_record_id FROM content_e2ee_migration_sources",
      "INSERT INTO content_e2ee_migration_sources(prompt_record_id) VALUES(999999)",
      "UPDATE content_e2ee_migration_sources SET prompt_record_id=prompt_record_id",
      "DELETE FROM content_e2ee_migration_sources",
    ]) {
      await client.query("BEGIN");
      await assert.rejects(
        client.query(sql),
        /permission denied for table content_e2ee_migration_sources/,
      );
      await client.query("ROLLBACK");
    }

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userC]);
    await client.query(
      `INSERT INTO content_e2ee_migrations
         (user_id,state,blocked_at,blocked_reason)
       VALUES($1,'blocked',now(),'key_unavailable')`,
      [userC],
    );
    assert.deepEqual(
      (await client.query("SELECT user_id FROM content_e2ee_migrations WHERE user_id=$1", [userC])).rows,
      [{ user_id: userC }],
    );
    assert.equal(
      (await client.query("SELECT user_id FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rowCount,
      0,
    );
    await client.query("ROLLBACK");
    await client.query("RESET ROLE");

    const completedBeforeLateSource = byUser.get(userB)!;
    await client.query("SET ROLE toard_app");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userB]);
    await client.query("UPDATE content_accounts SET state='migrated' WHERE user_id=$1", [userB]);
    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_owner_id,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES ('late-e2ee-insert',$1,'codex','user',now(),1,$2,$3,$4,$5,
               'e2ee_v1',$6,1,$7,$8,1)`,
      [
        userB,
        Buffer.alloc(32, 30),
        Buffer.alloc(12, 31),
        Buffer.from("late-e2ee"),
        Buffer.alloc(16, 32),
        ownerB,
        Buffer.alloc(12, 33),
        Buffer.alloc(16, 34),
      ],
    );
    await client.query("COMMIT");
    await client.query("RESET ROLE");

    const repending = await client.query<{
      state: string;
      started_at: Date;
      completed_at: Date | null;
      updated_at: Date;
    }>(`
      SELECT state,started_at,completed_at,updated_at
      FROM content_e2ee_migrations WHERE user_id=$1
    `, [userB]);
    assert.equal(repending.rows[0].state, "pending");
    assert.equal(repending.rows[0].completed_at, null);
    assert.deepEqual(repending.rows[0].started_at, completedBeforeLateSource.started_at);
    assert.ok(repending.rows[0].updated_at > completedBeforeLateSource.completed_at!);
    assert.equal(
      (await client.query("SELECT state FROM content_accounts WHERE user_id=$1", [userB])).rows[0].state,
      "active",
    );
    assert.equal((await migrationStatus(client)).e2ee_migration_pending, 2);
    assert.equal(
      (await client.query("SELECT COUNT(*)::int AS count FROM content_e2ee_migration_sources")).rows[0].count,
      2,
    );

    await client.query("SET ROLE toard_app");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userB]);
    await client.query(
      `UPDATE prompt_records
       SET encryption_scheme='e2ee_v1',content_owner_id=$2,content_key_version=1,
           wrapped_dek=$3,dek_wrap_iv=$4,dek_wrap_auth_tag=$5,
           iv=$4,ciphertext=$6,auth_tag=$5,aad_version=1
       WHERE user_id=$1 AND dedup_key='server-not-a-source'`,
      [
        userB,
        ownerB,
        Buffer.alloc(32, 35),
        Buffer.alloc(12, 36),
        Buffer.alloc(16, 37),
        Buffer.from("late-e2ee-update"),
      ],
    );
    await client.query("COMMIT");
    await client.query("RESET ROLE");
    assert.equal(
      (await client.query("SELECT state FROM content_e2ee_migrations WHERE user_id=$1", [userB])).rows[0].state,
      "pending",
    );
    assert.equal((await migrationStatus(client)).e2ee_migration_pending, 2);
    assert.equal(
      (await client.query("SELECT COUNT(*)::int AS count FROM content_e2ee_migration_sources")).rows[0].count,
      3,
    );

    await client.query(
      "UPDATE content_e2ee_migrations SET state='running',started_at=COALESCE(started_at,now()),updated_at=now() WHERE user_id=$1",
      [userA],
    );
    await client.query("SET ROLE toard_app");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_owner_id,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES ('late-e2ee-running',$1,'codex','assistant',now(),1,$2,$3,$4,$5,
               'e2ee_v1',$6,1,$7,$8,1)`,
      [
        userA,
        Buffer.alloc(32, 38),
        Buffer.alloc(12, 39),
        Buffer.from("late-running"),
        Buffer.alloc(16, 40),
        ownerA,
        Buffer.alloc(12, 41),
        Buffer.alloc(16, 42),
      ],
    );
    await client.query("COMMIT");
    await client.query("RESET ROLE");
    assert.equal(
      (await client.query("SELECT state FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rows[0].state,
      "running",
    );
    assert.equal((await migrationStatus(client)).e2ee_migration_pending, 2);
    assert.equal(
      (await client.query("SELECT COUNT(*)::int AS count FROM content_e2ee_migration_sources")).rows[0].count,
      4,
    );
    await client.query("UPDATE content_e2ee_migrations SET state='pending' WHERE user_id=$1", [userA]);

    await client.query(
      `INSERT INTO content_e2ee_migrations(user_id,state,blocked_at,blocked_reason)
       VALUES($1,'blocked',now(),'key_unavailable')`,
      [userC],
    );
    await client.query("SET ROLE toard_app");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userC]);
    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_owner_id,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES ('late-e2ee-blocked',$1,'codex','user',now(),1,$2,$3,$4,$5,
               'e2ee_v1',$6,1,$7,$8,1)`,
      [
        userC,
        Buffer.alloc(32, 43),
        Buffer.alloc(12, 44),
        Buffer.from("late-blocked"),
        Buffer.alloc(16, 45),
        ownerC,
        Buffer.alloc(12, 46),
        Buffer.alloc(16, 47),
      ],
    );
    assert.equal(
      (await client.query("SELECT state FROM content_e2ee_migrations WHERE user_id=$1", [userC])).rows[0].state,
      "blocked",
    );
    await client.query("ROLLBACK");
    await client.query("RESET ROLE");
    assert.equal(
      (await client.query("SELECT state FROM content_e2ee_migrations WHERE user_id=$1", [userC])).rows[0].state,
      "blocked",
    );
    assert.equal(
      (await client.query("SELECT COUNT(*)::int AS count FROM content_e2ee_migration_sources")).rows[0].count,
      4,
    );
    await client.query("DELETE FROM content_e2ee_migrations WHERE user_id=$1", [userC]);

    await client.query("BEGIN");
    await client.query(
      "INSERT INTO content_e2ee_migrations(user_id,state) VALUES($1,'pending')",
      [userC],
    );
    await expectConstraintFailure(
      client,
      "UPDATE content_e2ee_migrations SET state='running' WHERE user_id=$1",
      [userC],
      /content_e2ee_migrations_state_timestamps_check/,
    );
    await expectConstraintFailure(
      client,
      "UPDATE content_e2ee_migrations SET state='blocked',blocked_reason='key_unavailable' WHERE user_id=$1",
      [userC],
      /content_e2ee_migrations_blocked_fields_check/,
    );
    await expectConstraintFailure(
      client,
      "UPDATE content_e2ee_migrations SET state='complete' WHERE user_id=$1",
      [userC],
      /content_e2ee_migrations_state_timestamps_check/,
    );
    await expectConstraintFailure(
      client,
      "UPDATE content_e2ee_migrations SET completed_at=now() WHERE user_id=$1",
      [userC],
      /content_e2ee_migrations_state_timestamps_check/,
    );
    await expectConstraintFailure(
      client,
      "UPDATE content_e2ee_migrations SET last_error_code=$2 WHERE user_id=$1",
      [userC, "x".repeat(81)],
      /content_e2ee_migrations_last_error_code_check/,
    );
    await client.query("ROLLBACK");

    await client.query(
      "UPDATE content_e2ee_migrations SET last_error_code='' WHERE user_id=$1",
      [userA],
    );
    assert.equal(
      (await client.query("SELECT last_error_code FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rows[0]
        .last_error_code,
      "",
    );
    await client.query(
      "UPDATE content_e2ee_migrations SET last_error_code=NULL WHERE user_id=$1",
      [userA],
    );

    const beforeNoop = await migrationStatus(client);
    await client.query("UPDATE content_e2ee_migrations SET state=state WHERE user_id=$1", [userA]);
    const afterNoop = await migrationStatus(client);
    assert.deepEqual(afterNoop, beforeNoop);

    await client.query(
      "UPDATE content_e2ee_migrations SET state='running',started_at=now(),updated_at=now() WHERE user_id=$1",
      [userA],
    );
    assert.deepEqual(
      await migrationStatus(client).then(({ e2ee_migration_pending, e2ee_migration_blocked }) => ({
        e2ee_migration_pending,
        e2ee_migration_blocked,
      })),
      { e2ee_migration_pending: 2, e2ee_migration_blocked: 0 },
    );
    await client.query("SELECT pg_sleep(0.01)");
    await client.query(
      `UPDATE content_e2ee_migrations
       SET state='blocked',blocked_at=now(),blocked_reason='key_unavailable',updated_at=now()
       WHERE user_id=$1`,
      [userA],
    );
    const blockedStatus = await migrationStatus(client);
    assert.equal(blockedStatus.e2ee_migration_pending, 1);
    assert.equal(blockedStatus.e2ee_migration_blocked, 1);
    assert.ok(blockedStatus.updated_at > afterNoop.updated_at);
    await client.query("SELECT pg_sleep(0.01)");
    await client.query(
      `UPDATE content_e2ee_migrations
       SET state='pending',blocked_at=NULL,blocked_reason=NULL,last_error_code=NULL,updated_at=now()
       WHERE user_id=$1`,
      [userA],
    );
    const resumedStatus = await migrationStatus(client);
    assert.equal(resumedStatus.e2ee_migration_pending, 2);
    assert.equal(resumedStatus.e2ee_migration_blocked, 0);
    assert.ok(resumedStatus.updated_at > blockedStatus.updated_at);

    await client.query(
      `INSERT INTO content_e2ee_migrations
         (user_id,state,blocked_at,blocked_reason)
       VALUES($1,'blocked',now(),'key_unavailable')`,
      [userC],
    );
    assert.deepEqual(
      await migrationStatus(client).then(({ e2ee_migration_pending, e2ee_migration_blocked }) => ({
        e2ee_migration_pending,
        e2ee_migration_blocked,
      })),
      { e2ee_migration_pending: 2, e2ee_migration_blocked: 1 },
    );
    await client.query("DELETE FROM content_e2ee_migrations WHERE user_id=$1", [userC]);
    assert.deepEqual(
      await migrationStatus(client).then(({ e2ee_migration_pending, e2ee_migration_blocked }) => ({
        e2ee_migration_pending,
        e2ee_migration_blocked,
      })),
      { e2ee_migration_pending: 2, e2ee_migration_blocked: 0 },
    );

    await client.query("BEGIN");
    await client.query(
      "UPDATE content_encryption_status SET e2ee_migration_pending=0 WHERE singleton=TRUE",
    );
    await assert.rejects(
      client.query("DELETE FROM content_e2ee_migrations WHERE user_id=$1", [userA]),
      /content_encryption_status_e2ee_migration_pending_check/,
    );
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT state FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rows[0].state,
      "pending",
    );
    assert.equal((await migrationStatus(client)).e2ee_migration_pending, 2);

    const triggerFunction = await client.query<{ definition: string }>(`
      SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      WHERE p.proname='sync_content_e2ee_migration_status'
    `);
    assert.equal(triggerFunction.rowCount, 1);
    assert.match(triggerFunction.rows[0].definition, /SECURITY DEFINER/i);
    assert.match(triggerFunction.rows[0].definition, /SET search_path TO 'public', 'pg_temp'/i);
    for (const unrelatedColumn of [
      "server_records",
      "e2ee_records",
      "managed_records",
      "active_user_keys",
      "pending_user_keys",
      "retiring_user_keys",
    ]) {
      assert.doesNotMatch(triggerFunction.rows[0].definition, new RegExp(`\\b${unrelatedColumn}\\b`, "i"));
    }

    const captureFunction = await client.query<{ definition: string }>(`
      SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      WHERE p.proname='capture_content_e2ee_migration_source'
    `);
    assert.equal(captureFunction.rowCount, 1);
    assert.match(captureFunction.rows[0].definition, /SECURITY DEFINER/i);
    assert.match(captureFunction.rows[0].definition, /SET search_path TO 'public', 'pg_temp'/i);

    const progressFunction = await client.query<{ definition: string; app_execute: boolean; acl: string }>(`
      SELECT pg_get_functiondef(p.oid) AS definition,
             has_function_privilege('toard_app',p.oid,'EXECUTE') AS app_execute,
             COALESCE(array_to_string(p.proacl, ','), '') AS acl
      FROM pg_proc p
      WHERE p.proname='get_content_e2ee_migration_progress'
    `);
    assert.equal(progressFunction.rowCount, 1);
    assert.equal(progressFunction.rows[0].app_execute, true);
    assert.match(progressFunction.rows[0].definition, /SECURITY DEFINER/i);
    assert.match(progressFunction.rows[0].definition, /RETURNS TABLE\(e2ee_records bigint, migrated_records bigint\)/i);
    assert.match(progressFunction.rows[0].definition, /SET search_path TO 'public', 'pg_temp'/i);
    assert.doesNotMatch(progressFunction.rows[0].acl, /(?:^|,)=(?:X|X\/)/, "PUBLIC execute remains revoked");

    await assert.rejects(client.query(up), /already exists/);
    await client.query("UPDATE content_accounts SET state='migrated' WHERE user_id=$1", [userB]);
    assert.equal(
      (await client.query("SELECT state FROM content_accounts WHERE user_id=$1", [userB])).rows[0].state,
      "migrated",
    );
    await client.query("UPDATE content_accounts SET state='active' WHERE user_id=$1", [userB]);
    assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM content_e2ee_migrations")).rows[0].count, 2);

    await client.query(
      "UPDATE content_e2ee_migrations SET state='running',started_at=COALESCE(started_at,now()) WHERE user_id=$1",
      [userA],
    );
    await assert.rejects(client.query(down), /rollback blocked: E2EE migration is running or blocked/);
    await client.query("UPDATE content_e2ee_migrations SET state='pending' WHERE user_id=$1", [userA]);

    await client.query(
      `UPDATE content_e2ee_migrations
       SET state='blocked',blocked_at=now(),blocked_reason='key_unavailable',updated_at=now()
       WHERE user_id=$1`,
      [userA],
    );
    await assert.rejects(client.query(down), /rollback blocked: E2EE migration is running or blocked/);
    await client.query(
      "UPDATE content_e2ee_migrations SET state='pending',blocked_at=NULL,blocked_reason=NULL WHERE user_id=$1",
      [userA],
    );

    await client.query("UPDATE content_accounts SET state='migrated' WHERE user_id=$1", [userB]);
    await assert.rejects(client.query(down), /rollback blocked: migrated content account exists/);
    await client.query("UPDATE content_accounts SET state='active' WHERE user_id=$1", [userB]);

    await assert.rejects(
      client.query(
        `DELETE FROM prompt_records
         WHERE id=(SELECT prompt_record_id FROM content_e2ee_migration_sources LIMIT 1)`,
      ),
      /content_e2ee_migration_sources_prompt_record_id_fkey/,
    );

    assert.equal(
      (await client.query("SELECT state FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rows[0].state,
      "pending",
    );

    await client.query(
      `UPDATE prompt_records
       SET encryption_scheme='managed_v1',content_owner_id=NULL,content_key_version=1,
           wrapped_dek=$2,dek_wrap_iv=$3,dek_wrap_auth_tag=$4,iv=$3,
           ciphertext=$5,auth_tag=$4,aad_version=2
       WHERE user_id=$1 AND dedup_key='e2ee-state-source'`,
      [userA, Buffer.alloc(32, 6), Buffer.alloc(12, 7), Buffer.alloc(16, 8), Buffer.from("managed")],
    );
    await assert.rejects(client.query(down), /rollback blocked: converted E2EE content exists/);
    assert.equal(
      (await client.query("SELECT state FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rows[0].state,
      "pending",
    );
    await client.query(
      `UPDATE prompt_records
       SET encryption_scheme='e2ee_v1',content_owner_id=$2,content_key_version=1,
           wrapped_dek=$3,dek_wrap_iv=$4,dek_wrap_auth_tag=$5,iv=$4,
           ciphertext=$6,auth_tag=$5,aad_version=1
       WHERE user_id=$1 AND dedup_key='e2ee-state-source'`,
      [
        userA,
        ownerA,
        Buffer.alloc(32, 9),
        Buffer.alloc(12, 10),
        Buffer.alloc(16, 11),
        Buffer.from("e2ee-restored"),
      ],
    );
    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES('new-managed-row',$1,'codex','assistant',now(),1,$2,$3,$4,$5,
              'managed_v1',1,$3,$5,2)`,
      [
        userA,
        Buffer.alloc(32, 12),
        Buffer.alloc(12, 13),
        Buffer.from("new-managed"),
        Buffer.alloc(16, 14),
      ],
    );
    await client.query(down);

    assert.equal(
      (await client.query("SELECT to_regclass('content_e2ee_migrations') AS name")).rows[0].name,
      null,
    );
    assert.equal(
      (await client.query("SELECT to_regclass('content_e2ee_migration_sources') AS name")).rows[0].name,
      null,
    );
    const removedColumns = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='content_encryption_status'
        AND column_name IN ('e2ee_migration_pending','e2ee_migration_blocked')
    `);
    assert.equal(removedColumns.rowCount, 0);
    await assert.rejects(
      client.query("UPDATE content_accounts SET state='migrated' WHERE user_id=$1", [userA]),
      /content_accounts_state_check/,
    );
    assert.equal(
      (await client.query(
        "SELECT COUNT(*)::int AS count FROM prompt_records WHERE dedup_key='new-managed-row'",
      )).rows[0].count,
      1,
    );
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
