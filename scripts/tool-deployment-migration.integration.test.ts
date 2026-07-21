import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

async function part(filename: string, direction: "up" | "down"): Promise<string> {
  const sql = await readFile(`migrations/${filename}`, "utf8");
  const [up, down] = sql.split("-- Down Migration", 2);
  return direction === "up" ? up : down;
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try { await probe.connect(); await probe.query("SELECT 1"); await probe.end(); return; }
    catch { await probe.end().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error("PostgreSQL did not become ready");
}

test("도구 배포 migration은 유효한 전체 관계를 저장하고 닫힌 status를 강제한다", { timeout: 90_000 }, async () => {
  const container = `toard-tool-deployment-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    client = new Client({ connectionString });
    await client.connect();
    await client.query(await part("1700000001_init.sql", "up"));
    await client.query("ALTER TABLE departments RENAME TO teams; ALTER TABLE users RENAME COLUMN department_id TO team_id");
    await client.query(await part("1700000019_tool_activity_inventory.sql", "up"));
    await client.query(await part("1700000045_tool_catalog.sql", "up"));
    await client.query(await part("1700000046_tool_deployment.sql", "up"));

    const teamId = randomUUID();
    const userId = randomUUID();
    const tokenId = randomUUID();
    const catalogId = randomUUID();
    await client.query("INSERT INTO teams(id,name) VALUES($1,'Tools')", [teamId]);
    await client.query("INSERT INTO users(id,email,team_id,team_role) VALUES($1,'tools@example.com',$2,'leader')", [userId, teamId]);
    await client.query("INSERT INTO ingest_tokens(id,user_id,token_hash) VALUES($1,$2,$3)", [tokenId, userId, "a".repeat(64)]);
    await client.query(
      `INSERT INTO tool_catalog_items
       (id,slug,name,description,kind,source_url,source_ref,supported_clients,inventory_item_key,inventory_source_provider,owner_user_id)
       VALUES($1,'review','Review','Review skill','skill','https://github.com/acme/review','v1.0.0',ARRAY['codex'],'review','codex',$2)`,
      [catalogId, userId],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO tool_versions
       (catalog_item_id,source_identity,exact_ref,tree_digest,manifest,permission_fingerprint,created_by)
       VALUES($1,'acme/review',$2,$3,'{}',$4,$5) RETURNING id`,
      [catalogId, "b".repeat(40), `sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`, userId],
    );
    const versionId = version.rows[0]!.id;
    const policy = await client.query<{ id: string }>(
      `INSERT INTO team_tool_policies(team_id,catalog_item_id,target_version_id,created_by,updated_by)
       VALUES($1,$2,$3,$4,$4) RETURNING id`, [teamId, catalogId, versionId, userId],
    );
    await client.query(
      `INSERT INTO user_tool_preferences(user_id,catalog_item_id,mode,target_version_id)
       VALUES($1,$2,'install',$3)`, [userId, catalogId, versionId],
    );
    await client.query(
      `INSERT INTO tool_deployment_reports
       (user_id,ingest_token_id,device_fingerprint,catalog_item_id,desired_version_id,status,rollout_id)
       VALUES($1,$2,$3,$4,$5,'queued',$6)`,
      [userId, tokenId, "e".repeat(64), catalogId, versionId, policy.rows[0]!.id],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO tool_deployment_reports(user_id,ingest_token_id,device_fingerprint,catalog_item_id,status)
         VALUES($1,$2,$3,$4,'unknown')`, [userId, tokenId, "f".repeat(64), catalogId],
      ),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
    );

    await client.query(await part("1700000046_tool_deployment.sql", "down"));
    assert.equal((await client.query("SELECT to_regclass('public.tool_versions') AS name")).rows[0].name, null);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='users' AND column_name='team_role'")).rows[0].n, 0);
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
