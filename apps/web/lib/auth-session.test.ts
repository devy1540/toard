import assert from "node:assert/strict";
import test from "node:test";
import { resolveMfaSessionId } from "./auth-session";

test("a legacy JWT gets the same MFA session ID on every read", () => {
  const token = { uid: "user-1", iat: 1_700_000_000, jti: "legacy-session-1" };
  const first = resolveMfaSessionId(token);
  const second = resolveMfaSessionId(token);

  assert.ok(first);
  assert.equal(second, first);
  assert.notEqual(resolveMfaSessionId({ ...token, jti: "legacy-session-2" }), first);
});

test("an existing or newly-issued MFA session ID takes precedence", () => {
  assert.equal(resolveMfaSessionId({ mfaSid: "existing", jti: "legacy" }), "existing");
  assert.equal(resolveMfaSessionId({ mfaSid: "existing" }, "new-sign-in"), "new-sign-in");
});

test("legacy fallback remains session-bound without a jti", () => {
  const first = resolveMfaSessionId({ uid: "user-1", iat: 100 });
  assert.ok(first);
  assert.equal(resolveMfaSessionId({ uid: "user-1", iat: 100 }), first);
  assert.notEqual(resolveMfaSessionId({ uid: "user-1", iat: 101 }), first);
  assert.equal(resolveMfaSessionId({ uid: "user-1" }), undefined);
});
