import type { PoolClient } from "pg";
import { withUserContext } from "./rls";

export type LegacyE2eeCapability = "disabled" | "migration" | "recovery";

export type LegacyGateDb = {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
};

const EXPECTED_FIELDS = ["blocked", "has_account", "has_rows"] as const;

/**
 * 기존 E2EE 데이터의 migration/recovery 필요 여부만 반환한다.
 * 호출자는 반드시 해당 사용자의 RLS transaction 안에 있는 db를 전달해야 한다.
 */
export async function legacyE2eeCapability(
  userId: string,
  db: LegacyGateDb,
): Promise<LegacyE2eeCapability> {
  const result = await db.query(
    `SELECT
       EXISTS(SELECT 1 FROM content_accounts WHERE user_id=$1) AS has_account,
       EXISTS(SELECT 1 FROM prompt_records
              WHERE user_id=$1 AND encryption_scheme='e2ee_v1') AS has_rows,
       EXISTS(SELECT 1 FROM content_e2ee_migrations
              WHERE user_id=$1 AND state='blocked') AS blocked`,
    [userId],
  );
  if (result.rows.length !== 1) throw new Error("LEGACY_E2EE_CAPABILITY_INVALID");
  const row = result.rows[0]!;
  if (
    Object.keys(row).sort().join(",") !== EXPECTED_FIELDS.join(",")
    || typeof row.has_account !== "boolean"
    || typeof row.has_rows !== "boolean"
    || typeof row.blocked !== "boolean"
  ) {
    throw new Error("LEGACY_E2EE_CAPABILITY_INVALID");
  }
  if (!row.has_account) return "disabled";
  if (row.blocked) return "recovery";
  return row.has_rows ? "migration" : "disabled";
}

export async function getLegacyE2eeCapability(userId: string): Promise<LegacyE2eeCapability> {
  return withUserContext(userId, (tx: PoolClient) => legacyE2eeCapability(userId, tx));
}
