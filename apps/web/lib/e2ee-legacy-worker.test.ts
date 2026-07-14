import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  LEGACY_MIGRATION_INITIAL_BATCH_SIZE,
  LEGACY_MIGRATION_MAX_PAYLOAD_BYTES,
  nextLegacyMigrationBatchLimit,
  runLegacyMigrationBatch,
} from "./e2ee-legacy-worker";

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
  assert.equal(result.migrated, 1);
  assert.equal(result.alreadyMigrated, 0);
  assert.equal(result.complete, false);
  assert.ok(result.payloadBytes > 0);
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
  assert.deepEqual(result, { migrated: 0, alreadyMigrated: 0, complete: true, payloadBytes: 0 });
  assert.equal(commits, 0);
});

test("legacy worker uses the requested adaptive page limit", async () => {
  const calls: string[] = [];
  await runLegacyMigrationBatch({
    deviceId: "22222222-2222-4222-8222-222222222222",
    contentOwnerId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
    contentKeyVersion: 1,
    batchLimit: 50,
    uck: crypto.getRandomValues(new Uint8Array(32)),
    fetchJson: async (url) => {
      calls.push(url);
      return { records: [] };
    },
  });
  assert.equal(calls[0], "/api/content/legacy-migration/page?limit=50");
});

test("adaptive batch doubles fast small work and halves slow or large work", () => {
  assert.equal(LEGACY_MIGRATION_INITIAL_BATCH_SIZE, 25);
  assert.equal(nextLegacyMigrationBatchLimit(25, 200, 512 * 1024), 50);
  assert.equal(nextLegacyMigrationBatchLimit(50, 200, 512 * 1024), 100);
  assert.equal(nextLegacyMigrationBatchLimit(100, 200, 512 * 1024), 100);
  assert.equal(nextLegacyMigrationBatchLimit(100, 1_001, 512 * 1024), 50);
  assert.equal(nextLegacyMigrationBatchLimit(50, 500, 3 * 1024 * 1024 + 1), 25);
  assert.equal(nextLegacyMigrationBatchLimit(25, 1_001, 512 * 1024), 25);
  assert.equal(nextLegacyMigrationBatchLimit(25, 300, 512 * 1024), 25);
  assert.equal(nextLegacyMigrationBatchLimit(25, 200, 1024 * 1024), 25);
  assert.equal(nextLegacyMigrationBatchLimit(50, 1_000, 2 * 1024 * 1024), 50);
  assert.equal(nextLegacyMigrationBatchLimit(50, 500, 3 * 1024 * 1024), 50);
});

test("legacy worker keeps the commit body within 4MB", async () => {
  const largeSources = Array.from({ length: 6 }, (_, index) => ({
    ...source,
    id: String(index + 1),
    dedupKey: `legacy-${index + 1}`,
    text: "x".repeat(800_000),
    sourceDigest: createHash("sha256").update("x".repeat(800_000)).digest("base64url"),
  }));
  let committed = 0;
  let payloadBytes = 0;
  const result = await runLegacyMigrationBatch({
    deviceId: "22222222-2222-4222-8222-222222222222",
    contentOwnerId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
    contentKeyVersion: 1,
    batchLimit: 100,
    uck: crypto.getRandomValues(new Uint8Array(32)),
    fetchJson: async (_url, init) => {
      if (init?.method !== "POST") return { records: largeSources };
      payloadBytes = Buffer.byteLength(String(init.body), "utf8");
      committed = (JSON.parse(String(init.body)) as { items: unknown[] }).items.length;
      return { migrated: committed, alreadyMigrated: 0 };
    },
  });
  assert.ok(committed > 0);
  assert.ok(committed < largeSources.length);
  assert.ok(payloadBytes <= LEGACY_MIGRATION_MAX_PAYLOAD_BYTES);
  assert.equal(result.payloadBytes, payloadBytes);
});
