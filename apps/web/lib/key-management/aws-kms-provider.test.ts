import assert from "node:assert/strict";
import test from "node:test";
import {
  DecryptCommand,
  EncryptCommand,
  type DecryptCommandOutput,
  type EncryptCommandOutput,
} from "@aws-sdk/client-kms";
import {
  AwsKmsProvider,
  keyContextMap,
  type AwsKmsClient,
} from "./aws-kms-provider";
import { encodeUserKeyPayload } from "./context";
import { runProviderCanary } from "./provider-health-cache";
import type { KeyContext } from "./types";

const KEY_ARN =
  "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012";
const CONTEXT: KeyContext = {
  installationId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
  userId: "01900000-0000-7000-8000-000000000001",
  keyVersion: 1,
  purpose: "prompt-history",
};
const UCK = Buffer.alloc(32, 0x5a);

class RecordingAwsClient implements AwsKmsClient {
  readonly commands: Array<EncryptCommand | DecryptCommand> = [];
  readonly inputs: Array<Record<string, unknown>> = [];
  private encryptedPayload: Buffer | null = null;

  async send(command: EncryptCommand): Promise<EncryptCommandOutput>;
  async send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  async send(
    command: EncryptCommand | DecryptCommand,
  ): Promise<EncryptCommandOutput | DecryptCommandOutput> {
    this.commands.push(command);
    this.inputs.push(snapshotInput(command.input));
    if (command instanceof EncryptCommand) {
      this.encryptedPayload = Buffer.from(command.input.Plaintext ?? []);
      return {
        CiphertextBlob: Buffer.from("kms-ciphertext"),
        $metadata: {},
      };
    }
    return {
      Plaintext: Buffer.from(this.encryptedPayload ?? []),
      $metadata: {},
    };
  }
}

class StubAwsClient implements AwsKmsClient {
  constructor(
    private readonly handler: (
      command: EncryptCommand | DecryptCommand,
    ) => Promise<EncryptCommandOutput | DecryptCommandOutput>,
  ) {}

  async send(command: EncryptCommand): Promise<EncryptCommandOutput>;
  async send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  async send(
    command: EncryptCommand | DecryptCommand,
  ): Promise<EncryptCommandOutput | DecryptCommandOutput> {
    return this.handler(command);
  }
}

function snapshotInput(input: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? Buffer.from(value)
        : value && typeof value === "object"
          ? structuredClone(value)
          : value,
    ]),
  );
}

function provider(client: AwsKmsClient): AwsKmsProvider {
  return new AwsKmsProvider({
    keyArn: KEY_ARN,
    region: "ap-northeast-2",
    client,
  });
}

test("AWS adapter는 symmetric key와 동일 canonical EncryptionContext를 사용한다", async () => {
  const client = new RecordingAwsClient();
  const kms = provider(client);

  const wrapped = await kms.wrapKey(UCK, CONTEXT);
  const encrypt = client.inputs[0]!;
  assert.ok(client.commands[0] instanceof EncryptCommand);
  assert.equal(encrypt.KeyId, KEY_ARN);
  assert.equal(encrypt.EncryptionAlgorithm, "SYMMETRIC_DEFAULT");
  assert.deepEqual(encrypt.EncryptionContext, keyContextMap(CONTEXT));
  assert.equal((encrypt.Plaintext as Buffer).length, 68);
  assert.deepEqual(encrypt.Plaintext, encodeUserKeyPayload(UCK, CONTEXT));
  assert.notDeepEqual(encrypt.Plaintext, UCK);

  assert.equal(kms.name, "aws-kms");
  assert.equal(kms.keyRef, KEY_ARN);
  assert.match(kms.fingerprint, /^aws-kms:[0-9a-f]{24}$/);
  assert.deepEqual(wrapped, {
    provider: "aws-kms",
    keyRef: KEY_ARN,
    fingerprint: kms.fingerprint,
    ciphertext: Buffer.from("kms-ciphertext"),
    metadata: { algorithm: "SYMMETRIC_DEFAULT", format: "aws-kms-v1" },
  });

  assert.deepEqual(await kms.unwrapKey(wrapped, CONTEXT), UCK);
  const decrypt = client.inputs[1]!;
  assert.ok(client.commands[1] instanceof DecryptCommand);
  assert.equal(decrypt.KeyId, KEY_ARN);
  assert.equal(decrypt.EncryptionAlgorithm, "SYMMETRIC_DEFAULT");
  assert.deepEqual(decrypt.EncryptionContext, encrypt.EncryptionContext);
  assert.deepEqual(decrypt.CiphertextBlob, wrapped.ciphertext);
  assert.deepEqual(await kms.describeCredentialSource(), {
    kind: "aws-sdk-default-chain",
    staticCredential: false,
  });
});

test("AWS adapter는 wrapper provider, key ARN, fingerprint 불일치를 호출 전에 거부한다", async () => {
  const client = new RecordingAwsClient();
  const kms = provider(client);
  const wrapped = await kms.wrapKey(UCK, CONTEXT);

  for (const mismatch of [
    { ...wrapped, provider: "gcp-kms" as const },
    { ...wrapped, keyRef: `${KEY_ARN}-other` },
    { ...wrapped, fingerprint: "aws-kms:000000000000000000000000" },
  ]) {
    await assert.rejects(
      kms.unwrapKey(mismatch, CONTEXT),
      (error: Error) => error.message === "aws-kms:WRAPPER_MISMATCH",
    );
  }
  assert.equal(client.commands.length, 1);
});

test("AWS adapter는 비어 있거나 malformed인 SDK output을 비민감 오류로 변환한다", async () => {
  const noCiphertext = provider(new StubAwsClient(async () => ({ $metadata: {} })));
  await assert.rejects(
    noCiphertext.wrapKey(UCK, CONTEXT),
    (error: Error) => error.message === "aws-kms:EMPTY_CIPHERTEXT",
  );

  const emptyCiphertext = provider(new StubAwsClient(async () => ({
    CiphertextBlob: Buffer.alloc(0),
    $metadata: {},
  })));
  await assert.rejects(
    emptyCiphertext.wrapKey(UCK, CONTEXT),
    (error: Error) => error.message === "aws-kms:EMPTY_CIPHERTEXT",
  );

  const validWrapped = {
    provider: "aws-kms" as const,
    keyRef: KEY_ARN,
    fingerprint: provider(new RecordingAwsClient()).fingerprint,
    ciphertext: Buffer.from("ciphertext"),
    metadata: { algorithm: "SYMMETRIC_DEFAULT" },
  };
  const malformedPlaintexts = [
    undefined,
    Buffer.alloc(0),
    Buffer.alloc(67),
    encodeUserKeyPayload(UCK, { ...CONTEXT, userId: "another-user" }),
  ];
  for (const plaintext of malformedPlaintexts) {
    const kms = provider(new StubAwsClient(async (command) => (
      command instanceof DecryptCommand
        ? { Plaintext: plaintext, $metadata: {} }
        : { CiphertextBlob: Buffer.from("ciphertext"), $metadata: {} }
    )));
    await assert.rejects(
      kms.unwrapKey({ ...validWrapped, fingerprint: kms.fingerprint }, CONTEXT),
      (error: Error) => (
        error.message === (
          plaintext === undefined || plaintext.length === 0
            ? "aws-kms:EMPTY_PLAINTEXT"
            : "aws-kms:INVALID_PLAINTEXT"
        )
        && !error.message.includes(UCK.toString("base64"))
      ),
    );
  }
});

test("AWS decrypt는 SDK Plaintext 원본을 성공, copy/decode 실패, alias에서 모두 zeroize한다", async () => {
  const success = encodeUserKeyPayload(UCK, CONTEXT);
  const successProvider = provider(new StubAwsClient(async (command) => (
    command instanceof DecryptCommand
      ? { Plaintext: success, $metadata: {} }
      : { CiphertextBlob: Buffer.from("ciphertext"), $metadata: {} }
  )));
  const wrapped = {
    provider: "aws-kms" as const,
    keyRef: KEY_ARN,
    fingerprint: successProvider.fingerprint,
    ciphertext: Buffer.from("ciphertext"),
    metadata: { algorithm: "SYMMETRIC_DEFAULT" },
  };
  assert.deepEqual(await successProvider.unwrapKey(wrapped, CONTEXT), UCK);
  assert.equal(success.every((byte) => byte === 0), true);

  const malformed = Buffer.alloc(67, 9);
  const malformedProvider = provider(new StubAwsClient(async (command) => (
    command instanceof DecryptCommand
      ? { Plaintext: malformed, $metadata: {} }
      : { CiphertextBlob: Buffer.from("ciphertext"), $metadata: {} }
  )));
  await assert.rejects(
    malformedProvider.unwrapKey({ ...wrapped, fingerprint: malformedProvider.fingerprint }, CONTEXT),
    /aws-kms:INVALID_PLAINTEXT/,
  );
  assert.equal(malformed.every((byte) => byte === 0), true);

  const copyFailure = encodeUserKeyPayload(UCK, CONTEXT);
  const copyFailureProvider = provider(new StubAwsClient(async (command) => (
    command instanceof DecryptCommand
      ? { Plaintext: copyFailure, $metadata: {} }
      : { CiphertextBlob: Buffer.from("ciphertext"), $metadata: {} }
  )));
  const fromDescriptor = Object.getOwnPropertyDescriptor(Buffer, "from");
  assert.ok(fromDescriptor);
  Object.defineProperty(Buffer, "from", {
    configurable: true,
    value: () => { throw new Error("COPY_FAILED"); },
  });
  try {
    await assert.rejects(
      copyFailureProvider.unwrapKey({ ...wrapped, fingerprint: copyFailureProvider.fingerprint }, CONTEXT),
      /aws-kms:INVALID_PLAINTEXT/,
    );
  } finally {
    Object.defineProperty(Buffer, "from", fromDescriptor);
  }
  assert.equal(copyFailure.every((byte) => byte === 0), true);

  const alias = encodeUserKeyPayload(UCK, CONTEXT);
  const aliasProvider = provider(new StubAwsClient(async (command) => (
    command instanceof DecryptCommand
      ? { Plaintext: alias.subarray(0), $metadata: {} }
      : { CiphertextBlob: Buffer.from("ciphertext"), $metadata: {} }
  )));
  await aliasProvider.unwrapKey({ ...wrapped, fingerprint: aliasProvider.fingerprint }, CONTEXT);
  assert.equal(alias.every((byte) => byte === 0), true);
});

test("AWS adapter는 AWS exception의 secret, metadata, request id를 버린다", async () => {
  const secretAccessKey = "AKIAIOSFODNN7EXAMPLE";
  const payload = UCK.toString("base64");
  const throttled = Object.assign(
    new Error(`credential=${secretAccessKey} payload=${payload}`),
    {
      name: "ThrottlingException",
      $metadata: {
        httpStatusCode: 429,
        requestId: "sensitive-request-id",
      },
      $retryable: { throttling: true },
      response: { body: `token=${secretAccessKey}` },
    },
  );
  const kms = provider(new StubAwsClient(async () => {
    throw throttled;
  }));

  await assert.rejects(
    kms.wrapKey(UCK, CONTEXT),
    (error: Error) => (
      error.message === "aws-kms:THROTTLED"
      && !error.message.includes(secretAccessKey)
      && !error.message.includes(payload)
      && !error.message.includes("sensitive-request-id")
    ),
  );
});

test("AWS adapter의 transient brand는 공통 canary까지 안전한 code로 보존된다", async () => {
  for (const [awsError, errorCode] of [
    [
      { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } },
      "THROTTLED",
    ],
    [
      { name: "ServiceUnavailableException", $metadata: { httpStatusCode: 503 } },
      "TEMPORARY",
    ],
  ] as const) {
    const kms = provider(new StubAwsClient(async () => {
      throw Object.assign(new Error("credential=secret requestId=secret"), awsError);
    }));
    const health = await runProviderCanary(kms);
    assert.equal(health.status, "unhealthy");
    if (health.status === "unhealthy") {
      assert.equal(health.errorCode, errorCode);
      assert.equal(JSON.stringify(health).includes("secret"), false);
    }
  }
});

test("AWS adapter는 허용된 AWS 오류 신호만 안전한 code로 분류한다", async () => {
  const cases = [
    [{ name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } }, "AUTH_FAILED"],
    [{ name: "NotFoundException", $metadata: { httpStatusCode: 400 } }, "KEY_NOT_FOUND"],
    [{ name: "DisabledException", $metadata: { httpStatusCode: 400 } }, "KEY_DISABLED"],
    [{ name: "ServiceUnavailableException", $metadata: { httpStatusCode: 503 } }, "TEMPORARY"],
    [{ name: "UnknownException", $metadata: { httpStatusCode: 400 } }, "FAILED"],
  ] as const;

  for (const [awsError, code] of cases) {
    const kms = provider(new StubAwsClient(async () => {
      throw Object.assign(new Error("must-not-leak"), awsError);
    }));
    await assert.rejects(
      kms.wrapKey(UCK, CONTEXT),
      (error: Error) => error.message === `aws-kms:${code}`,
    );
  }
});

test("AWS fingerprint는 비민감 설정에만 결정적으로 묶인다", () => {
  const client = new RecordingAwsClient();
  const base = provider(client);
  const same = provider(client);
  const endpoint = new AwsKmsProvider({
    keyArn: KEY_ARN,
    region: "ap-northeast-2",
    endpoint: "http://localhost:4566/",
    client,
  });

  assert.equal(base.fingerprint, same.fingerprint);
  assert.notEqual(base.fingerprint, endpoint.fingerprint);
  assert.equal(base.fingerprint.includes(KEY_ARN), false);
});
