import { decryptContent, loadKek } from "@/lib/content-crypto";
import { withUserContext } from "@/lib/rls";

// 내 프롬프트/응답 히스토리 조회 — 본인 것만(RLS + 명시 WHERE 이중 방어), 서버에서 복호화.
// KEK 미설정이면 본문 수집이 서버에서 꺼진 것 → enabled:false 로 알린다.
//
// 화면은 목록(세션 요약, 페이지 단위)과 상세(한 세션의 전체 턴)로 분리:
// 그룹핑·페이지네이션은 SQL 에서 끝내고, 복호화는 화면에 실제로 보이는 행만 한다.
// 그룹 키 = session_id, 세션 없는 solo 턴은 자기 dedup_key(sha256 hex — UUID 와 충돌 없음).

export interface PromptHistoryItem {
  dedupKey: string;
  sessionId: string | null;
  providerKey: string;
  role: "user" | "assistant";
  ts: Date;
  text: string;
}

export interface HistoryFilter {
  /** UTC, inclusive */
  from: Date;
  /** UTC, exclusive */
  to: Date;
  /** 미지정 = 전체 프로바이더 */
  providerKey?: string;
}

export interface HistorySessionSummary {
  /** 그룹 키 — session_id, 세션 없는 solo 턴은 dedup_key */
  key: string;
  /** session_id 기반 그룹인지 (usage 조인 가능 여부) */
  isSession: boolean;
  providerKey: string;
  /** 첫 프롬프트(없으면 첫 턴) 본문 앞부분 — 한 줄 미리보기 */
  preview: string;
  turnCount: number;
  firstTs: Date;
  latestTs: Date;
}

export interface HistorySessionPage {
  /** 서버에서 본문 수집(KEK)이 설정돼 있는지 */
  enabled: boolean;
  sessions: HistorySessionSummary[];
  /** 필터에 걸린 전체 세션(그룹) 수 — 페이지네이션용 */
  totalSessions: number;
}

export interface HistorySessionDetail {
  key: string;
  isSession: boolean;
  providerKey: string;
  /** ts 오름차순(프롬프트→응답) */
  turns: PromptHistoryItem[];
  firstTs: Date;
  latestTs: Date;
}

const PREVIEW_CHARS = 200;
/** 상세 턴 상한 — 복호화 비용 바운드(한 세션이 비정상적으로 길어도 페이지가 죽지 않게) */
export const DETAIL_TURN_LIMIT = 500;

/** 복호화 산출물 컬럼 (SELECT 공용) */
const CIPHER_COLS = "key_version, wrapped_dek, iv, ciphertext, auth_tag";

type CipherRow = {
  key_version: number;
  wrapped_dek: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
};

function decryptRow(r: CipherRow, kek: Buffer): string {
  return decryptContent(
    {
      keyVersion: r.key_version,
      wrappedDek: r.wrapped_dek,
      iv: r.iv,
      ciphertext: r.ciphertext,
      authTag: r.auth_tag,
    },
    kek,
  );
}

/** 미리보기용 한 줄 축약 — 개행·연속 공백을 접고 앞부분만 */
function toPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}…` : oneLine;
}

function filterConds(f: HistoryFilter, params: unknown[]): string[] {
  params.push(f.from, f.to);
  const conds = [`ts >= $${params.length - 1}`, `ts < $${params.length}`];
  if (f.providerKey) {
    params.push(f.providerKey);
    conds.push(`provider_key = $${params.length}`);
  }
  return conds;
}

/**
 * 세션(그룹) 목록 — 최근 대화가 위로. 그룹핑·정렬·페이지는 SQL, 미리보기 복호화는
 * 페이지에 실제 노출되는 그룹 수(pageSize)만큼만.
 */
export async function getMyHistorySessions(
  userId: string,
  filter: HistoryFilter,
  page: number,
  pageSize = 20,
): Promise<HistorySessionPage> {
  let kek: Buffer;
  try {
    kek = loadKek();
  } catch {
    return { enabled: false, sessions: [], totalSessions: 0 };
  }

  type GroupRow = {
    gkey: string;
    is_session: boolean;
    provider_key: string;
    turn_count: string;
    first_ts: Date;
    latest_ts: Date;
    total_groups: string;
  };
  type PreviewRow = CipherRow & { gkey: string };

  const { groups, previews } = await withUserContext(userId, async (tx) => {
    const params: unknown[] = [userId];
    const conds = [`user_id = $1`, ...filterConds(filter, params)];
    params.push(pageSize, page * pageSize);
    const groupsRes = await tx.query<GroupRow>(
      `SELECT COALESCE(session_id, dedup_key)   AS gkey,
              BOOL_OR(session_id IS NOT NULL)   AS is_session,
              MIN(provider_key)                 AS provider_key,
              COUNT(*)                          AS turn_count,
              MIN(ts)                           AS first_ts,
              MAX(ts)                           AS latest_ts,
              COUNT(*) OVER ()                  AS total_groups
       FROM prompt_records
       WHERE ${conds.join(" AND ")}
       GROUP BY gkey
       ORDER BY latest_ts DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const keys = groupsRes.rows.map((r) => r.gkey);
    if (keys.length === 0) return { groups: groupsRes.rows, previews: [] as PreviewRow[] };

    // 그룹별 대표 본문 1건 — 첫 user 턴 우선, 없으면 가장 이른 턴. 필터를 동일 적용해
    // 목록의 그룹 구성과 미리보기 후보가 항상 같은 집합에서 나오게 한다.
    const pParams: unknown[] = [userId];
    const pConds = [`user_id = $1`, ...filterConds(filter, pParams)];
    pParams.push(keys);
    const previewRes = await tx.query<PreviewRow>(
      `SELECT DISTINCT ON (COALESCE(session_id, dedup_key))
              COALESCE(session_id, dedup_key) AS gkey, ${CIPHER_COLS}
       FROM prompt_records
       WHERE ${pConds.join(" AND ")} AND COALESCE(session_id, dedup_key) = ANY($${pParams.length})
       ORDER BY COALESCE(session_id, dedup_key), (turn_role = 'user') DESC, ts ASC`,
      pParams,
    );
    return { groups: groupsRes.rows, previews: previewRes.rows };
  });

  const previewByKey = new Map(previews.map((r) => [r.gkey, toPreview(decryptRow(r, kek))]));
  return {
    enabled: true,
    totalSessions: groups.length > 0 ? Number(groups[0]!.total_groups) : 0,
    sessions: groups.map((g) => ({
      key: g.gkey,
      isSession: g.is_session,
      providerKey: g.provider_key,
      preview: previewByKey.get(g.gkey) ?? "",
      turnCount: Number(g.turn_count),
      firstTs: g.first_ts,
      latestTs: g.latest_ts,
    })),
  };
}

/** 한 세션(그룹)의 전체 턴 — 상세 화면용. 없거나 남의 것이면 null (RLS 가 0건으로 접음). */
export async function getMyHistorySession(
  userId: string,
  key: string,
): Promise<{ enabled: boolean; session: HistorySessionDetail | null }> {
  let kek: Buffer;
  try {
    kek = loadKek();
  } catch {
    return { enabled: false, session: null };
  }

  type Row = CipherRow & {
    dedup_key: string;
    session_id: string | null;
    provider_key: string;
    turn_role: "user" | "assistant";
    ts: Date;
  };
  const res = await withUserContext(userId, (tx) =>
    tx.query<Row>(
      `SELECT dedup_key, session_id, provider_key, turn_role, ts, ${CIPHER_COLS}
       FROM prompt_records
       WHERE user_id = $1
         AND (session_id = $2 OR (session_id IS NULL AND dedup_key = $2))
       ORDER BY ts ASC
       LIMIT $3`,
      [userId, key, DETAIL_TURN_LIMIT],
    ),
  );
  if (res.rows.length === 0) return { enabled: true, session: null };

  const turns = res.rows.map((r) => ({
    dedupKey: r.dedup_key,
    sessionId: r.session_id,
    providerKey: r.provider_key,
    role: r.turn_role,
    ts: r.ts,
    text: decryptRow(r, kek),
  }));
  const first = turns[0]!;
  return {
    enabled: true,
    session: {
      key,
      isSession: first.sessionId !== null,
      providerKey: first.providerKey,
      turns,
      firstTs: first.ts,
      latestTs: turns[turns.length - 1]!.ts,
    },
  };
}
