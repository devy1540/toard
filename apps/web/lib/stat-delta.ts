import type { StatDelta } from "@/components/dashboard/stat-card";

/**
 * 직전 동일 길이 기간 대비 증감 — 비교 기준(0)이 없거나 변화 0이면 배지 생략(null).
 * 직전 기간이 극소량이면 수만 % 로 폭주해 오히려 노이즈 — ±999% 로 클램프해 표시.
 * (내 사용량·전체 현황 스탯카드가 공유)
 */
export function pctDelta(curr: number, prev: number): StatDelta | null {
  if (prev <= 0) return null;
  const raw = Math.round(((curr - prev) / prev) * 100);
  if (raw === 0) return null;
  const clamped = Math.max(-999, Math.min(999, raw));
  const overflow = raw !== clamped ? ">" : "";
  return { pct: `${overflow}${clamped >= 0 ? "+" : ""}${clamped}%`, direction: raw > 0 ? "up" : "down" };
}
