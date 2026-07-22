import { createHmac, timingSafeEqual } from "node:crypto";

const CURSOR_VERSION = 2;
const MAX_CURSOR_KEY_LENGTH = 4_096;
const RECORD_ID = /^\d{1,32}$/;

export type HistorySearchPosition = {
  latestTs: Date;
  key: string;
};

export type HistorySearchCursorState = {
  from: Date;
  to: Date;
  /** 마지막으로 검색을 끝낸 세션. null이면 첫 세션부터 시작한다. */
  afterGroup: HistorySearchPosition | null;
  /** 행 예산이 끝난 세션을 다음 요청에서 이어서 검색한다. */
  resume: {
    group: HistorySearchPosition;
    afterRecordId: string;
  } | null;
};

type EncodedPosition = {
  latestTs: string;
  key: string;
};

type HistorySearchCursorPayload = {
  v: typeof CURSOR_VERSION;
  scope: string;
  from: string;
  to: string;
  afterGroup: EncodedPosition | null;
  resume: {
    group: EncodedPosition;
    afterRecordId: string;
  } | null;
};

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function encodePosition(position: HistorySearchPosition): EncodedPosition {
  if (
    !Number.isFinite(position.latestTs.getTime())
    || position.key.length === 0
    || position.key.length > MAX_CURSOR_KEY_LENGTH
  ) {
    throw new Error("HISTORY_SEARCH_CURSOR_POSITION_INVALID");
  }
  return { latestTs: position.latestTs.toISOString(), key: position.key };
}

function decodePosition(value: unknown): HistorySearchPosition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<EncodedPosition>;
  if (
    typeof candidate.latestTs !== "string"
    || typeof candidate.key !== "string"
    || candidate.key.length === 0
    || candidate.key.length > MAX_CURSOR_KEY_LENGTH
  ) {
    return null;
  }
  const latestTs = new Date(candidate.latestTs);
  return Number.isFinite(latestTs.getTime()) ? { latestTs, key: candidate.key } : null;
}

export function encodeHistorySearchCursor(
  state: HistorySearchCursorState,
  scope: string,
  secret: string,
): string {
  if (!secret) throw new Error("HISTORY_SEARCH_CURSOR_SECRET_MISSING");
  if (
    !Number.isFinite(state.from.getTime())
    || !Number.isFinite(state.to.getTime())
    || state.from >= state.to
    || (state.resume && !RECORD_ID.test(state.resume.afterRecordId))
  ) {
    throw new Error("HISTORY_SEARCH_CURSOR_STATE_INVALID");
  }
  const payload = Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    scope,
    from: state.from.toISOString(),
    to: state.to.toISOString(),
    afterGroup: state.afterGroup ? encodePosition(state.afterGroup) : null,
    resume: state.resume ? {
      group: encodePosition(state.resume.group),
      afterRecordId: state.resume.afterRecordId,
    } : null,
  } satisfies HistorySearchCursorPayload)).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function decodeHistorySearchCursor(
  cursor: string | undefined,
  scope: string,
  secret: string,
): HistorySearchCursorState | null {
  if (!cursor) return null;
  if (!secret) throw new Error("HISTORY_SEARCH_CURSOR_SECRET_MISSING");
  const [payload, encodedSignature, extra] = cursor.split(".");
  if (!payload || !encodedSignature || extra !== undefined) return null;

  let provided: Buffer;
  try {
    provided = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expected = signature(payload, secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<HistorySearchCursorPayload>;
    if (value.v !== CURSOR_VERSION || value.scope !== scope) return null;
    if (typeof value.from !== "string" || typeof value.to !== "string") return null;
    const from = new Date(value.from);
    const to = new Date(value.to);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) return null;
    const afterGroup = value.afterGroup === null ? null : decodePosition(value.afterGroup);
    if (value.afterGroup !== null && !afterGroup) return null;

    let resume: HistorySearchCursorState["resume"] = null;
    if (value.resume !== null) {
      if (
        typeof value.resume !== "object"
        || !RECORD_ID.test(value.resume.afterRecordId ?? "")
      ) {
        return null;
      }
      const group = decodePosition(value.resume.group);
      if (!group) return null;
      resume = { group, afterRecordId: value.resume.afterRecordId! };
    }
    return { from, to, afterGroup, resume };
  } catch {
    return null;
  }
}
