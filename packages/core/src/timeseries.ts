// 시계열 후처리 — 시간 버킷('YYYY-MM-DD HH:00') 시리즈의 빈 시간대를 0 으로 채운다.
// 오늘 필터처럼 데이터가 드문 기간에서 점 몇 개 대신 자정→현재의 연속 곡선을 그리기 위함.
// DB 가 이미 조직 타임존 벽시계 기준으로 버킷하므로, 채우기도 동일 타임존으로 키를 생성한다.

import type { DailyPoint } from "./storage";

const HOUR_MS = 60 * 60 * 1000;

/** UTC 시각 → 조직 타임존 벽시계 시간 버킷 키 'YYYY-MM-DD HH:00' */
export function hourKey(at: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:00`;
}

const zero = (day: string): DailyPoint => ({
  day,
  sessions: 0,
  activeUsers: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

/**
 * bucket='hour' 시리즈의 [from, to) 구간 빈 시간대를 0 포인트로 채운다.
 * - to 가 미래(진행 중인 오늘)면 now 까지만 채운다 — 아직 오지 않은 시간은 그리지 않음.
 * - 실제 UTC 순간을 1시간 간격으로 걷고 타임존 포맷으로 키를 만들므로 DST 전환도 자연 처리
 *   (fall-back 중복 키는 첫 항목 유지 — DB 도 벽시계 키로 이미 병합돼 있다).
 * - 생성 범위 밖 키(시계 오차 등)는 버리지 않고 뒤에 정렬 병합.
 */
export function fillHourlyGaps(
  points: DailyPoint[],
  range: { from: Date; to: Date },
  timezone: string,
  now: Date = new Date(),
): DailyPoint[] {
  const byKey = new Map(points.map((p) => [p.day, p]));
  // to 는 exclusive — -1ms 로 경계 자체(다음날 00:00 버킷)는 제외하되, now 가 속한 시간은 포함
  const end = Math.min(range.to.getTime() - 1, now.getTime());
  const out = new Map<string, DailyPoint>();
  for (let t = range.from.getTime(); t <= end; t += HOUR_MS) {
    const key = hourKey(new Date(t), timezone);
    if (!out.has(key)) out.set(key, byKey.get(key) ?? zero(key));
  }
  for (const [key, p] of byKey) if (!out.has(key)) out.set(key, p);
  return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
