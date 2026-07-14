import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryCsp, HISTORY_CACHE_CONTROL } from "./history-response-policy";

test("history CSP keeps nonce protection without unsupported Trusted Types enforcement", () => {
  const csp = createHistoryCsp("nonce-value");

  assert.match(csp, /script-src 'self' 'nonce-nonce-value'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /require-trusted-types-for/);
  assert.equal(HISTORY_CACHE_CONTROL, "no-store, no-transform");
});
