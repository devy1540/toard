import { NextResponse } from "next/server";
import { pingClickHouse } from "@toard/storage-clickhouse";
import { getPool } from "../../../lib/db";
import {
  getTimezoneRollupReadinessAt,
  toTimezoneRollupReadyPayload,
  type TimezoneRollupReadiness,
} from "../../../lib/clickhouse-outbox";
import {
  getServerVersion,
  HISTORICAL_PRICING_MIN_READER_VERSION,
  supportsHistoricalPricingReader,
} from "../../../lib/version";

// Readiness: 실제 요청 처리에 필요한 DB 연결 가능할 때만 200 (아니면 503 → 트래픽 차단). K8s readinessProbe 용.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    if (process.env.STORAGE_BACKEND === "clickhouse") await pingClickHouse();
    let timezoneRollup: TimezoneRollupReadiness = {
      status: "disabled",
      watermark: null,
      lagSeconds: null,
      pendingJobs: 0,
      legacyFlagMigration: null,
    };
    if (process.env.STORAGE_BACKEND === "clickhouse") {
      try {
        timezoneRollup = await getTimezoneRollupReadinessAt(pool, process.env);
      } catch {
        // 기본 DB/ClickHouse ping이 성공했다면 cache 관측 실패는 traffic 차단 사유가 아니다.
        timezoneRollup = {
          status: "fallback",
          watermark: null,
          lagSeconds: null,
          pendingJobs: 0,
          legacyFlagMigration: process.env.CLICKHOUSE_READ_ROLLUP?.trim()
            ? "deprecated_alias"
            : null,
        };
      }
    }
    const serverVersion = getServerVersion();
    return NextResponse.json({
      status: "ready",
      rollups: toTimezoneRollupReadyPayload(timezoneRollup),
      historicalPricingReader: {
        currentVersion: serverVersion,
        minimumVersion: HISTORICAL_PRICING_MIN_READER_VERSION,
        compatible: supportsHistoricalPricingReader(serverVersion),
      },
    });
  } catch {
    return NextResponse.json({ status: "not-ready" }, { status: 503 });
  }
}
