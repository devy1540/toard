import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { postDeviceControlSyncResponse } from "../apps/web/lib/device-control-api";
import {
  createDeviceControlRepository,
  type DeviceControlDb,
} from "../apps/web/lib/device-control-repository";

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
    try {
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      return;
    } catch {
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL did not become ready");
}

function postgresConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["23505", "23514"].includes(String(error.code))
  );
}

test(
  "기기 제어 migration은 target 소유 관계, allow-list command, 단일 active lease를 강제한다",
  { timeout: 90_000 },
  async () => {
    const container = `toard-device-control-${randomUUID().slice(0, 8)}`;
    let client: Client | null = null;
    let pool: Pool | null = null;
    try {
      await execFileAsync("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        container,
        "-e",
        "POSTGRES_PASSWORD=postgres",
        "-e",
        "POSTGRES_DB=toard",
        "-p",
        "127.0.0.1::5432",
        "postgres:16-alpine",
      ]);
      const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
      const port = stdout.trim().match(/:(\d+)$/)?.[1];
      assert.ok(port);
      const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
      await waitForPostgres(connectionString);
      client = new Client({ connectionString });
      await client.connect();
      await client.query(await part("1700000001_init.sql", "up"));
      await client.query(await part("1700000019_tool_activity_inventory.sql", "up"));
      await client.query(await part("1700000050_device_control.sql", "up"));

      const departmentId = randomUUID();
      const userId = randomUUID();
      const tokenId = randomUUID();
      const fingerprint = "a".repeat(64);
      await client.query("INSERT INTO departments(id,name) VALUES($1,'Control')", [departmentId]);
      await client.query(
        "INSERT INTO users(id,email,department_id) VALUES($1,'control@example.com',$2)",
        [userId, departmentId],
      );
      await client.query(
        "INSERT INTO ingest_tokens(id,user_id,token_hash) VALUES($1,$2,$3)",
        [tokenId, userId, "b".repeat(64)],
      );
      await client.query(
        `INSERT INTO device_tool_inventory_snapshots
           (user_id, ingest_token_id, host, fingerprint, observed_at)
         VALUES($1,$2,'box',$3,now())`,
        [userId, tokenId, fingerprint],
      );
      await client.query(
        `INSERT INTO device_control_policies
         (user_id, ingest_token_id, device_fingerprint, generation, desired_content_mode, updated_by)
         VALUES($1,$2,$3,1,'e2ee_v1',$1)`,
        [userId, tokenId, fingerprint],
      );
      await client.query(
        `INSERT INTO device_control_observations
           (user_id, ingest_token_id, device_fingerprint, shim_version, daemon_active,
            applied_generation, applied_content_mode)
         VALUES($1,$2,$3,'0.15.51',true,1,'e2ee_v1')`,
        [userId, tokenId, fingerprint],
      );
      const command = await client.query<{ id: string }>(
        `INSERT INTO device_control_commands
           (user_id, ingest_token_id, device_fingerprint, command_type, created_by)
         VALUES($1,$2,$3,'collect',$1)
         RETURNING id`,
        [userId, tokenId, fingerprint],
      );
      assert.equal(command.rowCount, 1);

      await assert.rejects(
        client.query(
          `INSERT INTO device_control_commands
             (user_id, ingest_token_id, device_fingerprint, command_type, created_by)
           VALUES($1,$2,$3,'shell',$1)`,
          [userId, tokenId, fingerprint],
        ),
        postgresConstraint,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO device_control_commands
             (user_id, ingest_token_id, device_fingerprint, command_type, created_by)
           VALUES($1,$2,$3,'collect',$1)`,
          [userId, tokenId, fingerprint],
        ),
        postgresConstraint,
      );
      await client.query(
        "UPDATE device_control_commands SET status='succeeded', completed_at=now() WHERE id=$1",
        [command.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO device_control_commands
           (user_id, ingest_token_id, device_fingerprint, command_type, created_by)
         VALUES($1,$2,$3,'collect',$1)`,
        [userId, tokenId, fingerprint],
      );

      pool = new Pool({ connectionString, max: 1 });
      const repository = createDeviceControlRepository(pool as unknown as DeviceControlDb);
      const dependencies = {
        async authenticate(value: string | null) {
          return value === "Bearer integration-token" ? { userId, tokenId } : null;
        },
        sync: repository.sync,
      };
      const sync = (body: Record<string, unknown>) =>
        postDeviceControlSyncResponse(
          new Request("http://localhost/api/v1/device-control/sync", {
            method: "POST",
            headers: {
              authorization: "Bearer integration-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              schemaVersion: 1,
              deviceFingerprint: fingerprint,
              host: "box",
              shimVersion: "0.15.51",
              daemonActive: true,
              appliedGeneration: 1,
              appliedContentMode: "e2ee_v1",
              appliedContentSince: "1970-01-01T00:00:00.000Z",
              errorCode: null,
              commandResults: [],
              ...body,
            }),
          }),
          dependencies,
        );

      assert.equal((await sync({})).status, 200);
      assert.equal(
        await repository.setDesiredContentMode({
          actorUserId: userId,
          tokenId,
          deviceFingerprint: fingerprint,
          contentMode: "server_v1",
        }),
        true,
      );
      assert.ok(
        await repository.enqueueCommand({
          actorUserId: userId,
          tokenId,
          deviceFingerprint: fingerprint,
          commandType: "doctor",
        }),
      );
      const claimedResponse = await sync({});
      assert.equal(claimedResponse.status, 200);
      const claimed = (await claimedResponse.json()) as {
        desired: { generation: number; contentMode: string };
        commands: Array<{ id: string; type: string }>;
      };
      assert.equal(claimed.desired.generation, 2);
      assert.equal(claimed.desired.contentMode, "server_v1");
      assert.equal(claimed.commands.length, 1);
      assert.equal(claimed.commands[0]!.type, "doctor");

      const reported = await sync({
        appliedGeneration: 2,
        appliedContentMode: "server_v1",
        appliedContentSince: claimed.desired.generation
          ? new Date().toISOString()
          : null,
        commandResults: [
          {
            commandId: claimed.commands[0]!.id,
            status: "succeeded",
            resultCode: null,
          },
        ],
      });
      assert.equal(reported.status, 200);
      assert.equal(
        (
          await client.query(
            "SELECT status FROM device_control_commands WHERE id=$1",
            [claimed.commands[0]!.id],
          )
        ).rows[0]!.status,
        "succeeded",
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT applied_generation::int AS generation, applied_content_mode AS mode
             FROM device_control_observations
             WHERE ingest_token_id=$1 AND device_fingerprint=$2`,
            [tokenId, fingerprint],
          )
        ).rows[0],
        { generation: 2, mode: "server_v1" },
      );
      await pool.end();
      pool = null;

      await client.query(await part("1700000050_device_control.sql", "down"));
      for (const table of [
        "device_control_policies",
        "device_control_observations",
        "device_control_commands",
        "device_control_audit",
      ]) {
        assert.equal(
          (await client.query("SELECT to_regclass($1) AS name", [`public.${table}`])).rows[0]
            .name,
          null,
        );
      }
    } finally {
      await pool?.end().catch(() => undefined);
      await client?.end().catch(() => undefined);
      await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
    }
  },
);
