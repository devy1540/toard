import { fillHourlyGaps, type DailyPoint, type PeriodQuery, type TimeBucket } from "@toard/core";
import { getOrgTimezone, orgDayStartUtc, startOfOrgToday } from "./org-time";

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
  /** 차트 지표 (tokens|cost) — 페이지별 기본값은 각 페이지가 정한다 */
  metric?: string;
}

/** 전체 기간 — epoch 부터 현재까지 (히스토리처럼 "기본 = 전체"가 자연스러운 화면용). */
export function allPeriod(): { from: Date; to: Date } {
  return { from: new Date(0), to: new Date() };
}

/** 기간 프리셋 식별자 — 카드 라벨("오늘 비용")·델타 문구가 기간을 알아야 해서 노출 */
export type PeriodPreset = "today" | "7" | "30" | "90" | "custom" | "all";

export type DashboardPeriod = PeriodQuery & { bucket: TimeBucket; preset: PeriodPreset };

/**
 * URL searchParams → 기간·프로바이더 필터 + 시계열 버킷. 기본 프리셋은 화면별로 주입 가능.
 * 하루짜리 기간(오늘·단일 일자 커스텀)은 일별로 점 하나만 나오므로 시간 버킷으로 내린다.
 */
export function parseFilters(sp: DashboardSearchParams, defaultPeriod = DEFAULT_PERIOD): DashboardPeriod {
  const providerKey = sp.provider && sp.provider !== "all" ? sp.provider : undefined;
  const period = sp.period ?? defaultPeriod;
  const rollingDays = ROLLING[period];

  let range: { from: Date; to: Date };
  let bucket: TimeBucket;
  let preset: PeriodPreset;
  if (period === "custom") {
    const custom = customPeriod(sp.from, sp.to);
    range = custom ?? todayPeriod();
    bucket = !custom || sp.from === sp.to ? "hour" : "day";
    preset = custom ? "custom" : "today";
  } else if (period === "all") {
    range = allPeriod();
    bucket = "day";
    preset = "all";
  } else if (rollingDays != null) {
    range = recentPeriod(rollingDays);
    bucket = "day";
    preset = period as PeriodPreset;
  } else {
    range = todayPeriod();
    bucket = "hour";
    preset = "today";
  }

  return { ...range, providerKey, bucket, preset };
}

/** 직전 동일 길이 기간 — 스탯 카드의 "전일/직전 기간 대비" 델타 비교용. */
export function previousPeriod(p: PeriodQuery): PeriodQuery {
  const span = p.to.getTime() - p.from.getTime();
  return { from: new Date(p.from.getTime() - span), to: p.from, providerKey: p.providerKey };
}

/** bucket='hour' 시리즈의 빈 시간대를 조직 타임존 기준 0 포인트로 채운다 (일별은 그대로). */
export function fillSeriesGaps(points: DailyPoint[], period: DashboardPeriod): DailyPoint[] {
  if (period.bucket !== "hour") return points;
  return fillHourlyGaps(points, period, getOrgTimezone());
}
