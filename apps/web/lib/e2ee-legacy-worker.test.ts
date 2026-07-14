import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runLegacyMigrationBatch } from "./e2ee-legacy-worker";

const source = {
  id: "1",
  dedupKey: "legacy-1",
  sessionId: "session-1",
  providerKey: "codex",
  turnRole: "user" as const,
  ts: "2026-07-14T00:00:00.000Z",
  text: "legacy secret",
  sourceDigest: createHash("sha256").update("legacy secret").digest("base64url"),
};

test("legacy worker encrypts, verifies, and commits one page", async () => {
  const calls: string[] = [];
  const result = await runLegacyMigrationBatch({
    deviceId: "22222222-2222-4222-8222-222222222222",
    contentOwnerId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
    contentKeyVersion: 1,
    uck: crypto.getRandomValues(new Uint8Array(32)),
    fetchJson: async (url, init) => {
      calls.push(url);
      if (init?.method === "POST") return { migrated: 1, alreadyMigrated: 0 };
      return { records: [source] };
    },
  });
  assert.deepEqual(result, { migrated: 1, alreadyMigrated: 0, complete: false });
  assert.deepEqual(calls, [
    "/api/content/legacy-migration/page?limit=25",
    "/api/content/legacy-migration/commit",
  ]);
});

test("legacy worker completes without commit for an empty page", async () => {
  let commits = 0;
  const result = await runLegacyMigrationBatch({
    deviceId: "22222222-2222-4222-8222-222222222222",
    contentOwnerId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
    contentKeyVersion: 1,
    uck: new Uint8Array(32),
    fetchJson: async (_url, init) => {
      if (init?.method === "POST") commits += 1;
      return { records: [] };
    },
  });
  assert.deepEqual(result, { migrated: 0, alreadyMigrated: 0, complete: true });
  assert.equal(commits, 0);
});
