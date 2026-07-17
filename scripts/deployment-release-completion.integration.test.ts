import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { GET } from "../apps/web/app/api/ready/route";
import { LATEST_SCHEMA_VERSION } from "../packages/core/src/deployment-release";

const execFileAsync = promisify(execFile);
const MIGRATION = "migrations/1700000038_deployment_release_completion.sql";
const MARKER_SCRIPT = "scripts/mark-deployment-release-complete.ts";

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

async function migrationUpsBefore38(): Promise<string[]> {
  const names = (await readdir("migrations"))
    .filter((name) => /^(\d+)_.*\.sql$/.test(name) && name < "1700000038")
    .sort();
  return Promise.all(names.map(async (name) => (
    await readFile(`migrations/${name}`, "utf8")
  ).split("-- Down Migration", 1)[0]!));
}

async function bootstrap(container: string, database: string): Promise<void> {
  await execFileAsync("docker", [
    "exec", container, "psql", "-U", "postgres", "-d", database,
    "-v", "app_password=integration-password",
    "-f", "/tmp/bootstrap-app-role.sql",
  ]);
}

function databaseUrl(port: string, database: string, role = "postgres"): string {
  const password = role === "postgres" ? "postgres" : "integration-password";
  return `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
}

async function connect(port: string, database: string, role = "postgres"): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl(port, database, role) });
  await client.connect();
  return client;
}

function releaseEnv(revision: number, token: string) {
  return {
    TOARD_DEPLOYMENT_ID: "toard/toard",
    TOARD_RELEASE_REVISION: String(revision),
    TOARD_RELEASE_TOKEN: token,
    TOARD_EXPECTED_SCHEMA_VERSION: String(LATEST_SCHEMA_VERSION),
  };
}

async function ready(client: Client, env: ReturnType<typeof releaseEnv>): Promise<Response> {
  return GET.withDependencies({
    env,
    getPool: () => client,
    assertLegacyContentKeyReady: async () => undefined,
    getManagedContentRuntime: async () => null,
    getContentEncryptionReadiness: async () => ({
      status: "disabled",
      provider: null,
      keyRef: null,
      fingerprint: null,
      managedRecords: 0,
      lastCheckAt: null,
      errorCode: null,
    }),
    pingClickHouse: async () => undefined,
    getTimezoneRollupReadinessAt: async () => ({
      status: "disabled",
      watermark: null,
      lagSeconds: null,
      pendingJobs: 0,
      legacyFlagMigration: null,
    }),
    getServerVersion: () => "0.0.0",
  })();
}

test("migration 38, marker CLI, exact release readiness는 실제 PG에서 fail-closed 한다", { timeout: 240_000 }, async () => {
  const migration = await readFile(MIGRATION, "utf8");
  const [up = "", down = ""] = migration.split("-- Down Migration");
  const baseUps = await migrationUpsBefore38();
  const container = `toard-release-ready-${randomUUID().slice(0, 8)}`;
  let root: Client | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ]);
    const { stdout: portOutput } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = portOutput.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    await waitForPostgres(databaseUrl(port, "toard"));
    await execFileAsync("docker", [
      "cp", "scripts/bootstrap-app-role.sql", `${container}:/tmp/bootstrap-app-role.sql`,
    ]);
    root = await connect(port, "toard");

    for (const topology of ["role-after", "role-before"] as const) {
      const database = `release_${topology.replace("-", "_")}`;
      await root.query(`CREATE DATABASE ${database}`);
      if (topology === "role-before") await bootstrap(container, database);
      const admin = await connect(port, database);
      let app: Client | null = null;
      try {
        for (const sql of baseUps) await admin.query(sql);
        await admin.query(up);
        if (topology === "role-after") await bootstrap(container, database);
        app = await connect(port, database, "toard_app");

        const columns = (await admin.query<{ column_name: string }>(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='deployment_release_completions'
          ORDER BY column_name`)).rows.map((row) => row.column_name);
        assert.deepEqual(columns, [
          "completed_at", "deployment_id", "expected_schema_version",
          "release_revision", "release_token",
        ]);
        assert.equal((await admin.query(
          "SELECT has_table_privilege('public','deployment_release_completions','SELECT') AS ok",
        )).rows[0].ok, false);
        assert.equal((await admin.query(
          "SELECT has_table_privilege('toard_app','deployment_release_completions','SELECT') AS ok",
        )).rows[0].ok, true);
        for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          assert.equal((await admin.query(
            "SELECT has_table_privilege('toard_app','deployment_release_completions',$1) AS ok",
            [privilege],
          )).rows[0].ok, false, `${topology}:${privilege}`);
        }
        await assert.rejects(
          app.query(`INSERT INTO deployment_release_completions
            (deployment_id,release_revision,release_token,expected_schema_version)
            VALUES('toard/toard',1,$1,$2)`, ["X".repeat(48), LATEST_SCHEMA_VERSION]),
          /permission denied/,
        );

        for (const [deploymentId, revision, token, schema] of [
          ["TOARD/toard", 1, "A".repeat(48), LATEST_SCHEMA_VERSION],
          ["toard/toard", 0, "B".repeat(48), LATEST_SCHEMA_VERSION],
          ["toard/toard", 2, "short", LATEST_SCHEMA_VERSION],
          ["toard/toard", 3, `${"C".repeat(47)}-`, LATEST_SCHEMA_VERSION],
          ["toard/toard", 4, "D".repeat(48), 0],
        ] as const) {
          await assert.rejects(
            admin.query(`INSERT INTO deployment_release_completions
              (deployment_id,release_revision,release_token,expected_schema_version)
              VALUES($1,$2,$3,$4)`, [deploymentId, revision, token, schema]),
            /violates check constraint/,
          );
        }

        if (topology === "role-after") {
          const oldToken = "E".repeat(48);
          const newToken = "F".repeat(48);
          const failedToken = "G".repeat(48);
          assert.equal((await ready(app, releaseEnv(7, oldToken))).status, 503);

          const oldRun = await execFileAsync(
            process.execPath,
            ["--import", "tsx", MARKER_SCRIPT],
            {
              encoding: "utf8",
              env: { ...process.env, DATABASE_URL: databaseUrl(port, database), ...releaseEnv(7, oldToken) },
            },
          ) as { stdout: string; stderr: string };
          assert.equal(oldRun.stdout.includes(oldToken), false);
          assert.equal(oldRun.stderr.includes(oldToken), false);
          assert.equal((await ready(app, releaseEnv(7, "H".repeat(48)))).status, 503);
          assert.equal((await ready(app, releaseEnv(7, oldToken))).status, 200);

          await execFileAsync(process.execPath, ["--import", "tsx", MARKER_SCRIPT], {
            env: { ...process.env, DATABASE_URL: databaseUrl(port, database), ...releaseEnv(8, newToken) },
          });
          assert.equal((await ready(app, releaseEnv(7, oldToken))).status, 200);
          assert.equal((await ready(app, releaseEnv(8, newToken))).status, 200);
          assert.equal((await admin.query(
            "SELECT COUNT(*)::int AS count FROM deployment_release_completions",
          )).rows[0].count, 2);

          await assert.rejects(execFileAsync("sh", ["-c", "exit 9 && pnpm mark:deployment-release"], {
            env: { ...process.env, DATABASE_URL: databaseUrl(port, database), ...releaseEnv(9, failedToken) },
          }));
          assert.equal((await admin.query(
            "SELECT COUNT(*)::int AS count FROM deployment_release_completions WHERE release_revision=9",
          )).rows[0].count, 0);
          assert.equal((await ready(app, releaseEnv(9, failedToken))).status, 503);

          await assert.rejects(admin.query(down), /rollback blocked/);
          await admin.query("DELETE FROM deployment_release_completions");
        }

        await admin.query(down);
        assert.equal((await admin.query(
          "SELECT to_regclass('deployment_release_completions') AS name",
        )).rows[0].name, null);
      } finally {
        await app?.end().catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
    }
  } finally {
    await root?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
