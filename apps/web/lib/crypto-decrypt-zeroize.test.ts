import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { type TestContext } from "node:test";
import { decryptContent, type EncryptedContent } from "./legacy-content-crypto";
import { decryptManagedContent, type ManagedEncryptedContent } from "./managed-content-crypto";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";

type ChunkPair = { update: Buffer; final?: Buffer; finalError?: Error };

function installDecryptInstrumentation(t: TestContext, pairs: ChunkPair[]) {
  const outputs: Buffer[] = [];
  const filled = new Set<Buffer>();
  const originalConcat = Buffer.concat.bind(Buffer);
  const originalFill = Buffer.prototype.fill;
  let decipherIndex = 0;

  t.mock.method(Buffer.prototype, "fill", (function (this: Buffer, ...args: unknown[]) {
    filled.add(this);
    return Reflect.apply(originalFill, this, args);
  }) as unknown as typeof Buffer.prototype.fill);
  t.mock.method(Buffer, "concat", ((list: readonly Uint8Array[]) => {
    const output = originalConcat(list);
    outputs.push(output);
    return output;
  }) as typeof Buffer.concat);
  t.mock.method(crypto, "createDecipheriv", (() => {
    const pair = pairs[decipherIndex++];
    assert.ok(pair, "unexpected createDecipheriv call");
    return {
      setAAD() { return this; },
      setAuthTag() { return this; },
      update() { return pair.update; },
      final() {
        if (pair.finalError) throw pair.finalError;
        return pair.final ?? Buffer.alloc(0);
      },
    };
  }) as unknown as typeof crypto.createDecipheriv);
  return { outputs, filled, calls: () => decipherIndex };
}

function assertZero(buffer: Buffer): void {
  assert.deepEqual(buffer, Buffer.alloc(buffer.length));
}

function legacyRow(): EncryptedContent {
  return {
    keyVersion: 1,
    wrappedDek: Buffer.alloc(60, 0x11),
    iv: Buffer.alloc(12, 0x12),
    ciphertext: Buffer.alloc(8, 0x13),
    authTag: Buffer.alloc(16, 0x14),
  };
}

function managedRow(): ManagedEncryptedContent & {
  dedupKey: string;
  providerKey: string;
  turnRole: "user";
  ts: Date;
} {
  return {
    encryptionScheme: "managed_v1",
    contentKeyVersion: 3,
    aadVersion: 2,
    wrappedDek: Buffer.alloc(32, 0x21),
    dekWrapIv: Buffer.alloc(12, 0x22),
    dekWrapAuthTag: Buffer.alloc(16, 0x23),
    iv: Buffer.alloc(12, 0x24),
    ciphertext: Buffer.alloc(8, 0x25),
    authTag: Buffer.alloc(16, 0x26),
    dedupKey: "managed-zeroize",
    providerKey: "codex",
    turnRole: "user",
    ts: new Date("2026-07-17T03:04:05.678Z"),
  };
}

test("legacy decrypt wipes update/final chunks and caller-owned concat outputs on success", (t) => {
  const row = legacyRow();
  const kek = Buffer.alloc(32, 0x15);
  const rowBefore = Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    Buffer.isBuffer(value) ? Buffer.from(value) : value,
  ]));
  const kekBefore = Buffer.from(kek);
  const pairs: ChunkPair[] = [
    { update: Buffer.alloc(32, 0x31), final: Buffer.alloc(0) },
    { update: Buffer.from("legacy success", "utf8"), final: Buffer.alloc(0) },
  ];
  const instrumented = installDecryptInstrumentation(t, pairs);

  assert.equal(decryptContent(row, kek), "legacy success");
  assert.equal(instrumented.calls(), 2);
  for (const pair of pairs) {
    assert.equal(instrumented.filled.has(pair.update), true);
    assert.equal(instrumented.filled.has(pair.final!), true);
    assertZero(pair.update);
    assertZero(pair.final!);
  }
  assert.equal(instrumented.outputs.length, 2);
  for (const output of instrumented.outputs) {
    assert.equal(instrumented.filled.has(output), true);
    assertZero(output);
  }
  assert.deepEqual(row, rowBefore);
  assert.deepEqual(kek, kekBefore);
});

test("legacy decrypt wipes prior output and update chunk when auth final throws", (t) => {
  const row = legacyRow();
  const kek = Buffer.alloc(32, 0x15);
  const rowBefore = {
    wrappedDek: Buffer.from(row.wrappedDek),
    iv: Buffer.from(row.iv),
    ciphertext: Buffer.from(row.ciphertext),
    authTag: Buffer.from(row.authTag),
  };
  const kekBefore = Buffer.from(kek);
  const pairs: ChunkPair[] = [
    { update: Buffer.alloc(32, 0x41), final: Buffer.alloc(0) },
    { update: Buffer.from("must wipe", "utf8"), finalError: new Error("auth final failed") },
  ];
  const instrumented = installDecryptInstrumentation(t, pairs);

  assert.throws(() => decryptContent(row, kek), /auth final failed/);
  assert.equal(instrumented.filled.has(pairs[0]!.update), true);
  assert.equal(instrumented.filled.has(pairs[0]!.final!), true);
  assert.equal(instrumented.filled.has(pairs[1]!.update), true);
  assertZero(pairs[0]!.update);
  assertZero(pairs[0]!.final!);
  assertZero(pairs[1]!.update);
  assert.equal(instrumented.outputs.length, 1);
  assert.equal(instrumented.filled.has(instrumented.outputs[0]!), true);
  assertZero(instrumented.outputs[0]!);
  assert.deepEqual(row.wrappedDek, rowBefore.wrappedDek);
  assert.deepEqual(row.iv, rowBefore.iv);
  assert.deepEqual(row.ciphertext, rowBefore.ciphertext);
  assert.deepEqual(row.authTag, rowBefore.authTag);
  assert.deepEqual(kek, kekBefore);
});

test("managed decrypt wipes both decrypt stages and preserves caller inputs", (t) => {
  const row = managedRow();
  const uck = Buffer.alloc(32, 0x27);
  const encryptedBefore = Object.fromEntries(Object.entries(row)
    .filter(([, value]) => Buffer.isBuffer(value))
    .map(([key, value]) => [key, Buffer.from(value as Buffer)]));
  const uckBefore = Buffer.from(uck);
  const pairs: ChunkPair[] = [
    { update: Buffer.alloc(32, 0x51), final: Buffer.alloc(0) },
    { update: Buffer.from("managed success", "utf8"), final: Buffer.alloc(0) },
  ];
  const instrumented = installDecryptInstrumentation(t, pairs);

  assert.equal(decryptManagedContent(row, uck, INSTALLATION_ID, USER_ID), "managed success");
  for (const pair of pairs) {
    assert.equal(instrumented.filled.has(pair.update), true);
    assert.equal(instrumented.filled.has(pair.final!), true);
    assertZero(pair.update);
    assertZero(pair.final!);
  }
  assert.equal(instrumented.outputs.length, 2);
  for (const output of instrumented.outputs) {
    assert.equal(instrumented.filled.has(output), true);
    assertZero(output);
  }
  for (const [key, value] of Object.entries(encryptedBefore)) {
    assert.deepEqual(row[key as keyof typeof row], value);
  }
  assert.deepEqual(uck, uckBefore);
});

test("managed decrypt wipes DEK output and body update chunk on final failure", (t) => {
  const row = managedRow();
  const uck = Buffer.alloc(32, 0x27);
  const pairs: ChunkPair[] = [
    { update: Buffer.alloc(32, 0x61), final: Buffer.alloc(0) },
    { update: Buffer.from("managed must wipe", "utf8"), finalError: new Error("tag rejected") },
  ];
  const instrumented = installDecryptInstrumentation(t, pairs);

  assert.throws(
    () => decryptManagedContent(row, uck, INSTALLATION_ID, USER_ID),
    (error: unknown) => error instanceof Error && error.message === "CONTENT_DECRYPT_FAILED",
  );
  assert.equal(instrumented.filled.has(pairs[0]!.update), true);
  assert.equal(instrumented.filled.has(pairs[0]!.final!), true);
  assert.equal(instrumented.filled.has(pairs[1]!.update), true);
  assertZero(pairs[0]!.update);
  assertZero(pairs[0]!.final!);
  assertZero(pairs[1]!.update);
  assert.equal(instrumented.outputs.length, 1);
  assert.equal(instrumented.filled.has(instrumented.outputs[0]!), true);
  assertZero(instrumented.outputs[0]!);
});
