import { encryptContent } from "@/lib/content-crypto";
import { withUserContext } from "@/lib/rls";
import type { PromptRecordWire } from "@/lib/prompt-wire";

// prompt_records 멱등 저장 (설계: RLS + at-rest 트랙).
// 각 레코드 본문을 서버에서 봉투 암호화한 뒤, RLS 컨텍스트(소유자=userId) 안에서 INSERT.
// dedup_key 충돌은 무시(멱등) — shim 재수집/레이스가 겹쳐도 안전.

export async function savePromptRecords(
  userId: string,
  records: PromptRecordWire[],
  kek: Buffer,
): Promise<{ inserted: number; deduped: number }> {
  if (records.length === 0) return { inserted: 0, deduped: 0 };
  let inserted = 0;
  await withUserContext(userId, async (tx) => {
    for (const r of records) {
      const enc = encryptContent(r.text, kek);
      const res = await tx.query(
        `INSERT INTO prompt_records
           (dedup_key, user_id, session_id, provider_key, turn_role, ts,
            key_version, wrapped_dek, iv, ciphertext, auth_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [
          r.dedupKey,
          userId,
          r.sessionId,
          r.providerKey,
          r.turnRole,
          r.ts,
          enc.keyVersion,
          enc.wrappedDek,
          enc.iv,
          enc.ciphertext,
          enc.authTag,
        ],
      );
      inserted += res.rowCount ?? 0;
    }
  });
  return { inserted, deduped: records.length - inserted };
}
