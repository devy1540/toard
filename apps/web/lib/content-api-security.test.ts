import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GET as historyGet } from "../app/api/content/history/sessions/route";
import { GET as statusGet } from "../app/api/content/status/route";

test("open mode blocks E2EE content endpoints with no-store", async () => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "open";
  try {
    const responses = await Promise.all([
      statusGet(),
      historyGet(new Request("http://localhost/api/content/history/sessions")),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { code: "E2EE_AUTH_REQUIRED" });
    }
  } finally {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
  }
});

test("history CSP uses per-request nonce and blocks active embedding", () => {
  const source = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.match(source, /script-src 'self' 'nonce-\$\{nonce\}'/);
  assert.match(source, /object-src 'none'/);
  assert.match(source, /base-uri 'none'/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /require-trusted-types-for 'script'/);
  assert.doesNotMatch(source, /script-src[^\n]*unsafe-inline/);
});
