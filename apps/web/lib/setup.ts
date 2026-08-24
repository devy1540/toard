import { createHash, timingSafeEqual } from "node:crypto";
import { getPool } from "./db";

const BOOTSTRAP_LOCK_KEY = "toard:bootstrap-admin";
const MIN_BOOTSTRAP_SETUP_TOKEN_LENGTH = 32;

type QueryResult<T> = {
  rows: T[];
  rowCount?: number | null;
};

export type SetupQueryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
};

type SetupClient = SetupQueryable & {
  release(): void;
};

export type SetupPool = {
  connect(): Promise<SetupClient>;
};

export type CreateFirstAdminInput = {
  email: string;
  name: string;
  passwordHash: string;
};

export type CreateFirstAdminResult =
  | { ok: true; id: string }
  | { ok: false; reason: "admin-exists" | "email-exists" };

function configuredSetupToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const token = env.BOOTSTRAP_SETUP_TOKEN?.trim() ?? "";
  return token.length >= MIN_BOOTSTRAP_SETUP_TOKEN_LENGTH ? token : null;
}

/** 브라우저 setup은 별도 고엔트로피 token이 있을 때만 열린다. */
export function browserSetupConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return configuredSetupToken(env) !== null;
}

/** token 길이를 노출하지 않도록 고정 길이 digest를 상수시간 비교한다. */
export function verifyBootstrapSetupToken(
  candidate: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const expected = configuredSetupToken(env);
  if (!expected) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const candidateDigest = createHash("sha256").update(candidate.trim()).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

/** admin이 존재해야 설치가 초기화된 것으로 간주한다. 일반 member는 setup을 잠그지 않는다. */
export async function hasAdminUser(db: SetupQueryable = getPool()): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * 첫 admin 생성을 PostgreSQL transaction advisory lock으로 직렬화한다.
 * 서로 다른 이메일의 동시 요청도 lock 획득 뒤 admin 존재 여부를 다시 검사하므로 한 건만 성공한다.
 */
export async function createFirstAdmin(
  pool: SetupPool,
  input: CreateFirstAdminInput,
): Promise<CreateFirstAdminResult> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [BOOTSTRAP_LOCK_KEY]);
    if (await hasAdminUser(client)) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return { ok: false, reason: "admin-exists" };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id`,
      [input.email, input.name, input.passwordHash],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("BOOTSTRAP_ADMIN_INSERT_FAILED");
    await client.query("COMMIT");
    transactionOpen = false;
    return { ok: true, id };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, reason: "email-exists" };
    }
    throw error;
  } finally {
    client.release();
  }
}
