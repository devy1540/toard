// Next.js instrumentation — 서버 프로세스 기동 시 1회 실행된다 (Next 15 정식 기능).
// pg 등 Node 전용 의존성이 edge 번들에 끌려가지 않도록 register 안에서 동적 import 한다.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { schedulerEligible, startPricingAutoSync } = await import("./lib/pricing-auto-sync");
  if (schedulerEligible(process.env)) startPricingAutoSync();
  const { retentionSchedulerEligible, startUsageRetentionCleanup } = await import("./lib/retention-cleanup");
  if (retentionSchedulerEligible(process.env)) startUsageRetentionCleanup();
  const { startRollupCoordinator } = await import("./lib/rollup-coordinator");
  startRollupCoordinator();
  const { toolDeploymentExperimentalEnabled } = await import("./lib/tool-deployment-feature");
  if (toolDeploymentExperimentalEnabled()) {
    const { startToolRolloutCoordinator } = await import("./lib/tool-rollout-coordinator");
    startToolRolloutCoordinator();
  }
  if (process.env.STORAGE_BACKEND === "clickhouse") {
    const {
      startClickHouseOutboxFlush,
    } = await import("./lib/clickhouse-outbox");
    const { activatePersistedTimezoneRollupsNonBlocking } = await import("./lib/timezone-rollup");
    activatePersistedTimezoneRollupsNonBlocking();
    startClickHouseOutboxFlush();
  }
}
