import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { createFirstAdmin, hasAdminUser } from "../apps/web/lib/setup";

const execFileAsync = promisify(execFile);

async function migrationUp(filename: string): Promise<string> {
  return (await readFile(`migrations/${filename}`, "utf8")).split("-- Down Migration", 1)[0]!;
}

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

test("member 선점은 setup을 잠그지 않고 동시 setup은 admin 한 명만 만든다", { timeout: 90_000 }, async () => {
  const container = `toard-bootstrap-setup-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let pool: Pool | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);

    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(await migrationUp("1700000001_init.sql"));
    await admin.query(await migrationUp("1700000005_user_password.sql"));
    await admin.query(
      "INSERT INTO users(email,name,password_hash,role) VALUES('member@example.com','Member','hash','member')",
    );
    assert.equal(await hasAdminUser(admin), false, "member must not complete bootstrap");

    pool = new Pool({ connectionString, max: 4 });
    const [first, second] = await Promise.all([
      createFirstAdmin(pool, {
        email: "first-admin@example.com",
        name: "First",
        passwordHash: "hash-1",
      }),
      createFirstAdmin(pool, {
        email: "second-admin@example.com",
        name: "Second",
        passwordHash: "hash-2",
      }),
    ]);

    assert.equal([first, second].filter((result) => result.ok).length, 1);
    assert.equal(
      [first, second].filter((result) => !result.ok && result.reason === "admin-exists").length,
      1,
    );
    const users = await admin.query<{ role: string; count: number }>(
      "SELECT role, COUNT(*)::int AS count FROM users GROUP BY role ORDER BY role",
    );
    assert.deepEqual(users.rows, [
      { role: "admin", count: 1 },
      { role: "member", count: 1 },
    ]);
  } finally {
    await pool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
