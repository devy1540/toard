import type { IngestAuthResult } from "./ingest-auth";
import { getPool } from "./db";

export type DeviceControlContentMode = "off" | "server_v1" | "e2ee_v1";
export type DeviceControlMutableContentMode = Exclude<DeviceControlContentMode, "e2ee_v1">;
export type DeviceControlCommandType = "collect" | "doctor";
export type DeviceControlCommandStatus =
  | "pending"
  | "claimed"
  | "succeeded"
  | "failed"
  | "expired";

export type DeviceControlCommandResult = {
  commandId: string;
  status: "succeeded" | "failed";
  resultCode: string | null;
};

export type DeviceControlObservationInput = {
  deviceFingerprint: string;
  host: string | null;
  shimVersion: string;
  daemonActive: boolean;
  appliedGeneration: number;
  appliedContentMode: DeviceControlContentMode;
  appliedContentSince: Date | null;
  errorCode: string | null;
  commandResults: DeviceControlCommandResult[];
};

export type DeviceControlSyncResult = {
  desired: {
    generation: number;
    contentMode: DeviceControlContentMode;
    contentSince: Date | null;
  };
  commands: Array<{ id: string; type: DeviceControlCommandType }>;
};

export type DeviceControlView = {
  tokenId: string;
  deviceFingerprint: string;
  host: string | null;
  desiredGeneration: number | null;
  desiredContentMode: DeviceControlContentMode | null;
  appliedGeneration: number | null;
  appliedContentMode: DeviceControlContentMode | null;
  shimVersion: string | null;
  daemonActive: boolean | null;
  lastSyncAt: Date | null;
  errorCode: string | null;
  command: {
    id: string;
    type: DeviceControlCommandType;
    status: DeviceControlCommandStatus;
    resultCode: string | null;
    createdAt: Date;
  } | null;
};

type QueryResult<T> = { rows: T[]; rowCount?: number | null };
export type DeviceControlQueryable = {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
};
export type DeviceControlClient = DeviceControlQueryable & { release(): void };
export type DeviceControlDb = DeviceControlQueryable & {
  connect(): Promise<DeviceControlClient>;
};

const FINGERPRINT = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[a-z0-9_]{1,80}$/;

function assertFingerprint(value: string): void {
  if (!FINGERPRINT.test(value)) throw new Error("invalid device fingerprint");
}

function assertErrorCode(value: string | null): void {
  if (value !== null && !ERROR_CODE.test(value)) throw new Error("invalid error code");
}

async function inTransaction<T>(
  db: DeviceControlDb,
  work: (client: DeviceControlClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deviceBelongsToOwner(
  db: DeviceControlQueryable,
  owner: IngestAuthResult,
  fingerprint: string,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM device_tool_inventory_snapshots
       WHERE user_id = $1 AND ingest_token_id = $2 AND fingerprint = $3
     ) AS exists`,
    [owner.userId, owner.tokenId, fingerprint],
  );
  return result.rows[0]?.exists === true;
}

export type DeviceControlRepository = {
  sync(
    owner: IngestAuthResult,
    observation: DeviceControlObservationInput,
    now?: Date,
  ): Promise<DeviceControlSyncResult | null>;
  setDesiredContentMode(input: {
    actorUserId: string;
    tokenId: string;
    deviceFingerprint: string;
    contentMode: DeviceControlMutableContentMode;
    now?: Date;
  }): Promise<boolean>;
  enqueueCommand(input: {
    actorUserId: string;
    tokenId: string;
    deviceFingerprint: string;
    commandType: DeviceControlCommandType;
    now?: Date;
  }): Promise<string | null>;
  listUserDevices(userId: string): Promise<DeviceControlView[]>;
};

export function createDeviceControlRepository(db: DeviceControlDb): DeviceControlRepository {
  return {
    async sync(owner, observation, now = new Date()) {
      assertFingerprint(observation.deviceFingerprint);
      assertErrorCode(observation.errorCode);
      for (const result of observation.commandResults) assertErrorCode(result.resultCode);
      return inTransaction(db, async (client) => {
        if (!(await deviceBelongsToOwner(client, owner, observation.deviceFingerprint))) return null;

        await client.query(
          `UPDATE device_tool_inventory_snapshots
           SET host = COALESCE($4, '')
           WHERE user_id = $1 AND ingest_token_id = $2 AND fingerprint = $3
             AND host IS DISTINCT FROM COALESCE($4, '')`,
          [
            owner.userId,
            owner.tokenId,
            observation.deviceFingerprint,
            observation.host,
          ],
        );

        for (const result of observation.commandResults) {
          await client.query(
            `UPDATE device_control_commands
             SET status = $1, result_code = $2, completed_at = $3, lease_expires_at = NULL
             WHERE id = $4 AND user_id = $5 AND ingest_token_id = $6
               AND device_fingerprint = $7 AND status = 'claimed'`,
            [
              result.status,
              result.resultCode,
              now,
              result.commandId,
              owner.userId,
              owner.tokenId,
              observation.deviceFingerprint,
            ],
          );
        }

        await client.query(
          `INSERT INTO device_control_observations
             (user_id, ingest_token_id, device_fingerprint, host, shim_version,
              daemon_active, applied_generation, applied_content_mode,
              applied_content_since, error_code, last_sync_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (ingest_token_id, device_fingerprint) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             host = EXCLUDED.host,
             shim_version = EXCLUDED.shim_version,
             daemon_active = EXCLUDED.daemon_active,
             applied_generation = CASE
               WHEN EXCLUDED.applied_generation >= device_control_observations.applied_generation
                 THEN EXCLUDED.applied_generation
               ELSE device_control_observations.applied_generation
             END,
             applied_content_mode = CASE
               WHEN EXCLUDED.applied_generation >= device_control_observations.applied_generation
                 THEN EXCLUDED.applied_content_mode
               ELSE device_control_observations.applied_content_mode
             END,
             applied_content_since = CASE
               WHEN EXCLUDED.applied_generation >= device_control_observations.applied_generation
                 THEN EXCLUDED.applied_content_since
               ELSE device_control_observations.applied_content_since
             END,
             error_code = EXCLUDED.error_code,
             last_sync_at = EXCLUDED.last_sync_at`,
          [
            owner.userId,
            owner.tokenId,
            observation.deviceFingerprint,
            observation.host,
            observation.shimVersion,
            observation.daemonActive,
            observation.appliedGeneration,
            observation.appliedContentMode,
            observation.appliedContentSince,
            observation.errorCode,
            now,
          ],
        );

        await client.query(
          `INSERT INTO device_control_policies
             (user_id, ingest_token_id, device_fingerprint, generation,
              desired_content_mode, desired_content_since)
           VALUES ($1, $2, $3, 1, $4, $5)
           ON CONFLICT (ingest_token_id, device_fingerprint) DO NOTHING`,
          [
            owner.userId,
            owner.tokenId,
            observation.deviceFingerprint,
            observation.appliedContentMode,
            observation.appliedContentSince,
          ],
        );

        await client.query(
          `UPDATE device_control_commands
           SET status = 'expired', result_code = 'command_expired',
               completed_at = $4, lease_expires_at = NULL
           WHERE user_id = $1 AND ingest_token_id = $2 AND device_fingerprint = $3
             AND status IN ('pending', 'claimed') AND expires_at <= $4`,
          [owner.userId, owner.tokenId, observation.deviceFingerprint, now],
        );

        const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
        const claimed = await client.query<{
          id: string;
          command_type: DeviceControlCommandType;
        }>(
          `WITH candidates AS (
             SELECT id
             FROM device_control_commands
             WHERE user_id = $1 AND ingest_token_id = $2 AND device_fingerprint = $3
               AND expires_at > $4
               AND (
                 status = 'pending'
                 OR (status = 'claimed' AND lease_expires_at <= $4)
               )
             ORDER BY created_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 8
           )
           UPDATE device_control_commands command
           SET status = 'claimed',
               claimed_at = COALESCE(command.claimed_at, $4),
               lease_expires_at = $5
           FROM candidates
           WHERE command.id = candidates.id
           RETURNING command.id, command.command_type`,
          [owner.userId, owner.tokenId, observation.deviceFingerprint, now, leaseExpiresAt],
        );

        const policy = await client.query<{
          generation: string | number;
          desired_content_mode: DeviceControlContentMode;
          desired_content_since: Date | string | null;
        }>(
          `SELECT generation, desired_content_mode, desired_content_since
           FROM device_control_policies
           WHERE user_id = $1 AND ingest_token_id = $2 AND device_fingerprint = $3`,
          [owner.userId, owner.tokenId, observation.deviceFingerprint],
        );
        const desired = policy.rows[0];
        if (!desired) throw new Error("device control policy missing after initialization");
        return {
          desired: {
            generation: Number(desired.generation),
            contentMode: desired.desired_content_mode,
            contentSince:
              desired.desired_content_since === null
                ? null
                : new Date(desired.desired_content_since),
          },
          commands: claimed.rows.map((command) => ({
            id: command.id,
            type: command.command_type,
          })),
        };
      });
    },

    async setDesiredContentMode({
      actorUserId,
      tokenId,
      deviceFingerprint,
      contentMode,
      now = new Date(),
    }) {
      assertFingerprint(deviceFingerprint);
      return inTransaction(db, async (client) => {
        const owner = { userId: actorUserId, tokenId };
        if (!(await deviceBelongsToOwner(client, owner, deviceFingerprint))) return false;
        const beforeResult = await client.query<{
          generation: string | number;
          desired_content_mode: DeviceControlContentMode;
          desired_content_since: Date | string | null;
        }>(
          `SELECT generation, desired_content_mode, desired_content_since
           FROM device_control_policies
           WHERE user_id = $1 AND ingest_token_id = $2 AND device_fingerprint = $3
           FOR UPDATE`,
          [actorUserId, tokenId, deviceFingerprint],
        );
        const before = beforeResult.rows[0] ?? null;
        const generation = before ? Number(before.generation) + 1 : 1;
        const contentSince = contentMode === "server_v1" ? now : null;
        await client.query(
          `INSERT INTO device_control_policies
             (user_id, ingest_token_id, device_fingerprint, generation,
              desired_content_mode, desired_content_since, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $1, $7)
           ON CONFLICT (ingest_token_id, device_fingerprint) DO UPDATE SET
             generation = EXCLUDED.generation,
             desired_content_mode = EXCLUDED.desired_content_mode,
             desired_content_since = EXCLUDED.desired_content_since,
             updated_by = EXCLUDED.updated_by,
             updated_at = EXCLUDED.updated_at`,
          [
            actorUserId,
            tokenId,
            deviceFingerprint,
            generation,
            contentMode,
            contentSince,
            now,
          ],
        );
        await client.query(
          `INSERT INTO device_control_audit
             (user_id, actor_user_id, ingest_token_id, device_fingerprint,
              action, before_value, after_value)
           VALUES ($1, $1, $2, $3, 'content_mode_changed', $4::jsonb, $5::jsonb)`,
          [
            actorUserId,
            tokenId,
            deviceFingerprint,
            before ? JSON.stringify(before) : null,
            JSON.stringify({ generation, contentMode, contentSince }),
          ],
        );
        return true;
      });
    },

    async enqueueCommand({
      actorUserId,
      tokenId,
      deviceFingerprint,
      commandType,
      now = new Date(),
    }) {
      assertFingerprint(deviceFingerprint);
      return inTransaction(db, async (client) => {
        const owner = { userId: actorUserId, tokenId };
        if (!(await deviceBelongsToOwner(client, owner, deviceFingerprint))) return null;
        const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
        await client.query(
          `UPDATE device_control_commands
           SET status = 'expired', result_code = 'command_expired',
               completed_at = $4, lease_expires_at = NULL
           WHERE user_id = $1 AND ingest_token_id = $2 AND device_fingerprint = $3
             AND status IN ('pending', 'claimed') AND expires_at <= $4`,
          [actorUserId, tokenId, deviceFingerprint, now],
        );
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO device_control_commands
             (user_id, ingest_token_id, device_fingerprint, command_type,
              created_by, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $1, $5, $6)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [actorUserId, tokenId, deviceFingerprint, commandType, now, expiresAt],
        );
        let id = inserted.rows[0]?.id;
        if (!id) {
          const existing = await client.query<{ id: string }>(
            `SELECT id
             FROM device_control_commands
             WHERE user_id = $1 AND ingest_token_id = $2 AND device_fingerprint = $3
               AND command_type = $4 AND status IN ('pending', 'claimed')
               AND expires_at > $5
             ORDER BY created_at DESC
             LIMIT 1`,
            [actorUserId, tokenId, deviceFingerprint, commandType, now],
          );
          id = existing.rows[0]?.id;
        }
        if (!id) throw new Error("device control command insert failed");
        await client.query(
          `INSERT INTO device_control_audit
             (user_id, actor_user_id, ingest_token_id, device_fingerprint,
              action, after_value)
           VALUES ($1, $1, $2, $3, 'command_created', $4::jsonb)`,
          [
            actorUserId,
            tokenId,
            deviceFingerprint,
            JSON.stringify({ commandId: id, commandType }),
          ],
        );
        return id;
      });
    },

    async listUserDevices(userId) {
      const result = await db.query<{
        ingest_token_id: string;
        fingerprint: string;
        host: string | null;
        desired_generation: string | number | null;
        desired_content_mode: DeviceControlContentMode | null;
        applied_generation: string | number | null;
        applied_content_mode: DeviceControlContentMode | null;
        shim_version: string | null;
        daemon_active: boolean | null;
        last_sync_at: Date | string | null;
        error_code: string | null;
        command_id: string | null;
        command_type: DeviceControlCommandType | null;
        command_status: DeviceControlCommandStatus | null;
        command_result_code: string | null;
        command_created_at: Date | string | null;
      }>(
        `WITH devices AS (
           SELECT DISTINCT ON (ingest_token_id, fingerprint)
             ingest_token_id, fingerprint, NULLIF(host, '') AS host, received_at
           FROM device_tool_inventory_snapshots
           WHERE user_id = $1
           ORDER BY ingest_token_id, fingerprint, received_at DESC
         )
         SELECT d.ingest_token_id, d.fingerprint, d.host,
                p.generation AS desired_generation,
                p.desired_content_mode,
                o.applied_generation,
                o.applied_content_mode,
                o.shim_version,
                o.daemon_active,
                o.last_sync_at,
                o.error_code,
                command.id AS command_id,
                command.command_type,
                command.status AS command_status,
                command.result_code AS command_result_code,
                command.created_at AS command_created_at
         FROM devices d
         LEFT JOIN device_control_policies p
           ON p.user_id = $1
          AND p.ingest_token_id = d.ingest_token_id
          AND p.device_fingerprint = d.fingerprint
         LEFT JOIN device_control_observations o
           ON o.user_id = $1
          AND o.ingest_token_id = d.ingest_token_id
          AND o.device_fingerprint = d.fingerprint
         LEFT JOIN LATERAL (
           SELECT id, command_type,
                  CASE
                    WHEN status IN ('pending', 'claimed') AND expires_at <= now()
                      THEN 'expired'
                    ELSE status
                  END AS status,
                  result_code, created_at
           FROM device_control_commands
           WHERE user_id = $1
             AND ingest_token_id = d.ingest_token_id
             AND device_fingerprint = d.fingerprint
           ORDER BY created_at DESC
           LIMIT 1
         ) command ON true
         ORDER BY d.received_at DESC`,
        [userId],
      );
      return result.rows.map((row) => ({
        tokenId: row.ingest_token_id,
        deviceFingerprint: row.fingerprint,
        host: row.host,
        desiredGeneration:
          row.desired_generation === null ? null : Number(row.desired_generation),
        desiredContentMode: row.desired_content_mode,
        appliedGeneration:
          row.applied_generation === null ? null : Number(row.applied_generation),
        appliedContentMode: row.applied_content_mode,
        shimVersion: row.shim_version,
        daemonActive: row.daemon_active,
        lastSyncAt: row.last_sync_at === null ? null : new Date(row.last_sync_at),
        errorCode: row.error_code,
        command:
          row.command_id &&
          row.command_type &&
          row.command_status &&
          row.command_created_at
            ? {
                id: row.command_id,
                type: row.command_type,
                status: row.command_status,
                resultCode: row.command_result_code,
                createdAt: new Date(row.command_created_at),
              }
            : null,
      }));
    },
  };
}

let repository: DeviceControlRepository | undefined;

export function getDeviceControlRepository(): DeviceControlRepository {
  repository ??= createDeviceControlRepository(getPool());
  return repository;
}
