import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import {
  clearCredentialAccountLimit,
  consumeCredentialAttempt,
  credentialClientIdentity,
  CredentialRateLimitError,
} from "../apps/web/lib/credential-rate-limit";

const execFileAsync = promisify(execFile);

async function waitForPostgres(connectionString: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await probe.connect();
      await probe.end();
      return;
    } catch {
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL did not become ready");
}

async function migrationUp(): Promise<string> {
  return (await readFile("migrations/1700000052_credential_rate_limits.sql", "utf8"))
    .split("-- Down Migration", 1)[0]!;
}

test("credential rate limit은 공유 PG에서 account/IP/global backoff와 최소 권한을 강제한다", { timeout: 120_000 }, async () => {
  const container = `toard-credential-rate-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let appPool: Pool | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(adminUrl);
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query("CREATE ROLE toard_app LOGIN PASSWORD 'integration-password'");
    await admin.query(await migrationUp());

    appPool = new Pool({
      connectionString: `postgresql://toard_app:integration-password@127.0.0.1:${port}/toard`,
      max: 12,
    });
    const deps = { pool: appPool, secret: "rate-limit-integration-secret" };
    const input = { channel: "login" as const, email: "Admin@Example.com", clientIdentity: "203.0.113.10" };

    for (let attempt = 0; attempt < 5; attempt += 1) await consumeCredentialAttempt(input, deps);
    await assert.rejects(
      consumeCredentialAttempt(input, deps),
      (error: unknown) => error instanceof CredentialRateLimitError && error.retryAfterSeconds === 30,
    );
    await clearCredentialAccountLimit({ channel: "login", email: "admin@example.com" }, deps);
    await consumeCredentialAttempt(input, deps);

    const concurrentInput = { ...input, email: "concurrent@example.com", clientIdentity: "203.0.113.11" };
    const concurrent = await Promise.allSettled(
      Array.from({ length: 8 }, () => consumeCredentialAttempt(concurrentInput, deps)),
    );
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 5);
    assert.equal(concurrent.filter((result) => result.status === "rejected").length, 3);
    const concurrentIpKey = createHmac("sha256", deps.secret)
      .update(`credentials\0ip\0${concurrentInput.clientIdentity}`)
      .digest();
    const concurrentGlobalKey = createHmac("sha256", deps.secret).update("credentials\0global").digest();
    const committedAfterAccountBlock = await admin.query<{ scope: string; attempts: number }>(
      `SELECT scope, attempts FROM credential_rate_limits
        WHERE (scope='ip' AND key_hash=$1) OR (scope='global' AND key_hash=$2)
        ORDER BY scope`,
      [concurrentIpKey, concurrentGlobalKey],
    );
    assert.equal(committedAfterAccountBlock.rows.find((row) => row.scope === "ip")?.attempts, 5);
    assert.equal(committedAfterAccountBlock.rows.find((row) => row.scope === "global")?.attempts, 11);

    for (const [scope, limit, byte] of [["ip", 60, 7], ["global", 300, 8]] as const) {
      const key = Buffer.alloc(32, byte);
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const result = await admin.query<{ is_allowed: boolean }>(
          "SELECT is_allowed FROM consume_credential_rate_limit($1, $2)",
          [scope, key],
        );
        assert.equal(result.rows[0]?.is_allowed, true, `${scope}:${attempt + 1}`);
      }
      const blocked = await admin.query<{ is_allowed: boolean; retry_after_seconds: number }>(
        "SELECT is_allowed, retry_after_seconds FROM consume_credential_rate_limit($1, $2)",
        [scope, key],
      );
      assert.deepEqual(blocked.rows[0], { is_allowed: false, retry_after_seconds: 30 });
    }

    const appGlobalKey = createHmac("sha256", deps.secret).update("credentials\0global").digest();
    const blockedIdentity = "198.51.100.200";
    const appIpKey = createHmac("sha256", deps.secret)
      .update(`credentials\0ip\0${blockedIdentity}`)
      .digest();
    for (let attempt = 0; attempt <= 60; attempt += 1) {
      await admin.query("SELECT * FROM consume_credential_rate_limit('ip', $1)", [appIpKey]);
    }
    const globalBeforeIpFlood = await admin.query<{ attempts: number }>(
      "SELECT attempts FROM credential_rate_limits WHERE scope='global' AND key_hash=$1",
      [appGlobalKey],
    );
    const rowsBeforeIpFlood = await admin.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM credential_rate_limits",
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await assert.rejects(consumeCredentialAttempt({
        channel: "login",
        email: `ip-blocked-${attempt}@example.com`,
        clientIdentity: blockedIdentity,
      }, deps), CredentialRateLimitError);
    }
    const globalAfterIpFlood = await admin.query<{ attempts: number }>(
      "SELECT attempts FROM credential_rate_limits WHERE scope='global' AND key_hash=$1",
      [appGlobalKey],
    );
    const rowsAfterIpFlood = await admin.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM credential_rate_limits",
    );
    assert.deepEqual(globalAfterIpFlood.rows, globalBeforeIpFlood.rows);
    assert.equal(rowsAfterIpFlood.rows[0]?.count, rowsBeforeIpFlood.rows[0]?.count);

    await admin.query(
      `UPDATE credential_rate_limits
          SET attempts=299, blocked_until=NULL, window_started_at=now(), updated_at=now()
        WHERE scope='global' AND key_hash=$1`,
      [appGlobalKey],
    );
    await consumeCredentialAttempt({
      channel: "login", email: "global-last-ok@example.com", clientIdentity: "198.51.100.210",
    }, deps);
    const blockedEmail = "global-threshold-blocked@example.com";
    const blockedClientIdentity = "198.51.100.211";
    await assert.rejects(consumeCredentialAttempt({
      channel: "login", email: blockedEmail, clientIdentity: blockedClientIdentity,
    }, deps), CredentialRateLimitError);
    const rolledBackAccountKey = createHmac("sha256", deps.secret)
      .update(`credentials\0account\0login\0${blockedEmail}`)
      .digest();
    const rolledBackIpKey = createHmac("sha256", deps.secret)
      .update(`credentials\0ip\0${blockedClientIdentity}`)
      .digest();
    const thresholdState = await admin.query<{ scope: string; attempts: number }>(
      `SELECT scope, attempts FROM credential_rate_limits
        WHERE (scope='global' AND key_hash=$1)
           OR (scope='account' AND key_hash=$2)
           OR (scope='ip' AND key_hash=$3)
        ORDER BY scope`,
      [appGlobalKey, rolledBackAccountKey, rolledBackIpKey],
    );
    assert.deepEqual(thresholdState.rows, [{ scope: "global", attempts: 301 }]);
    const beforeBlockedFlood = await admin.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM credential_rate_limits",
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await assert.rejects(
        consumeCredentialAttempt({
          channel: "login",
          email: `blocked-${attempt}@example.com`,
          clientIdentity: `198.51.100.${attempt}`,
        }, deps),
        CredentialRateLimitError,
      );
    }
    const afterBlockedFlood = await admin.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM credential_rate_limits",
    );
    assert.equal(afterBlockedFlood.rows[0]?.count, beforeBlockedFlood.rows[0]?.count);

    await assert.rejects(
      appPool.query("SELECT * FROM credential_rate_limits"),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await assert.rejects(
      appPool.query("SELECT * FROM consume_credential_rate_limit('account', $1)", [Buffer.alloc(32)]),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await assert.rejects(
      appPool.query("SELECT * FROM consume_credential_rate_limits($1, $2, $3)", [
        Buffer.alloc(31), Buffer.alloc(32), Buffer.alloc(32),
      ]),
      (error: unknown) => (error as { code?: string }).code === "22023",
    );
    const publicExecute = await admin.query<{ allowed: boolean }>(`
      SELECT COALESCE(bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'), false) AS allowed
        FROM pg_proc procedure
        CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
       WHERE procedure.oid = 'consume_credential_rate_limits(bytea,bytea,bytea)'::regprocedure`);
    assert.equal(publicExecute.rows[0]?.allowed, false);
    const columns = await admin.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='credential_rate_limits' ORDER BY column_name",
    );
    assert.equal(columns.rows.some((row) => /email|ip/i.test(row.column_name)), false);
    const hashes = await admin.query<{ size: number }>(
      "SELECT DISTINCT octet_length(key_hash)::int AS size FROM credential_rate_limits",
    );
    assert.deepEqual(hashes.rows, [{ size: 32 }]);

    assert.equal(credentialClientIdentity(new Headers({
      "cf-connecting-ip": " 198.51.100.1 ",
      "x-forwarded-for": "203.0.113.1, 203.0.113.2",
    })), "198.51.100.1");
    assert.equal(credentialClientIdentity(new Headers({
      "x-forwarded-for": "203.0.113.1, 203.0.113.2",
    })), "203.0.113.1");
  } finally {
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
