import "dotenv/config";
import { closePool } from "../apps/web/lib/db";
import { closeStorage } from "../apps/web/lib/storage";
import { activatePersistedTimezoneRollups } from "../apps/web/lib/timezone-rollup";

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    if (process.env.STORAGE_BACKEND !== "clickhouse") {
      throw new Error("STORAGE_BACKEND=clickhouse 환경에서만 timezone rollup을 활성화할 수 있음");
    }
    const result = await activatePersistedTimezoneRollups();
    console.log(JSON.stringify({ ok: result.failed.length === 0, ...result }));
    if (result.failed.length > 0) exitCode = 1;
  } catch (error) {
    console.error(String(error));
    exitCode = 1;
  } finally {
    try {
      await closeStorage();
    } catch (error) {
      console.error(`ClickHouse client 종료 실패: ${String(error)}`);
      exitCode = 1;
    }
    try {
      await closePool();
    } catch (error) {
      console.error(`PostgreSQL pool 종료 실패: ${String(error)}`);
      exitCode = 1;
    }
    process.exitCode = exitCode;
  }
}

void main();
