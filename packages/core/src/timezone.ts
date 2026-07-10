const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEARCH_WINDOW_MS = 48 * 60 * 60 * 1000;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Intl alias를 하나의 IANA ID로 정규화한다. 약어와 invalid 값은 null이다. */
export function canonicalTimezoneId(input: string): string | null {
  const timezone = input.trim();
  const hasIanaNameShape = timezone === "UTC"
    || /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timezone);
  if (!hasIanaNameShape) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timezone, formatter);
  }
  return formatter;
}

/** UTC instant를 해당 시간대의 YYYY-MM-DD local date로 변환한다. */
export function localDateKey(at: Date, timezoneInput: string): string {
  const timezone = canonicalTimezoneId(timezoneInput);
  if (!timezone || !Number.isFinite(at.getTime())) throw new Error("유효한 timezone 또는 instant가 아님");
  return dateFormatter(timezone).format(at);
}

function parseLocalDate(date: string): { year: number; month: number; day: number; midnightUtc: number } {
  const match = YMD.exec(date);
  if (!match) throw new Error(`유효한 YYYY-MM-DD local date가 아님: ${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const midnightUtc = Date.UTC(year, month - 1, day);
  if (new Date(midnightUtc).toISOString().slice(0, 10) !== date) {
    throw new Error(`유효한 YYYY-MM-DD local date가 아님: ${date}`);
  }
  return { year, month, day, midnightUtc };
}

/** YYYY-MM-DD에 timezone과 무관한 calendar day 산술을 적용한다. */
export function addLocalCalendarDays(date: string, days: number): string {
  const { year, month, day } = parseLocalDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * local date에 실제로 속하는 가장 이른 UTC millisecond를 찾는다.
 * 자정 gap이면 01:00 같은 그 날의 첫 instant가 되고, 날짜 전체가 skip되면 예외다.
 */
export function firstInstantOfLocalDate(date: string, timezoneInput: string): Date {
  const timezone = canonicalTimezoneId(timezoneInput);
  if (!timezone) throw new Error(`유효한 IANA timezone이 아님: ${timezoneInput}`);
  const { midnightUtc } = parseLocalDate(date);
  let low = midnightUtc - SEARCH_WINDOW_MS;
  let high = midnightUtc + SEARCH_WINDOW_MS;

  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (localDateKey(new Date(mid), timezone) < date) low = mid + 1;
    else high = mid;
  }

  const result = new Date(low);
  if (localDateKey(result, timezone) !== date) {
    throw new Error(`timezone ${timezone}에 존재하지 않는 local date: ${date}`);
  }
  return result;
}
