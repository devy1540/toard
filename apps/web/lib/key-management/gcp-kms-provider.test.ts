import assert from "node:assert/strict";
import test from "node:test";
import {
  GcpKmsProvider,
  type GcpKmsClient,
} from "./gcp-kms-provider";
import {
  canonicalKeyContext,
  encodeUserKeyPayload,
} from "./context";
import type { KeyContext } from "./types";

const GCP_KEY_NAME =
  "projects/toard-prod/locations/asia-northeast3/keyRings/content/cryptoKeys/user-keys";
const CONTEXT: KeyContext = {
  installationId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
  userId: "01900000-0000-7000-8000-000000000001",
  keyVersion: 1,
  purpose: "prompt-history",
};
const UCK = Buffer.alloc(32, 0x5a);

type GcpRequest = {
  name?: string | null;
  plaintext?: Uint8Array | string | null;
  ciphertext?: Uint8Array | string | null;
  additionalAuthenticatedData?: Uint8Array | string | null;
};

function snapshotRequest(request: GcpRequest): GcpRequest {
  return Object.fromEntries(
    Object.entries(request).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? Buffer.from(value) : value,
    ]),
  );
}

class RecordingGcpClient implements GcpKmsClient {
  readonly encryptInputs: GcpRequest[] = [];
  readonly decryptInputs: GcpRequest[] = [];
  private encryptedPayload: Buffer | null = null;

  async encrypt(request: GcpRequest) {
    this.encryptInputs.push(snapshotRequest(request));
    this.encryptedPayload = Buffer.from(request.plaintext as Uint8Array);
    return [{ ciphertext: Buffer.from("gcp-ciphertext") }] as const;
  }

  async decrypt(request: GcpRequest) {
    this.decryptInputs.push(snapshotRequest(request));
    return [{ plaintext: Buffer.from(this.encryptedPayload ?? []) }] as const;
  }
}

class StubGcpClient implements GcpKmsClient {
  constructor(
    private readonly encryptHandler: GcpKmsClient["encrypt"],
    private readonly decryptHandler: GcpKmsClient["decrypt"],
  ) {}

  encrypt(request: GcpRequest) {
    return this.encryptHandler(request);
  }

  decrypt(request: GcpRequest) {
    return this.decryptHandler(request);
  }
}

function provider(client: GcpKmsClient): GcpKmsProvider {
  return new GcpKmsProvider({
    keyName: GCP_KEY_NAME,
    client,
  });
}

test("GCP adapter는 full key name과 동일 canonical AAD를 사용한다", async () => {
  const client = new RecordingGcpClient();
  const kms = provider(client);

  const wrapped = await kms.wrapKey(UCK, CONTEXT);
  assert.deepEqual(client.encryptInputs[0], {
    name: GCP_KEY_NAME,
    plaintext: encodeUserKeyPayload(UCK, CONTEXT),
    additionalAuthenticatedData: canonicalKeyContext(CONTEXT),
  });
  assert.equal(
    (client.encryptInputs[0]!.plaintext as Buffer).length,
    68,
  );
  assert.notDeepEqual(client.encryptInputs[0]!.plaintext, UCK);
  assert.deepEqual(wrapped, {
    provider: "gcp-kms",
    keyRef: GCP_KEY_NAME,
    fingerprint: kms.fingerprint,
    ciphertext: Buffer.from("gcp-ciphertext"),
    metadata: {
      algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION",
      format: "gcp-kms-v1",
    },
  });

  assert.deepEqual(await kms.unwrapKey(wrapped, CONTEXT), UCK);
  assert.deepEqual(client.decryptInputs[0], {
    name: GCP_KEY_NAME,
    ciphertext: wrapped.ciphertext,
    additionalAuthenticatedData: canonicalKeyContext(CONTEXT),
  });
  assert.deepEqual(await kms.describeCredentialSource(), {
    kind: "gcp-application-default-credentials",
    staticCredential: false,
  });
});

test("GCP adapter는 wrapper identity 불일치를 원격 호출 전에 거부한다", async () => {
  const client = new RecordingGcpClient();
  const kms = provider(client);
  const wrapped = await kms.wrapKey(UCK, CONTEXT);

  for (const mismatch of [
    { ...wrapped, provider: "aws-kms" as const },
    { ...wrapped, keyRef: `${GCP_KEY_NAME}-other` },
    { ...wrapped, fingerprint: "gcp-kms:000000000000000000000000" },
  ]) {
    await assert.rejects(
      kms.unwrapKey(mismatch, CONTEXT),
      (error: Error) => error.message === "gcp-kms:WRAPPER_MISMATCH",
    );
  }
  assert.equal(client.decryptInputs.length, 0);
});

test("GCP adapter는 empty/malformed 결과와 context 불일치를 비민감 오류로 바꾼다", async () => {
  const missingResponse = provider(new StubGcpClient(
    async () => [] as never,
    async () => [] as never,
  ));
  await assert.rejects(
    missingResponse.wrapKey(UCK, CONTEXT),
    (error: Error) => error.message === "gcp-kms:EMPTY_CIPHERTEXT",
  );

  for (const ciphertext of [undefined, Buffer.alloc(0), "not-bytes"]) {
    const kms = provider(new StubGcpClient(
      async () => [{ ciphertext }],
      async () => [{ plaintext: encodeUserKeyPayload(UCK, CONTEXT) }],
    ));
    await assert.rejects(
      kms.wrapKey(UCK, CONTEXT),
      (error: Error) => error.message === "gcp-kms:EMPTY_CIPHERTEXT",
    );
  }

  const malformedPlaintexts = [
    undefined,
    Buffer.alloc(0),
    "not-bytes",
    Buffer.alloc(67),
    encodeUserKeyPayload(UCK, { ...CONTEXT, userId: "another-user" }),
  ];
  for (const plaintext of malformedPlaintexts) {
    const kms = provider(new StubGcpClient(
      async () => [{ ciphertext: Buffer.from("ciphertext") }],
      async () => [{ plaintext }],
    ));
    const wrapped = await kms.wrapKey(UCK, CONTEXT);
    await assert.rejects(
      kms.unwrapKey(wrapped, CONTEXT),
      (error: Error) => (
        error.message === (
          plaintext === undefined
          || (plaintext instanceof Uint8Array && plaintext.length === 0)
            ? "gcp-kms:EMPTY_PLAINTEXT"
            : "gcp-kms:INVALID_PLAINTEXT"
        )
        && !error.message.includes(UCK.toString("base64"))
      ),
    );
  }
});

test("GCP adapter는 SDK message, request id, credential, payload를 노출하지 않는다", async () => {
  const secret = "gcp-secret-value";
  const payload = UCK.toString("base64");
  const remoteError = Object.assign(
    new Error(`credential=${secret} plaintext=${payload}`),
    {
      code: 8,
      name: "ResourceExhaustedError",
      requestId: "sensitive-request-id",
      response: { data: secret },
    },
  );
  const kms = provider(new StubGcpClient(
    async () => {
      throw remoteError;
    },
    async () => [{ plaintext: Buffer.alloc(0) }],
  ));

  await assert.rejects(
    kms.wrapKey(UCK, CONTEXT),
    (error: Error) => (
      error.message === "gcp-kms:THROTTLED"
      && !error.message.includes(secret)
      && !error.message.includes(payload)
      && !error.message.includes("sensitive-request-id")
    ),
  );
});

test("GCP adapter는 decrypt response의 임시 key payload를 zeroize한다", async () => {
  const plaintext = encodeUserKeyPayload(UCK, CONTEXT);
  const kms = provider(new StubGcpClient(
    async () => [{ ciphertext: Buffer.from("ciphertext") }],
    async () => [{ plaintext }],
  ));

  const wrapped = await kms.wrapKey(UCK, CONTEXT);
  assert.deepEqual(await kms.unwrapKey(wrapped, CONTEXT), UCK);
  assert.deepEqual(plaintext, Buffer.alloc(plaintext.length));
});

test("GCP fingerprint는 config의 비민감 canonical identity와 일치한다", () => {
  const client = new RecordingGcpClient();
  const base = provider(client);
  const same = provider(client);
  const endpoint = new GcpKmsProvider({
    keyName: GCP_KEY_NAME,
    apiEndpoint: "private-kms.googleapis.com",
    client,
  });

  assert.equal(base.fingerprint, same.fingerprint);
  assert.notEqual(base.fingerprint, endpoint.fingerprint);
  assert.match(base.fingerprint, /^gcp-kms:[0-9a-f]{24}$/);
  assert.equal(base.fingerprint.includes(GCP_KEY_NAME), false);
});
