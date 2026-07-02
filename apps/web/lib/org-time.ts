// 조직 타임존 (ADR-008) — 일별 집계·리더보드의 "하루" 경계를 결정한다.
// ORG_TIMEZONE(IANA, 예 'Asia/Seoul') 미설정/무효 시 UTC.

let cached: string | undefined;

export function getOrgTimezone(): string {
  if (cached) return cached;
  const tz = process.env.ORG_TIMEZONE?.trim();
  if (!tz) return (cached = "UTC");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return (cached = tz);
  } catch {
    console.warn(`[toard] ORG_TIMEZONE "${tz}" 은 유효한 IANA 타임존이 아님 — UTC 로 폴백`);
    return (cached = "UTC");
  }
}

/** 조직 타임존 기준 날짜 'YYYY-MM-DD'. offsetDays 음수면 과거 일자. */
export function orgDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  // en-CA 로케일은 YYYY-MM-DD 형식을 보장한다
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: getOrgTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
