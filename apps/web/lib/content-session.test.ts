import assert from "node:assert/strict";
import test from "node:test";
import { requireContentSessionWith } from "./content-session";

test("content session rejects open mode and every fallback without a real session", async () => {
  assert.equal(await requireContentSessionWith({ authMode: "open", sessionUserId: null }), null);
  assert.equal(await requireContentSessionWith({ authMode: "oauth", sessionUserId: null }), null);
  assert.equal(await requireContentSessionWith({ authMode: "oauth", sessionUserId: "u1" }), "u1");
});
