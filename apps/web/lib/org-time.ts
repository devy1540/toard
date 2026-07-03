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

/** 주어진 순간에 tz 의 벽시계 - UTC 오프셋(ms). tz 가 UTC 보다 앞서면 양수. */
function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  // hour 는 hour12:false 에서 자정이 '24' 로 나올 수 있어 24→0 정규화
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - at.getTime();
}

/**
 * 조직 타임존 기준 특정 날짜(YYYY-MM-DD) 자정(00:00)의 UTC 순간.
 * 일별 집계가 (ts AT TIME ZONE tz)::date 로 버킷하므로, 기간 필터 경계도 동일 타임존에 맞춘다.
 */
export function orgDayStartUtc(dateStr: string): Date {
  const [y, mo, d] = dateStr.split("-");
  const tz = getOrgTimezone();
  // UTC 자정을 가정해 해당 시점의 오프셋을 구한 뒤 보정 (고정오프셋 타임존은 정확, DST 는 근사)
  const utcGuess = Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0);
  return new Date(utcGuess - tzOffsetMs(tz, new Date(utcGuess)));
}
