// 타임존 유틸 (ADR-008) — 일별 집계·기간 필터의 "하루" 경계 계산.
// 표출은 뷰어 타임존(viewer-time.ts), Mart 물질화·cron 마감은 조직 타임존(ORG_TIMEZONE)을 쓴다.

import { firstInstantOfLocalDate } from "@toard/core";

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

/**
 * 해당 타임존 기준 특정 날짜(YYYY-MM-DD)가 시작되는 최초 UTC 시각.
 * 일별 집계가 (ts AT TIME ZONE tz)::date 로 버킷하므로, 기간 필터 경계도 동일 타임존에 맞춘다 (ADR-008).
 * 자정이 존재하지 않는 DST 전환일도 실제 첫 시각을 반환한다.
 */
export function dayStartUtc(dateStr: string, tz: string): Date {
  return firstInstantOfLocalDate(dateStr, tz);
}

/** 해당 타임존 기준 오늘의 최초 UTC 시각 — '오늘' 기간 필터의 시작 경계. */
export function startOfToday(tz: string): Date {
  return dayStartUtc(dateInTz(tz), tz);
}
