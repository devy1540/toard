import "dotenv/config";
import { activatePersistedTimezoneRollups } from "../apps/web/lib/timezone-rollup";

async function main(): Promise<void> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") {
    throw new Error("STORAGE_BACKEND=clickhouse 환경에서만 timezone rollup을 활성화할 수 있음");
  }
  const result = await activatePersistedTimezoneRollups();
  console.log(JSON.stringify({ ok: result.failed.length === 0, ...result }));
  if (result.failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
