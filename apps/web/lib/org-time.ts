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

/** 해당 시각의 조직 타임존 UTC 오프셋(ms) */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  // 포맷이 초 단위라 ms 잔차가 생김 — IANA 오프셋은 분 단위이므로 분으로 반올림
  return Math.round((asUtc - at.getTime()) / 60_000) * 60_000;
}

/**
 * 조직 타임존 기준 특정 날짜(YYYY-MM-DD) "00:00" 의 UTC 시각.
 * 일별 집계가 (ts AT TIME ZONE tz)::date 로 버킷하므로, 기간 필터 경계도 동일 타임존에 맞춘다 (ADR-008).
 * DST 전환일은 오프셋이 달라질 수 있어 1회 재보정.
 */
export function orgDayStartUtc(dateStr: string): Date {
  const tz = getOrgTimezone();
  const midnightAsUtc = new Date(`${dateStr}T00:00:00Z`).getTime();
  // 자정의 실제 UTC 시각 = 자정(UTC 표기) - 오프셋.
  let guess = new Date(midnightAsUtc - tzOffsetMs(new Date(midnightAsUtc), tz));
  const refined = new Date(midnightAsUtc - tzOffsetMs(guess, tz));
  if (refined.getTime() !== guess.getTime()) guess = refined;
  return guess;
}

/** 조직 타임존 기준 "오늘 00:00" 의 UTC 시각 — '오늘' 기간 필터의 시작 경계. */
export function startOfOrgToday(): Date {
  return orgDayStartUtc(orgDate(0));
}
