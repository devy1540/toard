import assert from "node:assert/strict";
import test from "node:test";
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
} from "@azure/identity";
import {
  AzureKeyVaultProvider,
  createAzureCredential,
  type AzureCryptographyClient,
} from "./azure-key-vault-provider";
import { encodeUserKeyPayload } from "./context";
import type { KeyContext } from "./types";

const AZURE_KEY_ID =
  "https://toard-prod.vault.azure.net/keys/user-keys/0123456789abcdef";
const CONTEXT: KeyContext = {
  installationId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
  userId: "01900000-0000-7000-8000-000000000001",
  keyVersion: 1,
  purpose: "prompt-history",
};
const UCK = Buffer.alloc(32, 0x5a);

function environment(
  values: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ...values,
  };
}

type WrapCall = {
  algorithm: string;
  key: Buffer;
};

class RecordingAzureClient implements AzureCryptographyClient {
  readonly wrapCalls: WrapCall[] = [];
  readonly unwrapCalls: WrapCall[] = [];
  private payload: Buffer | null = null;

  async wrapKey(algorithm: "RSA-OAEP-256", key: Uint8Array) {
    const snapshot = Buffer.from(key);
    this.wrapCalls.push({ algorithm, key: snapshot });
    this.payload = snapshot;
    return { result: Buffer.from("azure-ciphertext") };
  }

  async unwrapKey(algorithm: "RSA-OAEP-256", key: Uint8Array) {
    this.unwrapCalls.push({ algorithm, key: Buffer.from(key) });
    return { result: Buffer.from(this.payload ?? []) };
  }
}

class StubAzureClient implements AzureCryptographyClient {
  constructor(
    private readonly wrapHandler: AzureCryptographyClient["wrapKey"],
    private readonly unwrapHandler: AzureCryptographyClient["unwrapKey"],
  ) {}

  wrapKey(algorithm: "RSA-OAEP-256", key: Uint8Array) {
    return this.wrapHandler(algorithm, key);
  }

  unwrapKey(algorithm: "RSA-OAEP-256", key: Uint8Array) {
    return this.unwrapHandler(algorithm, key);
  }
}

function provider(cryptoClient: AzureCryptographyClient): AzureKeyVaultProvider {
  return new AzureKeyVaultProvider({
    keyId: AZURE_KEY_ID,
    credentialMode: "managed-identity",
    cryptoClient,
  });
}

test("Azure adapter는 68-byte payload에 RSA-OAEP-256만 사용한다", async () => {
  const cryptoClient = new RecordingAzureClient();
  const kms = provider(cryptoClient);

  const wrapped = await kms.wrapKey(UCK, CONTEXT);
  assert.deepEqual(cryptoClient.wrapCalls[0], {
    algorithm: "RSA-OAEP-256",
    key: encodeUserKeyPayload(UCK, CONTEXT),
  });
  assert.equal(cryptoClient.wrapCalls[0]!.key.length, 68);
  assert.notDeepEqual(cryptoClient.wrapCalls[0]!.key, UCK);
  assert.deepEqual(wrapped, {
    provider: "azure-key-vault",
    keyRef: AZURE_KEY_ID,
    fingerprint: kms.fingerprint,
    ciphertext: Buffer.from("azure-ciphertext"),
    metadata: {
      algorithm: "RSA-OAEP-256",
      format: "azure-key-vault-v1",
    },
  });

  assert.deepEqual(await kms.unwrapKey(wrapped, CONTEXT), UCK);
  assert.deepEqual(cryptoClient.unwrapCalls[0], {
    algorithm: "RSA-OAEP-256",
    key: wrapped.ciphertext,
  });
  assert.deepEqual(await kms.describeCredentialSource(), {
    kind: "azure-managed-identity",
    staticCredential: false,
  });
});

test("Azure production credential은 deterministic identity만 허용한다", () => {
  const workloadEnv = {
    AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000002",
    AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/azure/tokens/azure-identity-token",
  };

  assert.ok(
    createAzureCredential(
      "managed-identity",
      environment({ AZURE_CLIENT_ID: workloadEnv.AZURE_CLIENT_ID }),
      "production",
    ) instanceof ManagedIdentityCredential,
  );
  assert.ok(
    createAzureCredential(
      "workload-identity",
      environment(workloadEnv),
      "production",
    ) instanceof WorkloadIdentityCredential,
  );
  assert.throws(
    () => createAzureCredential("default", environment(), "production"),
    /AZURE_DEFAULT_CREDENTIAL_FORBIDDEN/,
  );
  assert.ok(
    createAzureCredential("default", environment(), "development")
      instanceof DefaultAzureCredential,
  );
});

test("Azure provider는 전달된 env의 production에서도 default credential을 거부한다", () => {
  assert.throws(
    () => new AzureKeyVaultProvider({
      keyId: AZURE_KEY_ID,
      credentialMode: "default",
      env: environment({ NODE_ENV: "production" }),
    }),
    /AZURE_DEFAULT_CREDENTIAL_FORBIDDEN/,
  );
});

test("Azure workload identity는 전달된 env의 필수 identity만 결정적으로 사용한다", () => {
  for (const env of [
    {
      AZURE_TENANT_ID: "tenant",
      AZURE_FEDERATED_TOKEN_FILE: "/token",
    },
    {
      AZURE_CLIENT_ID: "client",
      AZURE_FEDERATED_TOKEN_FILE: "/token",
    },
    {
      AZURE_TENANT_ID: "tenant",
      AZURE_CLIENT_ID: "client",
    },
  ]) {
    assert.throws(
      () => createAzureCredential(
        "workload-identity",
        environment(env),
        "production",
      ),
      /AZURE_WORKLOAD_IDENTITY_INCOMPLETE/,
    );
  }
});

test("Azure adapter는 wrapper identity 불일치를 원격 호출 전에 거부한다", async () => {
  const cryptoClient = new RecordingAzureClient();
  const kms = provider(cryptoClient);
  const wrapped = await kms.wrapKey(UCK, CONTEXT);

  for (const mismatch of [
    { ...wrapped, provider: "gcp-kms" as const },
    { ...wrapped, keyRef: `${AZURE_KEY_ID}-other` },
    { ...wrapped, fingerprint: "azure-key-vault:000000000000000000000000" },
  ]) {
    await assert.rejects(
      kms.unwrapKey(mismatch, CONTEXT),
      (error: Error) => error.message === "azure-key-vault:WRAPPER_MISMATCH",
    );
  }
  assert.equal(cryptoClient.unwrapCalls.length, 0);
});

test("Azure adapter는 empty/malformed 결과와 context 불일치를 비민감 오류로 바꾼다", async () => {
  const missingResponse = provider(new StubAzureClient(
    async () => undefined as never,
    async () => undefined as never,
  ));
  await assert.rejects(
    missingResponse.wrapKey(UCK, CONTEXT),
    (error: Error) => error.message === "azure-key-vault:EMPTY_CIPHERTEXT",
  );

  for (const result of [undefined, Buffer.alloc(0), "not-bytes"]) {
    const kms = provider(new StubAzureClient(
      async () => ({ result }),
      async () => ({ result: encodeUserKeyPayload(UCK, CONTEXT) }),
    ));
    await assert.rejects(
      kms.wrapKey(UCK, CONTEXT),
      (error: Error) => error.message === "azure-key-vault:EMPTY_CIPHERTEXT",
    );
  }

  const malformedPlaintexts = [
    undefined,
    Buffer.alloc(0),
    "not-bytes",
    Buffer.alloc(67),
    encodeUserKeyPayload(UCK, { ...CONTEXT, userId: "another-user" }),
  ];
  for (const result of malformedPlaintexts) {
    const kms = provider(new StubAzureClient(
      async () => ({ result: Buffer.from("ciphertext") }),
      async () => ({ result }),
    ));
    const wrapped = await kms.wrapKey(UCK, CONTEXT);
    await assert.rejects(
      kms.unwrapKey(wrapped, CONTEXT),
      (error: Error) => (
        error.message === (
          result === undefined
          || (result instanceof Uint8Array && result.length === 0)
            ? "azure-key-vault:EMPTY_PLAINTEXT"
            : "azure-key-vault:INVALID_PLAINTEXT"
        )
        && !error.message.includes(UCK.toString("base64"))
      ),
    );
  }
});

test("Azure adapter는 SDK message, request id, credential, payload를 노출하지 않는다", async () => {
  const secret = "azure-secret-value";
  const payload = UCK.toString("base64");
  const remoteError = Object.assign(
    new Error(`credential=${secret} plaintext=${payload}`),
    {
      name: "RestError",
      statusCode: 429,
      request: { requestId: "sensitive-request-id" },
      response: { bodyAsText: secret },
    },
  );
  const kms = provider(new StubAzureClient(
    async () => {
      throw remoteError;
    },
    async () => ({ result: Buffer.alloc(0) }),
  ));

  await assert.rejects(
    kms.wrapKey(UCK, CONTEXT),
    (error: Error) => (
      error.message === "azure-key-vault:THROTTLED"
      && !error.message.includes(secret)
      && !error.message.includes(payload)
      && !error.message.includes("sensitive-request-id")
    ),
  );
});

test("Azure adapter는 unwrap response의 임시 key payload를 zeroize한다", async () => {
  const plaintext = encodeUserKeyPayload(UCK, CONTEXT);
  const kms = provider(new StubAzureClient(
    async () => ({ result: Buffer.from("ciphertext") }),
    async () => ({ result: plaintext }),
  ));

  const wrapped = await kms.wrapKey(UCK, CONTEXT);
  assert.deepEqual(await kms.unwrapKey(wrapped, CONTEXT), UCK);
  assert.deepEqual(plaintext, Buffer.alloc(plaintext.length));
});

test("Azure fingerprint는 credential과 무관한 config identity와 일치한다", async () => {
  const client = new RecordingAzureClient();
  const managed = new AzureKeyVaultProvider({
    keyId: AZURE_KEY_ID,
    credentialMode: "managed-identity",
    cryptoClient: client,
  });
  const workload = new AzureKeyVaultProvider({
    keyId: AZURE_KEY_ID,
    credentialMode: "workload-identity",
    cryptoClient: client,
  });

  assert.equal(managed.fingerprint, workload.fingerprint);
  assert.match(
    managed.fingerprint,
    /^azure-key-vault:[0-9a-f]{24}$/,
  );
  assert.equal(managed.fingerprint.includes(AZURE_KEY_ID), false);
  assert.deepEqual(await workload.describeCredentialSource(), {
    kind: "azure-workload-identity",
    staticCredential: false,
  });
});
