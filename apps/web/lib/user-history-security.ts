import { managedContentConfigured } from "./managed-content-runtime";
import { withUserContext } from "./rls";

export type ManagedHistorySecurityState =
  | "disabled"
  | "ready"
  | "protected"
  | "transitioning"
  | "attention";

export type LegacyHistorySecurityState =
  | "pending"
  | "active"
  | "migrating"
  | "blocked"
  | "complete";

export type UserHistorySecurityDb = {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type UserHistorySecurityRunInContext = <T>(
  userId: string,
  action: (db: UserHistorySecurityDb) => Promise<T>,
) => Promise<T>;

export type UserHistorySecurityStatus = {
  managed: {
    configured: boolean;
    state: ManagedHistorySecurityState;
    activeKeyVersion: number | null;
    managedRecords: number;
  };
  legacy: null | {
    state: LegacyHistorySecurityState;
    e2eeRecords: number;
    serverRecords: number;
    recoveryConfirmedAt: Date | null;
    devices: Array<{
      id: string;
      kind: "shim" | "browser";
      label: string;
      platform: string;
      lastUsedAt: Date | null;
    }>;
  };
};

type Options = {
  env?: Readonly<Record<string, string | undefined>>;
  runInContext?: UserHistorySecurityRunInContext;
};

type KeyState = "active" | "pending" | "retiring";
type AccountState = "pending" | "active" | "migrated";
type MigrationState = "pending" | "running" | "blocked" | "complete";

const defaultRunInContext: UserHistorySecurityRunInContext = (userId, action) =>
  withUserContext(userId, (tx) => action(tx as unknown as UserHistorySecurityDb));

function parseCount(value: unknown, field: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || (number as number) < 0) {
    throw new Error(`USER_HISTORY_SECURITY_INVALID_${field.toUpperCase()}`);
  }
  return number as number;
}

function parsePositiveInteger(value: unknown, field: string): number {
  const number = parseCount(value, field);
  if (number < 1) {
    throw new Error(`USER_HISTORY_SECURITY_INVALID_${field.toUpperCase()}`);
  }
  return number;
}

function parseNullableDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`USER_HISTORY_SECURITY_INVALID_${field.toUpperCase()}`);
  }
  return date;
}

function parseNullableState<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`USER_HISTORY_SECURITY_INVALID_${field.toUpperCase()}`);
  }
  return value as T;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`USER_HISTORY_SECURITY_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function managedState(input: {
  configured: boolean;
  keys: Array<{ state: KeyState; keyVersion: number }>;
  managedRecords: number;
}): { state: ManagedHistorySecurityState; activeKeyVersion: number | null } {
  const activeKeys = input.keys.filter((key) => key.state === "active");
  if (activeKeys.length > 1) {
    throw new Error("USER_HISTORY_SECURITY_MULTIPLE_ACTIVE_KEYS");
  }
  const activeKeyVersion = activeKeys[0]?.keyVersion ?? null;

  if (!input.configured && (input.keys.length > 0 || input.managedRecords > 0)) {
    return { state: "attention", activeKeyVersion };
  }
  if (input.keys.some((key) => key.state !== "active")) {
    return { state: "transitioning", activeKeyVersion };
  }
  if (activeKeyVersion !== null) {
    return { state: "protected", activeKeyVersion };
  }
  return {
    state: input.configured ? "ready" : "disabled",
    activeKeyVersion: null,
  };
}

function legacyState(input: {
  accountState: AccountState | null;
  migrationState: MigrationState | null;
  e2eeRecords: number;
  serverRecords: number;
}): LegacyHistorySecurityState {
  if (input.migrationState === "blocked") return "blocked";
  if (
    input.migrationState === "pending"
    || input.migrationState === "running"
    || input.e2eeRecords > 0
    || input.serverRecords > 0
  ) {
    return "migrating";
  }
  if (input.accountState === "pending") return "pending";
  if (input.accountState === "active") return "active";
  return "complete";
}

export async function getUserHistorySecurityStatus(
  userId: string,
  options: Options = {},
): Promise<UserHistorySecurityStatus> {
  const configured = managedContentConfigured(options.env ?? process.env);
  const runInContext = options.runInContext ?? defaultRunInContext;

  return runInContext(userId, async (db) => {
    const keyResult = await db.query(
      `SELECT state, key_version
       FROM managed_content_keys
       WHERE user_id=$1
       ORDER BY key_version ASC`,
      [userId],
    );
    const keys = keyResult.rows.map((row) => ({
      state: parseNullableState(
        row.state,
        ["active", "pending", "retiring"] as const,
        "key_state",
      ) as KeyState,
      keyVersion: parsePositiveInteger(row.key_version, "key_version"),
    }));

    const countResult = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE encryption_scheme='managed_v1')::text AS managed_records,
         COUNT(*) FILTER (WHERE encryption_scheme='e2ee_v1')::text AS e2ee_records,
         COUNT(*) FILTER (WHERE encryption_scheme='server_v1')::text AS server_records
       FROM prompt_records
       WHERE user_id=$1`,
      [userId],
    );
    const countRow = countResult.rows[0];
    if (!countRow) throw new Error("USER_HISTORY_SECURITY_COUNTS_MISSING");
    const managedRecords = parseCount(countRow.managed_records, "managed_records");
    const e2eeRecords = parseCount(countRow.e2ee_records, "e2ee_records");
    const serverRecords = parseCount(countRow.server_records, "server_records");

    const accountResult = await db.query(
      `SELECT
         account.state AS account_state,
         account.recovery_confirmed_at,
         migration.state AS migration_state
       FROM (SELECT $1::uuid AS user_id) requested
       LEFT JOIN content_accounts account ON account.user_id=requested.user_id
       LEFT JOIN content_e2ee_migrations migration ON migration.user_id=requested.user_id`,
      [userId],
    );
    const accountRow = accountResult.rows[0];
    if (!accountRow) throw new Error("USER_HISTORY_SECURITY_ACCOUNT_MISSING");
    const accountState = parseNullableState(
      accountRow.account_state,
      ["pending", "active", "migrated"] as const,
      "account_state",
    );
    const migrationState = parseNullableState(
      accountRow.migration_state,
      ["pending", "running", "blocked", "complete"] as const,
      "migration_state",
    );
    const recoveryConfirmedAt = parseNullableDate(
      accountRow.recovery_confirmed_at,
      "recovery_confirmed_at",
    );

    const managed = managedState({ configured, keys, managedRecords });
    const hasLegacy = accountState === "pending"
      || accountState === "active"
      || e2eeRecords > 0
      || serverRecords > 0
      || (migrationState !== null && migrationState !== "complete");

    if (!hasLegacy) return { managed: { configured, ...managed, managedRecords }, legacy: null };

    const deviceResult = await db.query(
      `SELECT id, kind, label, platform, last_used_at
       FROM content_devices
       WHERE user_id=$1 AND approved_at IS NOT NULL AND revoked_at IS NULL
       ORDER BY created_at ASC`,
      [userId],
    );
    const devices = deviceResult.rows.map((row) => {
      const kind = parseNullableState(
        row.kind,
        ["shim", "browser"] as const,
        "device_kind",
      );
      if (kind === null) throw new Error("USER_HISTORY_SECURITY_INVALID_DEVICE_KIND");
      return {
        id: requireString(row.id, "device_id"),
        kind,
        label: requireString(row.label, "device_label"),
        platform: requireString(row.platform, "device_platform"),
        lastUsedAt: parseNullableDate(row.last_used_at, "device_last_used_at"),
      };
    });

    return {
      managed: { configured, ...managed, managedRecords },
      legacy: {
        state: legacyState({ accountState, migrationState, e2eeRecords, serverRecords }),
        e2eeRecords,
        serverRecords,
        recoveryConfirmedAt,
        devices,
      },
    };
  });
}
