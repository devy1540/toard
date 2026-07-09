export type UserRole = "member" | "admin";

type QueryResult<T> = {
  rows: T[];
  rowCount?: number | null;
};

type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
};

type DbClient = Queryable & {
  release(): void;
};

export type RolePool = {
  connect(): Promise<DbClient>;
};

export type AssignUserRoleResult =
  | { ok: true }
  | { ok: false; reason: "invalid-role" | "user-not-found" | "last-admin" };

export function parseUserRole(role: string): UserRole | null {
  return role === "admin" || role === "member" ? role : null;
}

export async function assignUserRoleWithPool(
  pool: RolePool,
  userId: string,
  role: string,
): Promise<AssignUserRoleResult> {
  const nextRole = parseUserRole(role);
  if (!nextRole) return { ok: false, reason: "invalid-role" };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const target = await client.query<{ role: string }>("SELECT role FROM users WHERE id = $1 FOR UPDATE", [
      userId,
    ]);
    const row = target.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "user-not-found" };
    }

    if (row.role === "admin" && nextRole === "member") {
      const admins = await client.query<{ id: string }>("SELECT id FROM users WHERE role = 'admin' FOR UPDATE");
      if (admins.rows.length <= 1) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "last-admin" };
      }
    }

    await client.query("UPDATE users SET role = $2 WHERE id = $1", [userId, nextRole]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
