import { redirect } from "next/navigation";

// 리더보드 구 URL 호환: 팀 scope 는 팀별 현황, 그 외는 전체 현황으로 보낸다.
export default async function LeaderboardRedirect({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; provider?: string; scope?: string; from?: string; to?: string }>;
}): Promise<never> {
  const sp = await searchParams;
  const q = new URLSearchParams();
  if (sp.period) q.set("period", sp.period);
  if (sp.provider) q.set("provider", sp.provider);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);
  const path = sp.scope === "team" || sp.scope === "department" ? "/org/teams" : "/org";
  const qs = q.toString();
  redirect(qs ? `${path}?${qs}` : path);
}
