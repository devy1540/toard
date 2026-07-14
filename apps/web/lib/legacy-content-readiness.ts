export type LegacyContentReadinessDb = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

export class LegacyContentReadinessError extends Error {
  constructor(readonly code: string, readonly legacyRecords: number) {
    super(code);
    this.name = "LegacyContentReadinessError";
  }
}

export function legacyKekConfigured(env: Record<string, string | undefined>): boolean {
  const raw = env.TOARD_CONTENT_KEK_B64;
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch {
    return false;
  }
}

export async function assertLegacyContentKeyReady(
  db: LegacyContentReadinessDb,
  env: Record<string, string | undefined>,
): Promise<void> {
  const result = await db.query(
    `SELECT legacy_records::text AS legacy_records
       FROM content_legacy_retirement WHERE singleton=TRUE`,
  );
  const legacyRecords = Number(result.rows[0]?.legacy_records);
  if (!Number.isSafeInteger(legacyRecords) || legacyRecords < 0) {
    throw new LegacyContentReadinessError("INVALID_LEGACY_COUNT", 0);
  }
  if (legacyRecords > 0 && !legacyKekConfigured(env)) {
    throw new LegacyContentReadinessError("LEGACY_CONTENT_KEY_MISSING", legacyRecords);
  }
}
