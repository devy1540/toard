import type { PeriodQuery } from "@toard/core";
import { orgDayStartUtc, startOfOrgToday } from "./org-time";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 기본 기간 프리셋 (URL 에 period 미지정 시). */
export const DEFAULT_PERIOD = "today";

/** 롤링 윈도우 프리셋(현재 시각 기준 최근 N일). */
const ROLLING: Record<string, number> = { "7": 7, "30": 30, "90": 90 };

export function recentPeriod(days: number): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  return { from, to };
}

/** 오늘 — 조직 타임존 자정부터 현재까지. */
export function todayPeriod(): { from: Date; to: Date } {
  return { from: startOfOrgToday(), to: new Date() };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function isYmd(s: string | undefined): s is string {
  return !!s && YMD.test(s);
}

/** YYYY-MM-DD 캘린더 산술(UTC 기준, 타임존 무관). */
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + n)).toISOString().slice(0, 10);
}

/** 커스텀 범위: from/to(조직 타임존 캘린더 일자, to 포함). 유효하지 않으면 null. */
function customPeriod(from?: string, to?: string): { from: Date; to: Date } | null {
  if (!isYmd(from) || !isYmd(to)) return null;
  let [a, b] = [from, to];
  if (a > b) [a, b] = [b, a]; // 뒤집힌 입력 방어
  // to 일자를 포함하도록 다음날 자정을 exclusive 상한으로.
  return { from: orgDayStartUtc(a), to: orgDayStartUtc(addDays(b, 1)) };
}

export interface DashboardSearchParams {
  period?: string;
  provider?: string;
  /** period=custom 일 때 조직 타임존 캘린더 시작일 (YYYY-MM-DD) */
  from?: string;
  /** period=custom 일 때 조직 타임존 캘린더 종료일 (YYYY-MM-DD, 포함) */
  to?: string;
}

/** 전체 기간 — epoch 부터 현재까지 (히스토리처럼 "기본 = 전체"가 자연스러운 화면용). */
export function allPeriod(): { from: Date; to: Date } {
  return { from: new Date(0), to: new Date() };
}

/** URL searchParams → PeriodQuery (기간·프로바이더 필터). 기본 프리셋은 화면별로 주입 가능. */
export function parseFilters(sp: DashboardSearchParams, defaultPeriod = DEFAULT_PERIOD): PeriodQuery {
  const providerKey = sp.provider && sp.provider !== "all" ? sp.provider : undefined;
  const period = sp.period ?? defaultPeriod;
  const rollingDays = ROLLING[period];

  let range: { from: Date; to: Date };
  if (period === "custom") {
    range = customPeriod(sp.from, sp.to) ?? todayPeriod();
  } else if (period === "all") {
    range = allPeriod();
  } else if (rollingDays != null) {
    range = recentPeriod(rollingDays);
  } else {
    range = todayPeriod();
  }

  return { ...range, providerKey };
}
