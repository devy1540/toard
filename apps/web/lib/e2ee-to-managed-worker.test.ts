import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encryptE2eeRecord } from "./e2ee-browser-crypto";
import {
  E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES,
} from "./e2ee-to-managed-contract";
import {
  createE2eeToManagedLoop,
  runE2eeToManagedBatch,
} from "./e2ee-to-managed-worker";

const OWNER = "018f47d0-4d47-7b04-950b-7d18a86e1b43";
const DIGEST = createHash("sha256").update("source").digest("base64url");

async function source(text = "secret prompt", id = "1") {
  const uck = crypto.getRandomValues(new Uint8Array(32));
  const record = await encryptE2eeRecord(uck, {
    dedupKey: `dedup-${id}`,
    sessionId: "session-1",
    providerKey: "codex",
    turnRole: "user",
    ts: "2026-07-14T00:00:00.000Z",
    text,
  }, OWNER, 1);
  return { uck, value: { id, sourceDigest: DIGEST, record } };
}

test("worker decrypts locally and commits only id, sourceDigest, and plaintext", async () => {
  const { uck, value } = await source();
  const uckBefore = uck.slice();
  const recordBefore = structuredClone(value.record);
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  const result = await runE2eeToManagedBatch({
    uck,
    fetchJson: async (url, init) => {
      requests.push({ url, init });
      if (init?.method === "POST") return { migrated: 1, remaining: 0, complete: true };
      return { records: [value] };
    },
  });

  const commit = requests.find((request) => request.url.endsWith("/commit"));
  assert.ok(commit);
  const body = String(commit.init?.body);
  const parsed = JSON.parse(body) as { items: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(parsed.items[0]!).sort(), ["id", "sourceDigest", "text"]);
  assert.equal(parsed.items[0]!.text, "secret prompt");
  assert.equal(body.includes(value.record.ciphertext), false);
  assert.equal(body.includes(value.record.authTag), false);
  assert.equal(body.includes(Buffer.from(uck).toString("base64url")), false);
  assert.deepEqual(result, {
    migrated: 1,
    remaining: 0,
    complete: true,
    payloadBytes: Buffer.byteLength(body, "utf8"),
  });
  assert.deepEqual(uck, uckBefore, "caller-owned UCK must not be mutated");
  assert.deepEqual(value.record, recordBefore, "caller-owned record must not be mutated");
});

test("worker zeroizes the decrypted byte buffer after success", async () => {
  const plaintext = new TextEncoder().encode("secret prompt");
  const { value } = await source();

  await runE2eeToManagedBatch({
    uck: new Uint8Array(32),
    decrypt: async () => plaintext,
    fetchJson: async (_url, init) => init?.method === "POST"
      ? { migrated: 1, remaining: 0, complete: true }
      : { records: [value] },
  });

  assert.deepEqual(plaintext, new Uint8Array(plaintext.byteLength));
});

test("worker uses fatal UTF-8 decoding and zeroizes bytes on failure", async () => {
  const invalidUtf8 = Uint8Array.of(0xc3, 0x28);
  const { value } = await source();
  let commits = 0;

  await assert.rejects(runE2eeToManagedBatch({
    uck: new Uint8Array(32),
    decrypt: async () => invalidUtf8,
    fetchJson: async (_url, init) => {
      if (init?.method === "POST") commits += 1;
      return { records: [value] };
    },
  }), TypeError);

  assert.deepEqual(invalidUtf8, new Uint8Array(invalidUtf8.byteLength));
  assert.equal(commits, 0);
});

test("worker omits the final item when it would exceed the 4MiB commit limit", async () => {
  const { value } = await source();
  const records = [
    { ...value, id: "1" },
    { ...value, id: "2" },
    { ...value, id: "3" },
  ];
  const texts = ["a".repeat(1_500_000), "b".repeat(1_500_000), "c".repeat(1_500_000)];
  const buffers: Uint8Array[] = [];
  let body = "";

  const result = await runE2eeToManagedBatch({
    uck: new Uint8Array(32),
    decrypt: async (_uck, record) => {
      const index = records.findIndex((item) => item.record === record);
      const bytes = new TextEncoder().encode(texts[index]!);
      buffers.push(bytes);
      return bytes;
    },
    fetchJson: async (_url, init) => {
      if (init?.method !== "POST") return { records };
      body = String(init.body);
      const items = (JSON.parse(body) as { items: unknown[] }).items;
      return { migrated: items.length, remaining: records.length - items.length, complete: false };
    },
  });

  assert.equal((JSON.parse(body) as { items: unknown[] }).items.length, 2);
  assert.ok(Buffer.byteLength(body, "utf8") <= E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES);
  assert.equal(result.payloadBytes, Buffer.byteLength(body, "utf8"));
  for (const bytes of buffers) assert.deepEqual(bytes, new Uint8Array(bytes.byteLength));
});

test("worker rejects an oversized single item without committing or mutating server input", async () => {
  const { value } = await source();
  const recordBefore = structuredClone(value.record);
  const oversized = new TextEncoder().encode("x".repeat(E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES));
  let commits = 0;

  await assert.rejects(runE2eeToManagedBatch({
    uck: new Uint8Array(32),
    decrypt: async () => oversized,
    fetchJson: async (_url, init) => {
      if (init?.method === "POST") commits += 1;
      return { records: [value] };
    },
  }), /MIGRATION_ITEM_TOO_LARGE/);

  assert.equal(commits, 0);
  assert.deepEqual(oversized, new Uint8Array(oversized.byteLength));
  assert.deepEqual(value.record, recordBefore);
});

test("worker does not commit an empty page and forwards AbortSignal", async () => {
  const controller = new AbortController();
  const requests: Array<RequestInit | undefined> = [];
  const result = await runE2eeToManagedBatch({
    uck: new Uint8Array(32),
    signal: controller.signal,
    fetchJson: async (_url, init) => {
      requests.push(init);
      return { records: [] };
    },
  });
  assert.deepEqual(result, { migrated: 0, remaining: 0, complete: true, payloadBytes: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.signal, controller.signal);
});

test("migration loop start is idempotent and disposes listeners and in-flight requests", async () => {
  let visibleListener: (() => void) | null = null;
  let onlineListener: (() => void) | null = null;
  let removedVisibility = 0;
  let removedOnline = 0;
  let statuses = 0;
  let abortedSignal: AbortSignal | null = null;
  const loop = createE2eeToManagedLoop({
    copyUck: () => new Uint8Array(32),
    fetchJson: async (url, init) => {
      if (url.endsWith("/status")) {
        statuses += 1;
        abortedSignal = init?.signal ?? null;
        return new Promise(() => undefined);
      }
      throw new Error("unexpected request");
    },
    environment: {
      isVisible: () => true,
      isOnline: () => true,
      onVisibilityChange: (listener) => {
        visibleListener = listener;
        return () => { removedVisibility += 1; visibleListener = null; };
      },
      onOnline: (listener) => {
        onlineListener = listener;
        return () => { removedOnline += 1; onlineListener = null; };
      },
    },
    onStatus: () => undefined,
    onComplete: () => undefined,
    onError: () => undefined,
  });

  loop.start();
  loop.start();
  await tick();
  assert.equal(statuses, 1, "StrictMode-style duplicate start must not duplicate requests");
  assert.ok(visibleListener);
  assert.ok(onlineListener);
  loop.dispose();
  loop.dispose();
  assert.equal(removedVisibility, 1);
  assert.equal(removedOnline, 1);
  assert.equal((abortedSignal as AbortSignal | null)?.aborted, true);
});

test("migration loop pauses while hidden or offline, finishes the current batch, and resumes on events", async () => {
  let visible = false;
  let online = true;
  let visibilityListener: () => void = () => undefined;
  let onlineListener: () => void = () => undefined;
  let statusCalls = 0;
  let commitCalls = 0;
  let completed = 0;
  const copies: Uint8Array[] = [];
  const { value } = await source();
  const loop = createE2eeToManagedLoop({
    copyUck: () => {
      const copy = new Uint8Array(32).fill(9);
      copies.push(copy);
      return copy;
    },
    decrypt: async () => new TextEncoder().encode("secret prompt"),
    fetchJson: async (url, init) => {
      if (url.endsWith("/status")) {
        statusCalls += 1;
        return {
          state: "running", e2eeRecords: 2, migratedRecords: 0,
          startedAt: null, completedAt: null, blockedAt: null, blockedReason: null,
        };
      }
      if (url.includes("/page")) return { records: [value] };
      if (url.endsWith("/commit") && init?.method === "POST") {
        commitCalls += 1;
        online = false;
        return { migrated: 1, remaining: 1, complete: false };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    environment: {
      isVisible: () => visible,
      isOnline: () => online,
      onVisibilityChange: (listener) => { visibilityListener = listener; return () => undefined; },
      onOnline: (listener) => { onlineListener = listener; return () => undefined; },
    },
    onStatus: () => undefined,
    onComplete: () => { completed += 1; },
    onError: (error) => { throw error; },
  });

  loop.start();
  await tick();
  assert.equal(statusCalls, 0);
  visible = true;
  visibilityListener();
  await waitFor(() => commitCalls === 1);
  assert.equal(commitCalls, 1, "current batch completes after going offline");
  await tick();
  assert.equal(statusCalls, 1, "offline state prevents another status request");
  assert.deepEqual(copies[0], new Uint8Array(32), "loop zeroizes its copied UCK");

  online = true;
  onlineListener();
  await waitFor(() => commitCalls === 2);
  assert.equal(statusCalls, 2);
  assert.equal(completed, 0);
  loop.dispose();
});

test("migration loop does not busy-poll a blocked or empty migration", async () => {
  for (const status of [
    { state: "blocked" as const, e2eeRecords: 1 },
    { state: "pending" as const, e2eeRecords: 0 },
  ]) {
    let calls = 0;
    const loop = createE2eeToManagedLoop({
      copyUck: () => new Uint8Array(32),
      fetchJson: async () => {
        calls += 1;
        return {
          ...status,
          migratedRecords: 0,
          startedAt: null,
          completedAt: null,
          blockedAt: null,
          blockedReason: status.state === "blocked" ? "key_unavailable" : null,
        };
      },
      environment: {
        isVisible: () => true,
        isOnline: () => true,
        onVisibilityChange: () => () => undefined,
        onOnline: () => () => undefined,
      },
      onStatus: () => undefined,
      onComplete: () => undefined,
      onError: (error) => { throw error; },
    });
    loop.start();
    await tick();
    await tick();
    assert.equal(calls, 1);
    loop.dispose();
  }
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("condition was not reached");
}
