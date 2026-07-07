// 타임존 유틸 (ADR-008) — 일별 집계·기간 필터의 "하루" 경계 계산.
// 표출은 뷰어 타임존(viewer-time.ts), Mart 물질화·cron 마감은 조직 타임존(ORG_TIMEZONE)을 쓴다.

let cached: string | undefined;

/** IANA 타임존 유효성 — Intl 이 아는 이름만 통과. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getOrgTimezone(): string {
  if (cached) return cached;
  const tz = process.env.ORG_TIMEZONE?.trim();
  if (!tz) return (cached = "UTC");
  if (isValidTimezone(tz)) return (cached = tz);
  console.warn(`[toard] ORG_TIMEZONE "${tz}" 은 유효한 IANA 타임존이 아님 — UTC 로 폴백`);
  return (cached = "UTC");
}

/** 해당 타임존 기준 날짜 'YYYY-MM-DD'. offsetDays 음수면 과거 일자. */
export function dateInTz(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  // en-CA 로케일은 YYYY-MM-DD 형식을 보장한다
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 조직 타임존 기준 날짜 — Mart 마감(cron recompute)·가격 동기화 스탬프 등 조직 스코프 전용. */
export function orgDate(offsetDays = 0): string {
  return dateInTz(getOrgTimezone(), offsetDays);
}

/** 해당 시각의 타임존 UTC 오프셋(ms) */
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
 * 해당 타임존 기준 특정 날짜(YYYY-MM-DD) "00:00" 의 UTC 시각.
 * 일별 집계가 (ts AT TIME ZONE tz)::date 로 버킷하므로, 기간 필터 경계도 동일 타임존에 맞춘다 (ADR-008).
 * DST 전환일은 오프셋이 달라질 수 있어 1회 재보정.
 */
export function dayStartUtc(dateStr: string, tz: string): Date {
  const midnightAsUtc = new Date(`${dateStr}T00:00:00Z`).getTime();
  // 자정의 실제 UTC 시각 = 자정(UTC 표기) - 오프셋.
  let guess = new Date(midnightAsUtc - tzOffsetMs(new Date(midnightAsUtc), tz));
  const refined = new Date(midnightAsUtc - tzOffsetMs(guess, tz));
  if (refined.getTime() !== guess.getTime()) guess = refined;
  return guess;
}

/** 해당 타임존 기준 "오늘 00:00" 의 UTC 시각 — '오늘' 기간 필터의 시작 경계. */
export function startOfToday(tz: string): Date {
  return dayStartUtc(dateInTz(tz), tz);
}
