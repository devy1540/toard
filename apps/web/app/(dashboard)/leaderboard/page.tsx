import { redirect } from "next/navigation";

// 리더보드는 전체 현황(/org)의 순위 탭으로 통합됨 — 기존 링크 호환용 리다이렉트(필터·scope 유지).
export default async function LeaderboardRedirect({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; provider?: string; scope?: string; from?: string; to?: string }>;
}): Promise<never> {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "ranking" });
  if (sp.period) q.set("period", sp.period);
  if (sp.provider) q.set("provider", sp.provider);
  if (sp.scope) q.set("scope", sp.scope);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);
  redirect(`/org?${q.toString()}`);
}
