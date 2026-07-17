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
import { assertLegacyContentKeyReady } from "../../../lib/legacy-content-readiness";
import {
  getContentEncryptionReadiness,
  type ContentEncryptionReadiness,
} from "../../../lib/content-encryption-readiness";
import {
  getManagedContentRuntime,
  type ManagedContentRuntime,
} from "../../../lib/managed-content-runtime";
import { assertDeploymentReleaseReady } from "../../../lib/deployment-release-readiness";

// Readiness: 실제 요청 처리에 필요한 DB 연결 가능할 때만 200 (아니면 503 → 트래픽 차단). K8s readinessProbe 용.
export const dynamic = "force-dynamic";

type ReadyDb = {
  query(sql: string, params?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
  }>;
};

type ReadyEnvironment = Record<string, string | undefined>;

type ReadyDependencies = {
  env: ReadyEnvironment;
  getPool(): ReadyDb;
  assertDeploymentReleaseReady(db: ReadyDb, env: ReadyEnvironment): Promise<void>;
  assertLegacyContentKeyReady(
    db: ReadyDb,
    env: ReadyEnvironment,
  ): Promise<void>;
  getManagedContentRuntime(): Promise<ManagedContentRuntime | null>;
  getContentEncryptionReadiness(
    db: ReadyDb,
    env: ReadyEnvironment,
    runtime: ManagedContentRuntime | null,
  ): Promise<ContentEncryptionReadiness>;
  pingClickHouse(): Promise<void>;
  getTimezoneRollupReadinessAt(
    db: ReadyDb,
    env: ReadyEnvironment,
  ): Promise<TimezoneRollupReadiness>;
  getServerVersion(): string;
};

const defaultReadyDependencies: ReadyDependencies = {
  env: process.env,
  getPool,
  assertDeploymentReleaseReady,
  assertLegacyContentKeyReady,
  getManagedContentRuntime,
  getContentEncryptionReadiness,
  pingClickHouse,
  getTimezoneRollupReadinessAt,
  getServerVersion,
};

function createGet(overrides: Partial<ReadyDependencies> = {}) {
  const dependencies = { ...defaultReadyDependencies, ...overrides };
  return async function readyGet(): Promise<Response> {
    try {
      const pool = dependencies.getPool();
      const env = dependencies.env;
      await pool.query("SELECT 1");
      await dependencies.assertDeploymentReleaseReady(pool, env);
      await dependencies.assertLegacyContentKeyReady(pool, env);
      const runtime = await dependencies.getManagedContentRuntime();
      const contentEncryption =
        await dependencies.getContentEncryptionReadiness(pool, env, runtime);
      if (env.STORAGE_BACKEND === "clickhouse") {
        await dependencies.pingClickHouse();
      }
      let timezoneRollup: TimezoneRollupReadiness = {
        status: "disabled",
        watermark: null,
        lagSeconds: null,
        pendingJobs: 0,
        legacyFlagMigration: null,
      };
      if (env.STORAGE_BACKEND === "clickhouse") {
        try {
          timezoneRollup =
            await dependencies.getTimezoneRollupReadinessAt(pool, env);
        } catch {
          // 기본 DB/ClickHouse ping이 성공했다면 cache 관측 실패는 traffic 차단 사유가 아니다.
          timezoneRollup = {
            status: "fallback",
            watermark: null,
            lagSeconds: null,
            pendingJobs: 0,
            legacyFlagMigration: env.CLICKHOUSE_READ_ROLLUP?.trim()
              ? "deprecated_alias"
              : null,
          };
        }
      }
      const serverVersion = dependencies.getServerVersion();
      return NextResponse.json({
        status: "ready",
        contentEncryption,
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
  };
}

export const GET = Object.assign(createGet(), { withDependencies: createGet });
