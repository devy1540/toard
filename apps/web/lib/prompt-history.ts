import { decryptContent, loadKek } from "@/lib/content-crypto";
import { withUserContext } from "@/lib/rls";

// 내 프롬프트/응답 히스토리 조회 — 본인 것만(RLS + 명시 WHERE 이중 방어), 서버에서 복호화.
// KEK 미설정이면 본문 수집이 서버에서 꺼진 것 → enabled:false 로 알린다.

export interface PromptHistoryItem {
  dedupKey: string;
  sessionId: string | null;
  providerKey: string;
  role: "user" | "assistant";
  ts: Date;
  text: string;
}

export interface PromptHistory {
  /** 서버에서 본문 수집(KEK)이 설정돼 있는지 */
  enabled: boolean;
  items: PromptHistoryItem[];
}

// pg 제네릭 제약(QueryResultRow) 충족을 위해 interface 가 아니라 type 로 선언.
type Row = {
  dedup_key: string;
  session_id: string | null;
  provider_key: string;
  turn_role: "user" | "assistant";
  ts: Date;
  key_version: number;
  wrapped_dek: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
};

export async function getMyPromptHistory(userId: string, limit = 200): Promise<PromptHistory> {
  let kek: Buffer;
  try {
    kek = loadKek();
  } catch {
    return { enabled: false, items: [] };
  }

  const res = await withUserContext(userId, (tx) =>
    tx.query<Row>(
      `SELECT dedup_key, session_id, provider_key, turn_role, ts,
              key_version, wrapped_dek, iv, ciphertext, auth_tag
       FROM prompt_records
       WHERE user_id = $1
       ORDER BY ts DESC
       LIMIT $2`,
      [userId, limit],
    ),
  );

  const items = res.rows.map((r) => ({
    dedupKey: r.dedup_key,
    sessionId: r.session_id,
    providerKey: r.provider_key,
    role: r.turn_role,
    ts: r.ts,
    text: decryptContent(
      {
        keyVersion: r.key_version,
        wrappedDek: r.wrapped_dek,
        iv: r.iv,
        ciphertext: r.ciphertext,
        authTag: r.auth_tag,
      },
      kek,
    ),
  }));
  return { enabled: true, items };
}
