import { getStorage } from "@/lib/storage";

// 런타임 DB 조회 — 빌드 시 prerender 하지 않음
export const dynamic = "force-dynamic";

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

export default async function OverviewPage() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const overview = await getStorage().getOverview({ from, to });

  return (
    <main>
      <h1>toard — 사용량 개요</h1>
      <p style={{ opacity: 0.7 }}>최근 30일</p>
      <section className="kpi-grid">
        <Kpi label="총 비용" value={`$${overview.totalCostUsd.toFixed(2)}`} />
        <Kpi label="세션" value={overview.totalSessions.toLocaleString()} />
        <Kpi label="활성 사용자" value={overview.activeUsers.toLocaleString()} />
        <Kpi label="입력 토큰" value={overview.totalInputTokens.toLocaleString()} />
        <Kpi label="출력 토큰" value={overview.totalOutputTokens.toLocaleString()} />
      </section>
    </main>
  );
}
