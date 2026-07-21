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
  const rolcreatedb = Object.getOwnPropertyDescriptor(row, "rolcreatedb");
  const rolcreaterole = Object.getOwnPropertyDescriptor(row, "rolcreaterole");
  const rolreplication = Object.getOwnPropertyDescriptor(row, "rolreplication");
  const sessionUserMatchesCurrentUser = Object.getOwnPropertyDescriptor(
    row,
    "session_user_matches_current_user",
  );
  const hasRoleMemberships = Object.getOwnPropertyDescriptor(row, "has_role_memberships");
  const ownsRlsRelations = Object.getOwnPropertyDescriptor(row, "owns_rls_relations");
  return (
    rolname?.value === "toard_app"
    && rolsuper?.value === false
    && rolbypassrls?.value === false
    && rolcreatedb?.value === false
    && rolcreaterole?.value === false
    && rolreplication?.value === false
    && sessionUserMatchesCurrentUser?.value === true
    && hasRoleMemberships?.value === false
    && ownsRlsRelations?.value === false
  );
}

export async function assertManagedContentDatabaseRoleReady(
  db: ContentDatabaseRoleReadinessDb,
  env: ReadinessEnvironment = process.env,
): Promise<void> {
  if (!managedContentConfigured(env)) return;

  try {
    const result = await db.query(
      `SELECT role.rolname,
              role.rolsuper,
              role.rolbypassrls,
              role.rolcreatedb,
              role.rolcreaterole,
              role.rolreplication,
              session_user = current_user AS session_user_matches_current_user,
              EXISTS (
                SELECT 1
                  FROM pg_roles granted
                 WHERE granted.oid <> role.oid
                   AND pg_has_role(role.oid, granted.oid, 'MEMBER')
              ) AS has_role_memberships,
              EXISTS (
                SELECT 1
                  FROM pg_class relation
                 WHERE relation.relowner = role.oid
                   AND relation.relrowsecurity
              ) AS owns_rls_relations
         FROM pg_roles role
        WHERE rolname = current_user`,
    );
    if (result.rows.length !== 1 || !isSafeRoleRow(result.rows[0])) {
      failUnsafeRole();
    }
  } catch {
    failUnsafeRole();
  }
}
