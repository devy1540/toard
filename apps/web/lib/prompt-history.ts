import { createHash } from "node:crypto";
import { decryptContent, loadKek } from "@/lib/content-crypto";
import {
  decodeHistorySearchCursor,
  encodeHistorySearchCursor,
  type HistorySearchCursorState,
  type HistorySearchPosition,
} from "@/lib/history-search-cursor";
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
  agent?: PromptHistoryAgent | null;
}

export interface PromptHistoryAgent {
  id: string;
  parentId: string | null;
  depth: number | null;
  name: string | null;
  role: string | null;
}

export interface HistoryFilter {
  /** UTC, inclusive */
  from: Date;
  /** UTC, exclusive */
  to: Date;
  /** 미지정 = 전체 프로바이더 */
  providerKey?: string;
  /** 미지정 = 메인·서브에이전트 전체 */
  agentScope?: "main" | "subagent";
  /** 검색 커서가 같은 기간 선택인지 판별하는 안정적인 URL 범위 식별자. */
  searchRangeKey?: string;
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
  subagentCount: number;
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

export interface HistorySearchPage {
  enabled: boolean;
  hasManagedContent: boolean;
  hasLegacyContent: boolean;
  sessions: HistorySessionSummary[];
  /** 다음 검색 구간. null이면 현재 조건의 남은 세션을 모두 확인했다. */
  nextCursor: string | null;
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
const HISTORY_SEARCH_QUERY_LIMIT = 200;
const HISTORY_SEARCH_GROUP_BATCH_SIZE = 20;
const HISTORY_SEARCH_GROUP_SCAN_LIMIT = 20;
const HISTORY_SEARCH_ROW_CHUNK_SIZE = 25;
const HISTORY_SEARCH_ROW_SCAN_LIMIT = 500;
const HISTORY_SEARCH_CIPHERTEXT_BYTE_LIMIT = 16 * 1024 * 1024;
const HISTORY_SEARCH_TIME_LIMIT_MS = 2_000;

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
  "agent_id",
  "parent_agent_id",
  "agent_depth",
  "agent_name",
  "agent_role",
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
  agent_id: string | null;
  parent_agent_id: string | null;
  agent_depth: number | null;
  agent_name: string | null;
  agent_role: string | null;
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

async function decryptHistoryRows(
  rows: readonly HistoryCipherRow[],
  userId: string,
  dependencies: ResolvedHistoryDependencies,
  managedKeyCache?: Map<number, Buffer>,
): Promise<Array<string | null>> {
  const plaintexts = rows.map(() => null as string | null);
  const managedByVersion = new Map<
    number,
    Array<{ index: number; row: HistoryCipherRow }>
  >();

  rows.forEach((row, index) => {
    if (row.encryption_scheme === "server_v1") {
      if (!dependencies.legacyKek) return;
      try {
        plaintexts[index] = decryptContent(
          {
            keyVersion: row.key_version,
            wrappedDek: row.wrapped_dek,
            iv: row.iv,
            ciphertext: row.ciphertext,
            authTag: row.auth_tag,
          },
          dependencies.legacyKek,
        );
      } catch {
        plaintexts[index] = null;
      }
      return;
    }
    if (
      row.encryption_scheme !== "managed_v1"
      || !dependencies.runtime
      || !Number.isSafeInteger(row.content_key_version)
      || (row.content_key_version ?? 0) < 1
      || row.aad_version !== 2
      || !Buffer.isBuffer(row.dek_wrap_iv)
      || !Buffer.isBuffer(row.dek_wrap_auth_tag)
    ) {
      return;
    }
    const keyVersion = row.content_key_version!;
    const group = managedByVersion.get(keyVersion) ?? [];
    group.push({ index, row });
    managedByVersion.set(keyVersion, group);
  });

  // 한 페이지/세션에서 같은 UCK version은 한 번만 unwrap한다. 버전별 호출도
  // 순차 실행하여 긴 세션이 KMS 동시 요청을 폭증시키지 않게 한다.
  for (const [keyVersion, group] of managedByVersion) {
    const decryptGroup = (uck: Buffer) => {
      for (const { index, row } of group) {
        try {
          plaintexts[index] = decryptManagedContent(
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
          );
        } catch {
          plaintexts[index] = null;
        }
      }
    };

    const cachedKey = managedKeyCache?.get(keyVersion);
    if (cachedKey) {
      decryptGroup(cachedKey);
      continue;
    }
    try {
      await dependencies.runtime!.userKeys.withUserKeyVersion(
        userId,
        keyVersion,
        (uck) => {
          const requestKey = managedKeyCache ? Buffer.from(uck) : uck;
          if (managedKeyCache) managedKeyCache.set(keyVersion, requestKey);
          decryptGroup(requestKey);
        },
      );
    } catch {
      for (const { index } of group) plaintexts[index] = null;
    }
  }
  return plaintexts;
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
  if (f.agentScope === "main") conds.push("agent_id IS NULL");
  if (f.agentScope === "subagent") conds.push("agent_id IS NOT NULL");
  return conds;
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function normalizeHistorySearchQuery(value: string): string {
  return normalizedSearchText(value).slice(0, HISTORY_SEARCH_QUERY_LIMIT).toLowerCase();
}

export function toHistorySearchSnippet(text: string, query: string, maxLength = 220): string | null {
  const normalized = normalizedSearchText(text);
  const index = normalized.toLowerCase().indexOf(query);
  if (index < 0) return null;
  if (normalized.length <= maxLength) return normalized;

  const contextBefore = Math.max(0, Math.floor((maxLength - query.length) * 0.4));
  let start = Math.max(0, index - contextBefore);
  let end = Math.min(normalized.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end).trim()}${end < normalized.length ? "…" : ""}`;
}

function historySearchScope(userId: string, filter: HistoryFilter, query: string): string {
  return createHash("sha256").update(JSON.stringify({
    userId,
    query,
    rangeKey: filter.searchRangeKey ?? {
      from: filter.from.toISOString(),
      to: filter.to.toISOString(),
    },
    providerKey: filter.providerKey ?? null,
    agentScope: filter.agentScope ?? null,
  })).digest("base64url");
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
    subagent_count: string;
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
                COUNT(DISTINCT agent_id) FILTER (WHERE agent_id IS NOT NULL) AS subagent_count,
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

    const previewTexts = await decryptHistoryRows(previews, userId, resolved);
    const previewPairs = previews.map(
      (row, index) =>
        [
          row.gkey,
          previewTexts[index] ? toHistoryPreview(previewTexts[index]!) : "",
        ] as const,
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
        subagentCount: Number(g.subagent_count ?? 0),
      })),
    };
  } finally {
    resolved.legacyKek?.fill(0);
  }
}

type HistorySearchGroupRow = {
  gkey: string;
  is_session: boolean;
  provider_key: string;
  turn_count: string;
  first_ts: Date;
  latest_ts: Date;
  subagent_count: string;
  has_managed_content: boolean;
  has_legacy_content: boolean;
};

type HistorySearchCipherRow = HistoryCipherRow & {
  record_id: string;
  gkey: string;
};

function searchPosition(group: HistorySearchGroupRow): HistorySearchPosition {
  return { latestTs: group.latest_ts, key: group.gkey };
}

async function loadHistorySearchGroups(
  userId: string,
  filter: HistoryFilter,
  cursor: HistorySearchPosition | null,
  limit: number,
  db?: HistoryDb,
): Promise<{ groups: HistorySearchGroupRow[]; hasMore: boolean }> {
  const params: unknown[] = [userId];
  const conds = [`user_id = $1`, ...filterConds(filter, params)];
  let having = "";
  if (cursor) {
    params.push(cursor.latestTs, cursor.key);
    having = `HAVING (MAX(ts) < $${params.length - 1}
      OR (MAX(ts) = $${params.length - 1}
        AND COALESCE(session_id, dedup_key) < $${params.length}))`;
  }
  params.push(limit + 1);
  const result = await runHistoryContext(userId, db, (tx) => tx.query(
    `/* history-search-groups */
     SELECT COALESCE(session_id, dedup_key) AS gkey,
            BOOL_OR(session_id IS NOT NULL) AS is_session,
            MIN(provider_key) AS provider_key,
            COUNT(*) AS turn_count,
            MIN(ts) AS first_ts,
            MAX(ts) AS latest_ts,
            COUNT(DISTINCT agent_id) FILTER (WHERE agent_id IS NOT NULL) AS subagent_count,
            BOOL_OR(encryption_scheme = 'managed_v1') AS has_managed_content,
            BOOL_OR(encryption_scheme = 'server_v1') AS has_legacy_content
       FROM prompt_records
      WHERE ${conds.join(" AND ")}
      GROUP BY COALESCE(session_id, dedup_key)
      ${having}
      ORDER BY latest_ts DESC, gkey DESC
      LIMIT $${params.length}`,
    params,
  ));
  const rows = result.rows as HistorySearchGroupRow[];
  return { groups: rows.slice(0, limit), hasMore: rows.length > limit };
}

async function loadHistorySearchRows(
  userId: string,
  filter: HistoryFilter,
  key: string,
  afterRecordId: string | null,
  limit: number,
  db?: HistoryDb,
): Promise<HistorySearchCipherRow[]> {
  const params: unknown[] = [userId];
  const conds = [`user_id = $1`, ...filterConds(filter, params)];
  params.push(key, afterRecordId, limit);
  const keyParam = params.length - 2;
  const afterParam = params.length - 1;
  const limitParam = params.length;
  const result = await runHistoryContext(userId, db, (tx) => tx.query(
    `/* history-search-rows */
     SELECT id::text AS record_id,
            COALESCE(session_id, dedup_key) AS gkey,
            ${CIPHER_COLS}
       FROM prompt_records
      WHERE ${conds.join(" AND ")}
        AND COALESCE(session_id, dedup_key) = $${keyParam}
        AND ($${afterParam}::bigint IS NULL OR id > $${afterParam}::bigint)
      ORDER BY id ASC
      LIMIT $${limitParam}`,
    params,
  ));
  return result.rows as HistorySearchCipherRow[];
}

function historySearchCipherBytes(row: HistorySearchCipherRow): number {
  return row.ciphertext.length
    + row.wrapped_dek.length
    + row.iv.length
    + row.auth_tag.length
    + (row.dek_wrap_iv?.length ?? 0)
    + (row.dek_wrap_auth_tag?.length ?? 0);
}

type HistoryGroupSearchResult = {
  snippet: string | null;
  complete: boolean;
  afterRecordId: string | null;
  scannedRows: number;
  scannedBytes: number;
};

async function searchHistoryGroup(
  userId: string,
  filter: HistoryFilter,
  group: HistorySearchGroupRow,
  query: string,
  initialAfterRecordId: string | null,
  rowBudget: number,
  byteBudget: number,
  deadline: number,
  dependencies: ResolvedHistoryDependencies,
  managedKeyCache: Map<number, Buffer>,
): Promise<HistoryGroupSearchResult> {
  let afterRecordId = initialAfterRecordId;
  let scannedRows = 0;
  let scannedBytes = 0;

  while (scannedRows < rowBudget && scannedBytes < byteBudget && Date.now() < deadline) {
    const chunkLimit = Math.min(HISTORY_SEARCH_ROW_CHUNK_SIZE, rowBudget - scannedRows);
    const rows = await loadHistorySearchRows(
      userId,
      filter,
      group.gkey,
      afterRecordId,
      chunkLimit,
      dependencies.db,
    );
    if (rows.length === 0) {
      return { snippet: null, complete: true, afterRecordId, scannedRows, scannedBytes };
    }

    const selected: HistorySearchCipherRow[] = [];
    for (const row of rows) {
      const bytes = historySearchCipherBytes(row);
      if (scannedBytes + bytes > byteBudget) break;
      selected.push(row);
      scannedBytes += bytes;
    }
    if (selected.length === 0) {
      return { snippet: null, complete: false, afterRecordId, scannedRows, scannedBytes };
    }

    const plaintexts = await decryptHistoryRows(
      selected,
      userId,
      dependencies,
      managedKeyCache,
    );
    scannedRows += selected.length;
    for (const [index, row] of selected.entries()) {
      const plaintext = plaintexts[index];
      afterRecordId = row.record_id;
      if (!plaintext) continue;
      const snippet = toHistorySearchSnippet(plaintext, query);
      if (snippet) {
        return { snippet, complete: true, afterRecordId, scannedRows, scannedBytes };
      }
    }

    if (selected.length < rows.length) {
      return { snippet: null, complete: false, afterRecordId, scannedRows, scannedBytes };
    }
    if (rows.length < chunkLimit) {
      return { snippet: null, complete: true, afterRecordId, scannedRows, scannedBytes };
    }
  }
  return { snippet: null, complete: false, afterRecordId, scannedRows, scannedBytes };
}

/**
 * 관리형/레거시 서버 암호화 본문 검색. DB에는 검색용 평문 인덱스를 만들지 않고,
 * 메타데이터로 세션 후보를 줄인 뒤 전체 턴을 요청 예산 안에서 청크 복호화한다.
 * 한 요청에서 끝나지 않은 세션은 서명 cursor의 record id부터 이어서 검색한다.
 */
export async function searchMyHistorySessions(
  userId: string,
  filter: HistoryFilter,
  rawQuery: string,
  cursor: string | undefined,
  cursorSecret: string,
  pageSize = HISTORY_PAGE_SIZE_LIMIT,
  dependencies: HistoryDependencies = {},
): Promise<HistorySearchPage> {
  if (!cursorSecret) throw new Error("HISTORY_SEARCH_CURSOR_SECRET_MISSING");
  const query = normalizeHistorySearchQuery(rawQuery);
  const resolved = await resolveHistoryDependencies(dependencies);
  if (!resolved.runtime && !resolved.legacyKek) {
    return {
      enabled: false,
      hasManagedContent: false,
      hasLegacyContent: false,
      sessions: [],
      nextCursor: null,
    };
  }
  if (!query) {
    resolved.legacyKek?.fill(0);
    return {
      enabled: true,
      hasManagedContent: false,
      hasLegacyContent: false,
      sessions: [],
      nextCursor: null,
    };
  }

  const boundedPageSize = Math.min(
    HISTORY_PAGE_SIZE_LIMIT,
    Math.max(1, Math.trunc(pageSize) || HISTORY_PAGE_SIZE_LIMIT),
  );
  const scope = historySearchScope(userId, filter, query);
  const decodedCursor = decodeHistorySearchCursor(cursor, scope, cursorSecret);
  const initialState: HistorySearchCursorState = decodedCursor ?? {
    from: filter.from,
    to: filter.to,
    afterGroup: null,
    resume: null,
  };
  const effectiveFilter = { ...filter, from: initialState.from, to: initialState.to };
  let afterGroup = initialState.afterGroup;
  let resume = initialState.resume;
  let nextState: HistorySearchCursorState | null = null;
  let exhausted = false;
  let moreCandidates = false;
  let scannedGroups = 0;
  let scannedRows = 0;
  let scannedBytes = 0;
  let hasManagedContent = false;
  let hasLegacyContent = false;
  const matches: Array<{ group: HistorySearchGroupRow; snippet: string }> = [];
  const requestManagedKeys = new Map<number, Buffer>();
  const deadline = Date.now() + HISTORY_SEARCH_TIME_LIMIT_MS;

  const cursorState = (
    nextResume: HistorySearchCursorState["resume"] = null,
  ): HistorySearchCursorState => ({
    from: effectiveFilter.from,
    to: effectiveFilter.to,
    afterGroup,
    resume: nextResume,
  });

  try {
    searchLoop:
    while (
      matches.length < boundedPageSize
      && scannedGroups < HISTORY_SEARCH_GROUP_SCAN_LIMIT
      && scannedRows < HISTORY_SEARCH_ROW_SCAN_LIMIT
      && scannedBytes < HISTORY_SEARCH_CIPHERTEXT_BYTE_LIMIT
      && Date.now() < deadline
    ) {
      const batchSize = Math.min(
        HISTORY_SEARCH_GROUP_BATCH_SIZE,
        HISTORY_SEARCH_GROUP_SCAN_LIMIT - scannedGroups,
      );
      const batch = await loadHistorySearchGroups(
        userId,
        effectiveFilter,
        afterGroup,
        batchSize,
        resolved.db,
      );
      if (batch.groups.length === 0) {
        exhausted = true;
        break;
      }
      moreCandidates = batch.hasMore;

      for (const [index, group] of batch.groups.entries()) {
        const position = searchPosition(group);
        const resumeAfterRecordId = resume
          && resume.group.key === position.key
          && resume.group.latestTs.getTime() === position.latestTs.getTime()
          ? resume.afterRecordId
          : null;
        const groupResult = await searchHistoryGroup(
          userId,
          effectiveFilter,
          group,
          query,
          resumeAfterRecordId,
          HISTORY_SEARCH_ROW_SCAN_LIMIT - scannedRows,
          HISTORY_SEARCH_CIPHERTEXT_BYTE_LIMIT - scannedBytes,
          deadline,
          resolved,
          requestManagedKeys,
        );
        resume = null;
        scannedRows += groupResult.scannedRows;
        scannedBytes += groupResult.scannedBytes;
        hasManagedContent ||= group.has_managed_content;
        hasLegacyContent ||= group.has_legacy_content;

        if (!groupResult.complete) {
          nextState = cursorState(groupResult.afterRecordId ? {
            group: position,
            afterRecordId: groupResult.afterRecordId,
          } : null);
          break searchLoop;
        }

        afterGroup = position;
        scannedGroups += 1;
        if (groupResult.snippet) matches.push({ group, snippet: groupResult.snippet });
        const moreInBatch = index < batch.groups.length - 1;
        moreCandidates = moreInBatch || batch.hasMore;
        if (matches.length >= boundedPageSize) {
          if (moreCandidates) nextState = cursorState();
          else exhausted = true;
          break searchLoop;
        }
        if (
          scannedGroups >= HISTORY_SEARCH_GROUP_SCAN_LIMIT
          || scannedRows >= HISTORY_SEARCH_ROW_SCAN_LIMIT
          || scannedBytes >= HISTORY_SEARCH_CIPHERTEXT_BYTE_LIMIT
          || Date.now() >= deadline
        ) {
          if (moreCandidates) nextState = cursorState();
          else exhausted = true;
          break searchLoop;
        }
      }

      if (!batch.hasMore) {
        exhausted = true;
        break;
      }
    }

    if (!exhausted && !nextState && moreCandidates) nextState = cursorState();

    return {
      enabled: true,
      hasManagedContent,
      hasLegacyContent,
      sessions: matches.map(({ group, snippet }) => ({
        key: group.gkey,
        isSession: group.is_session,
        providerKey: group.provider_key,
        preview: snippet,
        turnCount: Number(group.turn_count),
        firstTs: group.first_ts,
        latestTs: group.latest_ts,
        subagentCount: Number(group.subagent_count ?? 0),
      })),
      nextCursor: nextState
        ? encodeHistorySearchCursor(nextState, scope, cursorSecret)
        : null,
    };
  } finally {
    for (const key of requestManagedKeys.values()) key.fill(0);
    requestManagedKeys.clear();
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

    const plaintexts = await decryptHistoryRows(rows, userId, resolved);
    const turns = rows.map((row, index) => {
      const text = plaintexts[index] ?? null;
      return {
        dedupKey: row.dedup_key,
        sessionId: row.session_id,
        providerKey: row.provider_key,
        role: row.turn_role,
        ts: row.ts,
        text: text ?? "",
        agent: row.agent_id == null ? null : {
          id: row.agent_id,
          parentId: row.parent_agent_id ?? null,
          depth: row.agent_depth ?? null,
          name: row.agent_name ?? null,
          role: row.agent_role ?? null,
        },
        ...(text === null ? { contentUnavailable: true } : {}),
      };
    });
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
