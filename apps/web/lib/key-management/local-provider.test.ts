import assert from "node:assert/strict";
import test from "node:test";
import { LocalKeyManagementProvider } from "./local-provider";
import type { KeyContext } from "./types";

const CONTEXT: KeyContext = {
  installationId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
  userId: "01900000-0000-7000-8000-000000000001",
  keyVersion: 1,
  purpose: "prompt-history",
};

test("local provider는 context payload를 AES-GCM으로 감싸고 secret을 노출하지 않는다", async () => {
  const kek = Buffer.alloc(32, 0xa5);
  const reads: unknown[] = [];
  const provider = new LocalKeyManagementProvider({
    keyFile: "/run/secrets/toard-local-kek",
    readFile(path) {
      reads.push(path);
      return kek;
    },
  });
  const uck = Buffer.alloc(32, 9);
  const wrapped = await provider.wrapKey(uck, CONTEXT);

  assert.deepEqual(reads, ["/run/secrets/toard-local-kek"]);
  assert.equal(provider.name, "local");
  assert.equal(provider.keyRef, "file:/run/secrets/toard-local-kek");
  assert.match(provider.fingerprint, /^local:[0-9a-f]{24}$/);
  assert.equal(wrapped.provider, "local");
  assert.equal(wrapped.keyRef, provider.keyRef);
  assert.equal(wrapped.fingerprint, provider.fingerprint);
  assert.deepEqual(wrapped.metadata, {
    algorithm: "aes-256-gcm",
    format: "local-v1",
  });
  assert.equal(wrapped.ciphertext.length, 96);
  assert.equal(wrapped.ciphertext.includes(uck), false);
  assert.equal(JSON.stringify(wrapped.metadata).includes(kek.toString("hex")), false);
  assert.deepEqual(await provider.unwrapKey(wrapped, CONTEXT), uck);
  await assert.rejects(
    provider.unwrapKey(wrapped, { ...CONTEXT, keyVersion: 2 }),
    /CONTEXT/,
  );
  assert.deepEqual(await provider.describeCredentialSource(), {
    kind: "secret-file",
    staticCredential: true,
  });
  assert.equal((await provider.healthCheck()).status, "healthy");
});

test("local provider는 절대 secret-file 경로의 정확히 32바이트만 받는다", () => {
  assert.throws(
    () => new LocalKeyManagementProvider({
      keyFile: "relative/kek",
      readFile: () => Buffer.alloc(32),
    }),
    /LOCAL_KEK_FILE_PATH_MUST_BE_ABSOLUTE/,
  );
  assert.throws(
    () => new LocalKeyManagementProvider({
      keyFile: "/run/secrets/short-kek",
      readFile: () => Buffer.alloc(31),
    }),
    /LOCAL_KEK_FILE_MUST_BE_32_BYTES/,
  );
  assert.throws(
    () => new LocalKeyManagementProvider({
      keyFile: "/run/secrets/long-kek",
      readFile: () => Buffer.alloc(33),
    }),
    /LOCAL_KEK_FILE_MUST_BE_32_BYTES/,
  );
  assert.throws(
    () => new LocalKeyManagementProvider({
      keyFile: "/run/secrets/text-kek",
      readFile: (() => "x".repeat(32)) as unknown as (path: string) => Buffer,
    }),
    /LOCAL_KEK_FILE_MUST_BE_32_BYTES/,
  );
});

test("local provider는 wrapper identity와 ciphertext 변조를 fail-closed한다", async () => {
  const provider = new LocalKeyManagementProvider({
    keyFile: "/run/secrets/toard-local-kek",
    readFile: () => Buffer.alloc(32, 4),
  });
  const wrapped = await provider.wrapKey(Buffer.alloc(32, 9), CONTEXT);

  await assert.rejects(
    provider.unwrapKey({ ...wrapped, keyRef: "file:/run/secrets/other" }, CONTEXT),
    /LOCAL_KEY_WRAPPER_MISMATCH/,
  );
  await assert.rejects(
    provider.unwrapKey({ ...wrapped, ciphertext: wrapped.ciphertext.subarray(0, 95) }, CONTEXT),
    /LOCAL_KEY_CIPHERTEXT_INVALID/,
  );
  const tampered = Buffer.from(wrapped.ciphertext);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  await assert.rejects(
    provider.unwrapKey({ ...wrapped, ciphertext: tampered }, CONTEXT),
    /CONTEXT_OR_CIPHERTEXT/,
  );
});
