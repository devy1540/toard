import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { Client, Pool } from "pg";

const exec = promisify(execFile);

/** An isolated, loopback-only, tmpfs database. Never reads deployment credentials. */
export async function startTestPostgres(prefix: string, options: { beforeMigration?: string } = {}) {
  const container = `toard-test-${prefix}-${randomUUID().slice(0, 8)}`;
  const password = randomUUID();
  let started = false;
  let pool: Pool | undefined;
  const close = async () => {
    await pool?.end();
    if (started) {
      await exec("docker", ["stop", "--time", "5", container]);
      started = false;
    }
  };
  try {
    await exec("docker", [
      "run", "-d", "--rm", "--name", container,
      "--tmpfs", "/var/lib/postgresql/data",
      "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=toard_test",
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ], { env: { ...process.env, POSTGRES_PASSWORD: password } });
    started = true;
    const { stdout } = await exec("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("TEST_POSTGRES_PORT_MISSING");
    const connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/toard_test`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
      try {
        await probe.connect();
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      } finally {
        await probe.end().catch(() => undefined);
      }
      if (ready) break;
    }
    if (!ready) throw new Error("TEST_POSTGRES_NOT_READY");
    pool = new Pool({ connectionString, max: 5 });
    if (options.beforeMigration) {
      const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql") && name < options.beforeMigration!).sort();
      for (const file of files) {
        const up = (await readFile(`migrations/${file}`, "utf8")).split("-- Down Migration", 1)[0]!;
        await pool.query(up);
      }
    } else {
      await exec("pnpm", ["migrate"], { env: { ...process.env, DATABASE_URL: connectionString }, maxBuffer: 4 * 1024 * 1024 });
    }
    return { pool, connectionString, close };
  } catch (error) {
    await close();
    throw error;
  }
}
