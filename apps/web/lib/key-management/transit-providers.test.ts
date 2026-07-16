import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalKeyContext,
  encodeUserKeyPayload,
} from "./context";
import { OpenBaoTransitProvider } from "./openbao-transit-provider";
import type { TransitClientLike } from "./transit-client";
import { VaultTransitProvider } from "./vault-transit-provider";
import type { KeyContext } from "./types";

const CONTEXT: KeyContext = {
  installationId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
  userId: "01900000-0000-7000-8000-000000000001",
  keyVersion: 1,
  purpose: "prompt-history",
};
const UCK = Buffer.alloc(32, 0x4a);

class RecordingTransitClient implements TransitClientLike {
  readonly address = "https://vault.example.com/";
  readonly mount = "transit";
  readonly keyName = "toard";
  readonly namespace = "team-a";
  readonly keyRef = "https://vault.example.com/v1/transit/keys/toard";
  readonly encryptInputs: Array<{ payload: Buffer; aad: Buffer }> = [];
  readonly decryptInputs: Array<{ ciphertext: string; aad: Buffer }> = [];
  decryptedPayload = encodeUserKeyPayload(UCK, CONTEXT);

  async encrypt(payload: Buffer, aad: Buffer): Promise<string> {
    this.encryptInputs.push({
      payload: Buffer.from(payload),
      aad: Buffer.from(aad),
    });
    this.decryptedPayload = Buffer.from(payload);
    return "vault:v1:ciphertext";
  }

  async decrypt(ciphertext: string, aad: Buffer): Promise<Buffer> {
    this.decryptInputs.push({
      ciphertext,
      aad: Buffer.from(aad),
    });
    return this.decryptedPayload;
  }

  async describeCredentialSource() {
    return {
      kind: "transit-kubernetes",
      staticCredential: false,
    };
  }
}

test("Vault/OpenBao provider는 68-byte payload와 canonical AAD를 사용하고 identity를 분리한다", async () => {
  const vaultClient = new RecordingTransitClient();
  const openBaoClient = new RecordingTransitClient();
  const vault = new VaultTransitProvider({ client: vaultClient });
  const openbao = new OpenBaoTransitProvider({ client: openBaoClient });

  const vaultWrapped = await vault.wrapKey(UCK, CONTEXT);
  const openBaoWrapped = await openbao.wrapKey(UCK, CONTEXT);
  assert.equal(vaultClient.encryptInputs[0]!.payload.length, 68);
  assert.notDeepEqual(vaultClient.encryptInputs[0]!.payload, UCK);
  assert.deepEqual(
    vaultClient.encryptInputs[0]!.payload,
    encodeUserKeyPayload(UCK, CONTEXT),
  );
  assert.deepEqual(
    vaultClient.encryptInputs[0]!.aad,
    canonicalKeyContext(CONTEXT),
  );
  assert.deepEqual(vaultWrapped, {
    provider: "vault-transit",
    keyRef: vaultClient.keyRef,
    fingerprint: vault.fingerprint,
    ciphertext: Buffer.from("vault:v1:ciphertext"),
    metadata: {
      algorithm: "transit-aead",
      format: "vault-ciphertext-v1",
    },
  });
  assert.equal(openBaoWrapped.provider, "openbao-transit");
  assert.notEqual(vault.fingerprint, openbao.fingerprint);
  assert.match(vault.fingerprint, /^vault-transit:[0-9a-f]{24}$/);
  assert.match(openbao.fingerprint, /^openbao-transit:[0-9a-f]{24}$/);
  assert.deepEqual(await vault.unwrapKey(vaultWrapped, CONTEXT), UCK);
  assert.deepEqual(vaultClient.decryptInputs[0], {
    ciphertext: "vault:v1:ciphertext",
    aad: canonicalKeyContext(CONTEXT),
  });
  assert.deepEqual(await vault.describeCredentialSource(), {
    kind: "transit-kubernetes",
    staticCredential: false,
  });
});

test("Transit provider는 unwrap 전에 provider/keyRef/fingerprint를 검증한다", async () => {
  const client = new RecordingTransitClient();
  const provider = new VaultTransitProvider({ client });
  const wrapped = await provider.wrapKey(UCK, CONTEXT);

  for (const mismatch of [
    { ...wrapped, provider: "openbao-transit" as const },
    { ...wrapped, keyRef: `${wrapped.keyRef}/other` },
    { ...wrapped, fingerprint: "vault-transit:000000000000000000000000" },
  ]) {
    await assert.rejects(
      provider.unwrapKey(mismatch, CONTEXT),
      (error: Error) => error.message === "vault-transit:WRAPPER_MISMATCH",
    );
  }
  assert.equal(client.decryptInputs.length, 0);
});

test("Transit provider는 malformed ciphertext/plaintext/context와 client 오류를 redaction한다", async () => {
  const client = new RecordingTransitClient();
  const provider = new VaultTransitProvider({ client });
  const wrapped = await provider.wrapKey(UCK, CONTEXT);
  await assert.rejects(
    provider.unwrapKey({ ...wrapped, ciphertext: Buffer.alloc(0) }, CONTEXT),
    (error: Error) => error.message === "vault-transit:INVALID_CIPHERTEXT",
  );
  await assert.rejects(
    provider.unwrapKey({ ...wrapped, ciphertext: Buffer.from([0xff]) }, CONTEXT),
    (error: Error) => error.message === "vault-transit:INVALID_CIPHERTEXT",
  );

  client.encrypt = async () => " \r\n";
  await assert.rejects(
    provider.wrapKey(UCK, CONTEXT),
    (error: Error) => error.message === "vault-transit:INVALID_CIPHERTEXT",
  );

  client.decryptedPayload = encodeUserKeyPayload(
    UCK,
    { ...CONTEXT, userId: "other-user" },
  );
  await assert.rejects(
    provider.unwrapKey(wrapped, CONTEXT),
    (error: Error) => error.message === "vault-transit:INVALID_PLAINTEXT",
  );

  const secret = UCK.toString("base64");
  client.encrypt = async () => {
    throw new Error(`TRANSIT:THROTTLED token=${secret}`);
  };
  await assert.rejects(
    provider.wrapKey(UCK, CONTEXT),
    (error: Error) => (
      error.message === "vault-transit:THROTTLED"
      && !error.message.includes(secret)
    ),
  );
});

test("Transit fingerprint는 provider/address/mount/keyName/namespace만 반영한다", () => {
  const firstClient = new RecordingTransitClient();
  const secondClient = new RecordingTransitClient();
  secondClient.describeCredentialSource = async () => ({
    kind: "transit-approle",
    staticCredential: true,
  });
  const first = new VaultTransitProvider({ client: firstClient });
  const second = new VaultTransitProvider({ client: secondClient });
  assert.equal(first.fingerprint, second.fingerprint);

  const namespaceChanged = Object.assign(new RecordingTransitClient(), {
    namespace: "team-b",
  }) as TransitClientLike;
  assert.notEqual(
    first.fingerprint,
    new VaultTransitProvider({ client: namespaceChanged }).fingerprint,
  );
});

test("Transit provider healthCheck는 wrap/unwrap 결과만 비민감하게 보고한다", async () => {
  const client = new RecordingTransitClient();
  const provider = new VaultTransitProvider({ client });
  assert.equal((await provider.healthCheck()).status, "healthy");

  client.encrypt = async () => {
    throw new Error("TRANSIT:AUTH_FAILED token=secret");
  };
  const health = await provider.healthCheck();
  assert.equal(health.status, "unhealthy");
  if (health.status === "unhealthy") {
    assert.equal(health.errorCode, "AUTH_FAILED");
    assert.equal(JSON.stringify(health).includes("secret"), false);
  }
});
