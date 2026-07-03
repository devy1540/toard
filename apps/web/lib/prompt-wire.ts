// PromptRecord 와이어 포맷 (shim 본문 수집 → POST /api/v1/prompts).
// UsageEvent(wire.ts)와 형제 계약이지만 본문(text)을 실어 나른다.
// userId 는 본문에 없음 — 서버가 토큰으로 확정(§10.1). 암호화는 서버 몫이라 여기선 평문 text.
// (shim 이 실제로 붙으면 core 로 승격 + golden fixture 로 드리프트 검증 예정)

export class PromptWireError extends Error {
  constructor(
    message: string,
    /** 몇 번째 레코드에서 실패했는지 (단건 파싱은 undefined) */
    public readonly index?: number,
  ) {
    super(index === undefined ? message : `records[${index}]: ${message}`);
    this.name = "PromptWireError";
  }
}

export interface PromptRecordWire {
  dedupKey: string;
  sessionId: string | null;
  providerKey: string;
  turnRole: "user" | "assistant";
  ts: Date;
  text: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new PromptWireError(`${field} 는 비어있지 않은 문자열이어야 합니다`);
  }
  return v;
}

function nullableString(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new PromptWireError(`${field} 는 문자열 또는 null 이어야 합니다`);
  return v;
}

/** 와이어 JSON(unknown) 1건 → PromptRecordWire. 실패 시 PromptWireError. */
export function parsePromptRecordWire(v: unknown): PromptRecordWire {
  if (!isRecord(v)) throw new PromptWireError("레코드는 객체여야 합니다");
  const dedupKey = nonEmptyString(v.dedupKey, "dedupKey");
  const providerKey = nonEmptyString(v.providerKey, "providerKey");
  const sessionId = nullableString(v.sessionId, "sessionId");
  const turnRole = nonEmptyString(v.turnRole, "turnRole");
  if (turnRole !== "user" && turnRole !== "assistant") {
    throw new PromptWireError("turnRole 는 'user' 또는 'assistant' 여야 합니다");
  }
  const tsRaw = nonEmptyString(v.ts, "ts");
  const ts = new Date(tsRaw);
  if (Number.isNaN(ts.getTime())) throw new PromptWireError(`ts 가 유효한 ISO 8601 이 아닙니다: ${tsRaw}`);
  const text = nonEmptyString(v.text, "text");
  return { dedupKey, providerKey, sessionId, turnRole, ts, text };
}

/** POST /api/v1/prompts 본문(PromptRecord[] JSON) 파싱. */
export function parsePromptRecordsBody(body: unknown): PromptRecordWire[] {
  if (!Array.isArray(body)) throw new PromptWireError("본문은 PromptRecord 배열이어야 합니다");
  return body.map((item, i) => {
    try {
      return parsePromptRecordWire(item);
    } catch (e) {
      if (e instanceof PromptWireError && e.index === undefined) {
        throw new PromptWireError(e.message.replace(/^records\[\d+\]: /, ""), i);
      }
      throw e;
    }
  });
}
