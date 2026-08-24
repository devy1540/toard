import assert from "node:assert/strict";
import test from "node:test";
import { requireCronAuthorization } from "./cron-auth";

test("cron auth는 secret 미설정 시 fail-closed 한다", () => {
  const previous = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal(requireCronAuthorization(new Request("http://localhost/api/cron/test"))?.status, 503);
    process.env.CRON_SECRET = "";
    assert.equal(requireCronAuthorization(new Request("http://localhost/api/cron/test"))?.status, 503);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("cron auth는 정확한 Bearer secret만 허용한다", () => {
  const previous = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = "cron-test-secret";
    assert.equal(requireCronAuthorization(new Request("http://localhost/api/cron/test"))?.status, 401);
    assert.equal(requireCronAuthorization(new Request("http://localhost/api/cron/test", {
      headers: { authorization: "Bearer wrong" },
    }))?.status, 401);
    assert.equal(requireCronAuthorization(new Request("http://localhost/api/cron/test", {
      headers: { authorization: "Bearer cron-test-secret" },
    })), null);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
