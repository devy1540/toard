import { fillTimeBucketGaps, type DailyPoint, type PeriodQuery, type TimeBucket } from "@toard/core";
import { dateInTz, dayStartUtc, startOfToday } from "./org-time";

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

/** 오늘 — 해당 타임존 오늘 자정부터 내일 자정 직전까지. */
export function todayPeriod(tz: string): { from: Date; to: Date } {
  const today = dateInTz(tz);
  return { from: startOfToday(tz), to: dayStartUtc(addDays(today, 1), tz) };
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

function monthStart(ymd: string, offsetMonths = 0): string {
  const [y, m] = ymd.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1 + offsetMonths, 1)).toISOString().slice(0, 10);
}

function weekday(ymd: string): number {
  const [y, m, d] = ymd.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay();
}

function dateKey(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** 이번 주 — 해당 타임존 기준 일요일 00:00부터 다음 일요일 00:00 미만. */
export function currentWeekPeriod(tz: string): { from: Date; to: Date } {
  const today = dateInTz(tz);
  const start = addDays(today, -weekday(today));
  return { from: dayStartUtc(start, tz), to: dayStartUtc(addDays(start, 7), tz) };
}

/** 이번 달 — 해당 타임존 기준 1일 00:00부터 다음 달 1일 00:00 미만. */
export function currentMonthPeriod(tz: string): { from: Date; to: Date } {
  const start = monthStart(dateInTz(tz));
  return { from: dayStartUtc(start, tz), to: dayStartUtc(monthStart(start, 1), tz) };
}

/** 최근 N개월 — 이번 달을 포함해 N개월, 월 경계 기준. */
export function recentCalendarMonthsPeriod(months: number, tz: string): { from: Date; to: Date } {
  const currentMonth = monthStart(dateInTz(tz));
  const start = monthStart(currentMonth, -(months - 1));
  return { from: dayStartUtc(start, tz), to: dayStartUtc(monthStart(currentMonth, 1), tz) };
}

/** 커스텀 범위: from/to(뷰어 타임존 캘린더 일자, to 포함). 유효하지 않으면 null. */
function customPeriod(from: string | undefined, to: string | undefined, tz: string): { from: Date; to: Date } | null {
  if (!isYmd(from) || !isYmd(to)) return null;
  let [a, b] = [from, to];
  if (a > b) [a, b] = [b, a]; // 뒤집힌 입력 방어
  // to 일자를 포함하도록 다음날 자정을 exclusive 상한으로.
  return { from: dayStartUtc(a, tz), to: dayStartUtc(addDays(b, 1), tz) };
}

export interface DashboardSearchParams {
  period?: string;
  provider?: string;
  /** period=custom 일 때 뷰어 타임존 캘린더 시작일 (YYYY-MM-DD) */
  from?: string;
  /** period=custom 일 때 뷰어 타임존 캘린더 종료일 (YYYY-MM-DD, 포함) */
  to?: string;
  /** 차트 지표 (tokens|cost) — 페이지별 기본값은 각 페이지가 정한다 */
  metric?: string;
  /** 하루 범위 차트 버킷(hour|30m|15m). 하루 범위가 아니면 무시한다. */
  bucket?: string;
}

/** 전체 기간 — epoch 부터 현재까지 (히스토리처럼 "기본 = 전체"가 자연스러운 화면용). */
export function allPeriod(): { from: Date; to: Date } {
  return { from: new Date(0), to: new Date() };
}

/** 기간 프리셋 식별자 — 카드 라벨("오늘 비용")·델타 문구가 기간을 알아야 해서 노출 */
export type PeriodPreset = "today" | "week" | "month" | "quarter" | "year" | "7" | "30" | "90" | "custom" | "all";

export type DashboardPeriod = PeriodQuery & { bucket: TimeBucket; preset: PeriodPreset; timezone: string };

export type IntradayBucket = Exclude<TimeBucket, "day">;
export const INTRADAY_BUCKETS = ["hour", "30m", "15m"] as const satisfies readonly IntradayBucket[];

export function isIntradayBucket(v: unknown): v is IntradayBucket {
  return typeof v === "string" && (INTRADAY_BUCKETS as readonly string[]).includes(v);
}

function requestedIntradayBucket(v: string | undefined): IntradayBucket {
  return isIntradayBucket(v) ? v : "hour";
}

/**
 * URL searchParams → 기간·프로바이더 필터 + 시계열 버킷. 기본 프리셋은 화면별로 주입 가능.
 * timezone(뷰어 타임존, ADR-008 개정)이 "오늘"·커스텀 일자의 경계와 버킷 벽시계를 결정하며,
 * 반환 기간에 실려 storage 쿼리(BucketOptions)까지 그대로 흐른다.
 * 하루짜리 기간(오늘·단일 일자 커스텀)은 일별로 점 하나만 나오므로 시간 버킷으로 내린다.
 */
export function parseFilters(
  sp: DashboardSearchParams,
  timezone: string,
  defaultPeriod = DEFAULT_PERIOD,
): DashboardPeriod {
  const providerKey = sp.provider && sp.provider !== "all" ? sp.provider : undefined;
  const period = sp.period ?? defaultPeriod;
  const rollingDays = ROLLING[period];
  const intradayBucket = requestedIntradayBucket(sp.bucket);

  let range: { from: Date; to: Date };
  let bucket: TimeBucket;
  let preset: PeriodPreset;
  if (period === "custom") {
    const custom = customPeriod(sp.from, sp.to, timezone);
    range = custom ?? todayPeriod(timezone);
    bucket = !custom || sp.from === sp.to ? intradayBucket : "day";
    preset = custom ? "custom" : "today";
  } else if (period === "week") {
    range = currentWeekPeriod(timezone);
    bucket = "day";
    preset = "week";
  } else if (period === "month") {
    range = currentMonthPeriod(timezone);
    bucket = "day";
    preset = "month";
  } else if (period === "quarter") {
    range = recentCalendarMonthsPeriod(3, timezone);
    bucket = "day";
    preset = "quarter";
  } else if (period === "year") {
    range = recentCalendarMonthsPeriod(12, timezone);
    bucket = "day";
    preset = "year";
  } else if (period === "all") {
    range = allPeriod();
    bucket = "day";
    preset = "all";
  } else if (rollingDays != null) {
    range = recentPeriod(rollingDays);
    bucket = "day";
    preset = period as PeriodPreset;
  } else {
    range = todayPeriod(timezone);
    bucket = intradayBucket;
    preset = "today";
  }

  return { ...range, providerKey, bucket, preset, timezone };
}

/** 직전 동일 길이 기간 — 스탯 카드의 "전일/직전 기간 대비" 델타 비교용. */
export function previousPeriod(p: PeriodQuery & { preset?: PeriodPreset; timezone?: string }): PeriodQuery {
  const tz = p.timezone;
  if (tz && p.preset === "today") {
    const end = dateKey(p.from, tz);
    const start = addDays(end, -1);
    return { from: dayStartUtc(start, tz), to: dayStartUtc(end, tz), providerKey: p.providerKey };
  }
  if (tz && p.preset === "week") {
    const end = dateKey(p.from, tz);
    const start = addDays(end, -7);
    return { from: dayStartUtc(start, tz), to: dayStartUtc(end, tz), providerKey: p.providerKey };
  }
  if (tz && p.preset === "month") {
    const end = dateKey(p.from, tz);
    const start = monthStart(end, -1);
    return { from: dayStartUtc(start, tz), to: dayStartUtc(end, tz), providerKey: p.providerKey };
  }
  if (tz && p.preset === "quarter") {
    const end = dateKey(p.from, tz);
    const start = monthStart(end, -3);
    return { from: dayStartUtc(start, tz), to: dayStartUtc(end, tz), providerKey: p.providerKey };
  }
  if (tz && p.preset === "year") {
    const end = dateKey(p.from, tz);
    const start = monthStart(end, -12);
    return { from: dayStartUtc(start, tz), to: dayStartUtc(end, tz), providerKey: p.providerKey };
  }
  const span = p.to.getTime() - p.from.getTime();
  return { from: new Date(p.from.getTime() - span), to: p.from, providerKey: p.providerKey };
}

/** 하루 안 버킷 시리즈의 빈 시간대를 기간의 타임존 기준 0 포인트로 채운다 (일별은 그대로). */
export function fillSeriesGaps(points: DailyPoint[], period: DashboardPeriod): DailyPoint[] {
  if (period.bucket === "day") return points;
  return fillTimeBucketGaps(points, period, period.timezone, period.bucket);
}
