import { decryptContent, loadKek } from "@/lib/content-crypto";
import { decryptManagedContent } from "@/lib/managed-content-crypto";
import {
  getManagedContentRuntime,
  type ManagedContentRuntime,
} from "@/lib/managed-content-runtime";
import { withUserContext } from "@/lib/rls";
export { toHistoryPreview } from "@/lib/history-preview";
import { toHistoryPreview } from "@/lib/history-preview";

// 내 프롬프트/응답 히스토리 조회 — 본인 것만(RLS + 명시 WHERE 이중 방어), 서버에서 복호화.
// managed runtime과 legacy KEK가 모두 없을 때만 enabled:false 로 알린다.
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
  contentUnavailable?: boolean;
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
  /** managed runtime 또는 legacy KEK 중 하나라도 복호화 가능한지 */
  enabled: boolean;
  hasManagedContent: boolean;
  hasLegacyContent: boolean;
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

/** 상세 턴 상한 — 복호화 비용 바운드(한 세션이 비정상적으로 길어도 페이지가 죽지 않게) */
export const DETAIL_TURN_LIMIT = 500;
const HISTORY_PAGE_SIZE_LIMIT = 20;

/** managed AAD와 두 암호화 scheme 복호화에 필요한 SELECT 공용 컬럼. */
const CIPHER_COLS = [
  "encryption_scheme",
  "content_key_version",
  "aad_version",
  "key_version",
  "wrapped_dek",
  "dek_wrap_iv",
  "dek_wrap_auth_tag",
  "iv",
  "ciphertext",
  "auth_tag",
  "dedup_key",
  "session_id",
  "provider_key",
  "turn_role",
  "ts",
].join(", ");

type HistoryCipherRow = {
  encryption_scheme: "server_v1" | "managed_v1";
  content_key_version: number | null;
  aad_version: number | null;
  key_version: number;
  wrapped_dek: Buffer;
  dek_wrap_iv: Buffer | null;
  dek_wrap_auth_tag: Buffer | null;
  iv: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  dedup_key: string;
  session_id: string | null;
  provider_key: string;
  turn_role: "user" | "assistant";
  ts: Date;
};

type HistoryDb = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

export type HistoryDependencies = {
  runtime?: ManagedContentRuntime | null;
  legacyKek?: Buffer | null;
  db?: HistoryDb;
};

type ResolvedHistoryDependencies = {
  runtime: ManagedContentRuntime | null;
  legacyKek: Buffer | null;
  db?: HistoryDb;
};

async function resolveHistoryDependencies(
  dependencies: HistoryDependencies,
): Promise<ResolvedHistoryDependencies> {
  let runtime: ManagedContentRuntime | null;
  if (dependencies.runtime !== undefined) {
    runtime = dependencies.runtime;
  } else {
    try {
      runtime = await getManagedContentRuntime();
    } catch {
      runtime = null;
    }
  }

  let legacyKek: Buffer | null;
  if (dependencies.legacyKek !== undefined) {
    legacyKek = dependencies.legacyKek
      ? Buffer.from(dependencies.legacyKek)
      : null;
  } else {
    try {
      legacyKek = loadKek();
    } catch {
      legacyKek = null;
    }
  }
  return { runtime, legacyKek, db: dependencies.db };
}

async function decryptHistoryRow(
  row: HistoryCipherRow,
  userId: string,
  dependencies: ResolvedHistoryDependencies,
): Promise<string | null> {
  try {
    if (row.encryption_scheme === "server_v1") {
      if (!dependencies.legacyKek) return null;
      return decryptContent(
        {
          keyVersion: row.key_version,
          wrappedDek: row.wrapped_dek,
          iv: row.iv,
          ciphertext: row.ciphertext,
          authTag: row.auth_tag,
        },
        dependencies.legacyKek,
      );
    }
    if (
      !dependencies.runtime
      || !Number.isSafeInteger(row.content_key_version)
      || (row.content_key_version ?? 0) < 1
      || row.aad_version !== 2
      || !Buffer.isBuffer(row.dek_wrap_iv)
      || !Buffer.isBuffer(row.dek_wrap_auth_tag)
    ) {
      return null;
    }
    const keyVersion = row.content_key_version!;
    return await dependencies.runtime.userKeys.withUserKeyVersion(
      userId,
      keyVersion,
      (uck) =>
        decryptManagedContent(
          {
            encryptionScheme: "managed_v1",
            contentKeyVersion: keyVersion,
            aadVersion: 2,
            wrappedDek: row.wrapped_dek,
            dekWrapIv: row.dek_wrap_iv!,
            dekWrapAuthTag: row.dek_wrap_auth_tag!,
            iv: row.iv,
            ciphertext: row.ciphertext,
            authTag: row.auth_tag,
            dedupKey: row.dedup_key,
            providerKey: row.provider_key,
            turnRole: row.turn_role,
            ts: row.ts,
          },
          uck,
          dependencies.runtime!.installationId,
          userId,
        ),
    );
  } catch {
    return null;
  }
}

function filterConds(f: HistoryFilter, params: unknown[]): string[] {
  params.push(f.from, f.to);
  const conds = [
    "encryption_scheme IN ('server_v1', 'managed_v1')",
    `ts >= $${params.length - 1}`,
    `ts < $${params.length}`,
  ];
  if (f.providerKey) {
    params.push(f.providerKey);
    conds.push(`provider_key = $${params.length}`);
  }
  return conds;
}

async function runHistoryContext<T>(
  userId: string,
  db: HistoryDb | undefined,
  fn: (tx: HistoryDb) => Promise<T>,
): Promise<T> {
  if (db) return fn(db);
  return withUserContext(userId, (tx) => fn(tx));
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
  dependencies: HistoryDependencies = {},
): Promise<HistorySessionPage> {
  const resolved = await resolveHistoryDependencies(dependencies);
  if (!resolved.runtime && !resolved.legacyKek) {
    return {
      enabled: false,
      hasManagedContent: false,
      hasLegacyContent: false,
      sessions: [],
      totalSessions: 0,
    };
  }
  const boundedPageSize = Math.min(
    HISTORY_PAGE_SIZE_LIMIT,
    Math.max(1, Math.trunc(pageSize) || HISTORY_PAGE_SIZE_LIMIT),
  );
  const boundedPage = Math.max(0, Math.trunc(page) || 0);

  type GroupRow = {
    gkey: string;
    is_session: boolean;
    provider_key: string;
    turn_count: string;
    first_ts: Date;
    latest_ts: Date;
    total_groups: string;
    has_managed_content: boolean;
    has_legacy_content: boolean;
  };
  type PreviewRow = HistoryCipherRow & { gkey: string };

  try {
    const { groups, previews } = await runHistoryContext(userId, resolved.db, async (tx) => {
      const params: unknown[] = [userId];
      const conds = [`user_id = $1`, ...filterConds(filter, params)];
      params.push(boundedPageSize, boundedPage * boundedPageSize);
      const groupsRes = await tx.query(
        `SELECT COALESCE(session_id, dedup_key)   AS gkey,
                BOOL_OR(session_id IS NOT NULL)   AS is_session,
                MIN(provider_key)                 AS provider_key,
                COUNT(*)                          AS turn_count,
                MIN(ts)                           AS first_ts,
                MAX(ts)                           AS latest_ts,
                COUNT(*) OVER ()                  AS total_groups,
                BOOL_OR(encryption_scheme = 'managed_v1') AS has_managed_content,
                BOOL_OR(encryption_scheme = 'server_v1')  AS has_legacy_content
         FROM prompt_records
         WHERE ${conds.join(" AND ")}
         GROUP BY gkey
         ORDER BY latest_ts DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const groups = groupsRes.rows as GroupRow[];

      const keys = groups.map((r) => r.gkey);
      if (keys.length === 0) return { groups, previews: [] as PreviewRow[] };

      // 그룹별 대표 본문 1건 — 첫 user 턴 우선, 없으면 가장 이른 턴.
      // keys 는 최대 20개라 복호화 Promise fan-out도 페이지 경계를 넘지 않는다.
      const pParams: unknown[] = [userId];
      const pConds = [`user_id = $1`, ...filterConds(filter, pParams)];
      pParams.push(keys);
      const previewRes = await tx.query(
        `SELECT DISTINCT ON (COALESCE(session_id, dedup_key))
                COALESCE(session_id, dedup_key) AS gkey, ${CIPHER_COLS}
         FROM prompt_records
         WHERE ${pConds.join(" AND ")}
           AND COALESCE(session_id, dedup_key) = ANY($${pParams.length})
         ORDER BY COALESCE(session_id, dedup_key), (turn_role = 'user') DESC, ts ASC`,
        pParams,
      );
      return { groups, previews: previewRes.rows as PreviewRow[] };
    });

    const previewPairs = await Promise.all(
      previews.map(async (row) => {
        const text = await decryptHistoryRow(row, userId, resolved);
        return [row.gkey, text ? toHistoryPreview(text) : ""] as const;
      }),
    );
    const previewByKey = new Map(previewPairs);
    return {
      enabled: true,
      hasManagedContent: groups.some((group) => group.has_managed_content),
      hasLegacyContent: groups.some((group) => group.has_legacy_content),
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
  } finally {
    resolved.legacyKek?.fill(0);
  }
}

/** 한 세션(그룹)의 전체 턴 — 상세 화면용. 없거나 남의 것이면 null (RLS 가 0건으로 접음). */
export async function getMyHistorySession(
  userId: string,
  key: string,
  dependencies: HistoryDependencies = {},
): Promise<{
  enabled: boolean;
  hasManagedContent: boolean;
  hasLegacyContent: boolean;
  session: HistorySessionDetail | null;
}> {
  const resolved = await resolveHistoryDependencies(dependencies);
  if (!resolved.runtime && !resolved.legacyKek) {
    return {
      enabled: false,
      hasManagedContent: false,
      hasLegacyContent: false,
      session: null,
    };
  }

  try {
    const res = await runHistoryContext(userId, resolved.db, (tx) =>
      tx.query(
        `SELECT ${CIPHER_COLS}
         FROM prompt_records
         WHERE user_id = $1
           AND encryption_scheme IN ('server_v1', 'managed_v1')
           AND (session_id = $2 OR (session_id IS NULL AND dedup_key = $2))
         ORDER BY ts ASC
         LIMIT $3`,
        [userId, key, DETAIL_TURN_LIMIT],
      ),
    );
    const rows = res.rows as HistoryCipherRow[];
    if (rows.length === 0) {
      return {
        enabled: true,
        hasManagedContent: false,
        hasLegacyContent: false,
        session: null,
      };
    }

    const turns = await Promise.all(rows.map(async (row) => {
      const text = await decryptHistoryRow(row, userId, resolved);
      return {
        dedupKey: row.dedup_key,
        sessionId: row.session_id,
        providerKey: row.provider_key,
        role: row.turn_role,
        ts: row.ts,
        text: text ?? "",
        ...(text === null ? { contentUnavailable: true } : {}),
      };
    }));
    const first = turns[0]!;
    return {
      enabled: true,
      hasManagedContent: rows.some((row) => row.encryption_scheme === "managed_v1"),
      hasLegacyContent: rows.some((row) => row.encryption_scheme === "server_v1"),
      session: {
        key,
        isSession: first.sessionId !== null,
        providerKey: first.providerKey,
        turns,
        firstTs: first.ts,
        latestTs: turns[turns.length - 1]!.ts,
      },
    };
  } finally {
    resolved.legacyKek?.fill(0);
  }
}
