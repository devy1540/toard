/** KST(UTC+9) 기준 날짜 'YYYY-MM-DD'. offsetDays 음수면 과거 일자. */
export function kstDate(offsetDays = 0): string {
  const ms = Date.now() + offsetDays * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}
