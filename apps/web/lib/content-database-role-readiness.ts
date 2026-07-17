import { managedContentConfigured } from "./managed-content-runtime";

export type ContentDatabaseRoleReadinessDb = {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
};

type ReadinessEnvironment = Readonly<Record<string, string | undefined>>;

const UNSAFE_ROLE_ERROR = "MANAGED_CONTENT_DATABASE_ROLE_UNSAFE";

function failUnsafeRole(): never {
  throw new Error(UNSAFE_ROLE_ERROR);
}

function isSafeRoleRow(value: unknown): boolean {
  if (
    typeof value !== "object"
    || value === null
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const row = value as Record<string, unknown>;
  const rolname = Object.getOwnPropertyDescriptor(row, "rolname");
  const rolsuper = Object.getOwnPropertyDescriptor(row, "rolsuper");
  const rolbypassrls = Object.getOwnPropertyDescriptor(row, "rolbypassrls");
  return (
    typeof rolname?.value === "string"
    && rolname.value.length > 0
    && rolsuper?.value === false
    && rolbypassrls?.value === false
  );
}

export async function assertManagedContentDatabaseRoleReady(
  db: ContentDatabaseRoleReadinessDb,
  env: ReadinessEnvironment = process.env,
): Promise<void> {
  if (!managedContentConfigured(env)) return;

  try {
    const result = await db.query(
      `SELECT rolname, rolsuper, rolbypassrls
         FROM pg_roles
        WHERE rolname = current_user`,
    );
    if (result.rows.length !== 1 || !isSafeRoleRow(result.rows[0])) {
      failUnsafeRole();
    }
  } catch {
    failUnsafeRole();
  }
}
