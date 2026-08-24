import assert from "node:assert/strict";
import test from "node:test";
import { GET as flushClickHouseOutbox } from "./flush-clickhouse-outbox/route";
import { GET as recompute } from "./recompute/route";
import { GET as syncPricing } from "./sync-pricing/route";
import { GET as teamAttribution } from "./team-attribution/route";

const routes = [
  ["recompute", recompute],
  ["sync-pricing", syncPricing],
  ["team-attribution", teamAttribution],
  ["flush-clickhouse-outbox", flushClickHouseOutbox],
] as const;

test("모든 mutation cron route는 secret 미설정과 잘못된 bearer에서 실행 전에 차단된다", async () => {
  const previous = process.env.CRON_SECRET;
  try {
    for (const [name, handler] of routes) {
      delete process.env.CRON_SECRET;
      const missing = await handler(new Request(`http://localhost/api/cron/${name}`));
      assert.equal(missing.status, 503, `${name}: missing secret`);

      process.env.CRON_SECRET = "cron-route-test-secret";
      const invalid = await handler(new Request(`http://localhost/api/cron/${name}`, {
        headers: { authorization: "Bearer wrong" },
      }));
      assert.equal(invalid.status, 401, `${name}: invalid bearer`);
    }
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
