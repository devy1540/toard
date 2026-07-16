# Managed KMS Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** foundation의 `KeyManagementProvider` 계약에 AWS KMS, GCP Cloud KMS, Azure Key Vault, HashiCorp Vault Transit, OpenBao Transit adapter를 추가한다.

**Architecture:** 클라우드 SDK adapter는 각 공급자의 공식 기본 인증 흐름을 사용하고 68바이트 UCK payload만 원격 암호화한다. Vault/OpenBao는 공통 Transit HTTP core와 교체 가능한 token source를 공유하되 provider 이름과 호환성 테스트를 분리한다. registry는 active/migration 두 fingerprint만 허용하며 health canary를 60초 cache한다.

**Tech Stack:** `@aws-sdk/client-kms`, `@google-cloud/kms`, `@azure/identity`, `@azure/keyvault-keys`, Node `fetch`, TypeScript 5.7, Node test runner.

## Global Constraints

- 이 계획은 `2026-07-17-managed-encryption-foundation.md` 완료 후 실행한다.
- SDK client 생성 시 static credential 객체를 코드로 전달하지 않는다.
- AWS는 Node.js SDK v3 default credential provider chain을 사용한다.
- GCP는 Application Default Credentials를 사용한다.
- Azure production은 `managed-identity` 또는 `workload-identity`만 허용하고 `default`는 개발 환경에서만 허용한다.
- Vault/OpenBao auth 우선순위는 명시 설정값 하나로 고정하며 여러 auth source를 자동 순회하지 않는다.
- Vault/OpenBao TLS 검증을 끄는 설정은 구현하지 않는다.
- provider 오류에 credential, token, plaintext payload, 전체 원격 응답 body를 포함하지 않는다.
- provider별 retry는 공식 SDK retry 또는 HTTP 429/5xx 최대 3회만 사용한다.
- health canary는 60초에 한 번 이하로 wrap+unwrap하며 사용자 데이터나 사용자 ID를 사용하지 않는다.
- 실제 클라우드 canary는 opt-in test로 분리하고 기본 CI는 injected fake client를 사용한다.

## Official API References

- AWS SDK v3 credentials: <https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html>
- GCP KMS Node client: <https://docs.cloud.google.com/nodejs/docs/reference/kms/latest/kms/v1.keymanagementserviceclient>
- GCP ADC: <https://docs.cloud.google.com/docs/authentication/application-default-credentials>
- Azure Key Vault JS client: <https://learn.microsoft.com/en-us/javascript/api/overview/azure/keyvault-keys-readme>
- Azure Identity production guidance: <https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/best-practices>
- Vault Transit API: <https://developer.hashicorp.com/vault/api-docs/secret/transit>
- OpenBao Transit API: <https://openbao.org/api-docs/secret/transit/>

---

## File Structure

- `apps/web/lib/key-management/aws-kms-provider.ts`: AWS Encrypt/Decrypt adapter.
- `apps/web/lib/key-management/gcp-kms-provider.ts`: GCP encrypt/decrypt+AAD adapter.
- `apps/web/lib/key-management/azure-key-vault-provider.ts`: Azure RSA-OAEP-256 wrap/unwrap adapter.
- `apps/web/lib/key-management/transit-token-source.ts`: token file, Kubernetes, AppRole, static token auth.
- `apps/web/lib/key-management/transit-client.ts`: TLS Transit encrypt/decrypt HTTP client.
- `apps/web/lib/key-management/vault-transit-provider.ts`: Vault provider wrapper.
- `apps/web/lib/key-management/openbao-transit-provider.ts`: OpenBao provider wrapper.
- `apps/web/lib/key-management/provider-factory.ts`: config profile → provider instance.
- `apps/web/lib/key-management/provider-health-cache.ts`: 60초 health canary cache.

---

### Task 1: SDK 의존성과 전체 provider config 계약

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/lib/key-management/config.ts`
- Modify: `apps/web/lib/key-management/config.test.ts`

**Interfaces:**
- Extends `ProviderProfile.settings` with exact provider settings.
- Produces no credential values in parsed config summaries.

- [ ] **Step 1: provider별 필수 설정 실패 테스트를 추가한다**

```ts
test("provider별 key ref와 auth mode를 엄격히 검증한다", () => {
  assert.throws(
    () => config("aws-kms", {}),
    /TOARD_KEY_ACTIVE_AWS_KEY_ARN/,
  );
  assert.throws(
    () => config("gcp-kms", { TOARD_KEY_ACTIVE_GCP_KEY_NAME: "short-name" }),
    /projects\\/.*\\/cryptoKeys/,
  );
  assert.throws(
    () => config("azure-key-vault", {
      TOARD_KEY_ACTIVE_AZURE_KEY_ID: "https://vault.vault.azure.net/keys/key/version",
      TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE: "default",
      NODE_ENV: "production",
    }),
    /production.*default/,
  );
  assert.throws(
    () => config("vault-transit", {
      TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "http://vault:8200",
    }),
    /https/,
  );
});
```

- [ ] **Step 2: 설정 테스트가 새 provider 필드 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/config.test.ts`

Expected: provider별 required setting assertion에서 FAIL.

- [ ] **Step 3: 공식 SDK를 설치한다**

Run:

```bash
pnpm --filter @toard/web add @aws-sdk/client-kms @google-cloud/kms @azure/identity @azure/keyvault-keys
```

Expected: `apps/web/package.json` dependencies와 `pnpm-lock.yaml`이 갱신되고 install exit code 0.

- [ ] **Step 4: config parser에 exact env 계약을 추가한다**

| Provider | Required profile variables | Optional profile variables |
|---|---|---|
| `aws-kms` | `${P}_AWS_KEY_ARN`, `${P}_AWS_REGION` | `${P}_AWS_ENDPOINT` |
| `gcp-kms` | `${P}_GCP_KEY_NAME` | `${P}_GCP_API_ENDPOINT` |
| `azure-key-vault` | `${P}_AZURE_KEY_ID`, `${P}_AZURE_CREDENTIAL_MODE` | `${P}_AZURE_MANAGED_IDENTITY_CLIENT_ID` |
| `vault-transit` | `${P}_TRANSIT_ADDRESS`, `${P}_TRANSIT_MOUNT`, `${P}_TRANSIT_KEY_NAME`, `${P}_TRANSIT_AUTH_METHOD` | `${P}_TRANSIT_NAMESPACE`와 auth별 file path |
| `openbao-transit` | Vault와 동일 | Vault와 동일 |

`P`는 `TOARD_KEY_ACTIVE` 또는 `TOARD_KEY_MIGRATION`이다. Transit auth별 필수값은 다음과 같다.

Azure key ID는 자동으로 latest version을 추종하는 `/keys/{name}`이 아니라
`/keys/{name}/{version}` 형태의 versioned full HTTPS URL만 허용한다. Azure key
rotation은 active/migration profile을 명시적으로 바꾸고 UCK를 rewrap하는 절차로
수행한다.

```ts
const TRANSIT_AUTH_REQUIRED = {
  "token-file": ["TRANSIT_TOKEN_FILE"],
  "kubernetes": ["TRANSIT_KUBERNETES_ROLE", "TRANSIT_KUBERNETES_JWT_FILE"],
  "approle": ["TRANSIT_APPROLE_ROLE_ID_FILE", "TRANSIT_APPROLE_SECRET_ID_FILE"],
  "static-token": ["TRANSIT_TOKEN_FILE"],
} as const;
```

`static-token`도 환경변수 raw token을 받지 않고 secret file만 읽는다. `address`는 `https:`만 허용한다. 개발용 로컬 Transit 테스트는 test fixture가 injected fetch를 사용하므로 HTTP 예외 설정을 추가하지 않는다.

- [ ] **Step 5: config 테스트와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/config.test.ts && pnpm --filter @toard/web typecheck`

Expected: config tests PASS, TypeScript error 0.

- [ ] **Step 6: Task 1을 커밋한다**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/key-management/config.ts apps/web/lib/key-management/config.test.ts
git commit -m "build(security): KMS provider SDK와 설정 계약 추가"
```

---

### Task 2: AWS KMS adapter

**Files:**
- Create: `apps/web/lib/key-management/aws-kms-provider.ts`
- Create: `apps/web/lib/key-management/aws-kms-provider.test.ts`

**Interfaces:**
- Consumes AWS `KMSClient`, `EncryptCommand`, `DecryptCommand`.
- Produces `AwsKmsProvider implements KeyManagementProvider`.

- [ ] **Step 1: AWS command mapping 실패 테스트를 작성한다**

```ts
test("AWS adapter는 symmetric key와 동일 EncryptionContext를 사용한다", async () => {
  const client = new RecordingAwsClient();
  const provider = new AwsKmsProvider({
    keyArn: KEY_ARN,
    region: "ap-northeast-2",
    client,
  });
  const wrapped = await provider.wrapKey(UCK, CONTEXT);
  const encrypt = client.inputs[0]!;
  assert.equal(encrypt.KeyId, KEY_ARN);
  assert.equal(encrypt.EncryptionAlgorithm, "SYMMETRIC_DEFAULT");
  assert.deepEqual(encrypt.EncryptionContext, keyContextMap(CONTEXT));
  await provider.unwrapKey(wrapped, CONTEXT);
  assert.deepEqual(client.inputs[1]!.EncryptionContext, encrypt.EncryptionContext);
});
```

- [ ] **Step 2: 테스트가 adapter 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/aws-kms-provider.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: AWS adapter를 구현한다**

```ts
export class AwsKmsProvider implements KeyManagementProvider {
  readonly name = "aws-kms" as const;
  readonly keyRef: string;
  readonly fingerprint: string;
  private readonly client: Pick<KMSClient, "send">;

  constructor(input: AwsKmsProviderInput) {
    this.keyRef = input.keyArn;
    this.fingerprint = fingerprint(this.name, input.keyArn, input.region, input.endpoint);
    this.client = input.client ?? new KMSClient({
      region: input.region,
      endpoint: input.endpoint,
    });
  }

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const payload = encodeUserKeyPayload(uck, context);
    const output = await this.client.send(new EncryptCommand({
      KeyId: this.keyRef,
      Plaintext: payload,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      EncryptionContext: keyContextMap(context),
    }));
    if (!output.CiphertextBlob) throw providerError(this.name, "EMPTY_CIPHERTEXT");
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(output.CiphertextBlob),
      metadata: { algorithm: "SYMMETRIC_DEFAULT" },
    };
  }
}
```

`unwrapKey`는 `DecryptCommand`에 `KeyId`, `CiphertextBlob`, `SYMMETRIC_DEFAULT`, 동일 `EncryptionContext`를 전달하고 `Plaintext`를 `decodeUserKeyPayload`로 검증한다. 생성자에 credential을 전달하지 않아 SDK default provider chain을 사용한다.

- [ ] **Step 4: 오류 redaction 테스트를 추가한다**

```ts
await assert.rejects(
  provider.wrapKey(UCK, CONTEXT),
  (error: Error) => error.message === "aws-kms:THROTTLED"
    && !error.message.includes("AKIA")
    && !error.message.includes(UCK.toString("base64")),
);
```

AWS `$metadata.httpStatusCode`, `name`, retryable 여부만 `ProviderErrorCode`로 분류하고 원본 message와 response body는 버린다.

- [ ] **Step 5: AWS tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/aws-kms-provider.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 6: Task 2를 커밋한다**

```bash
git add apps/web/lib/key-management/aws-kms-provider.ts apps/web/lib/key-management/aws-kms-provider.test.ts
git commit -m "feat(security): AWS KMS 사용자 키 adapter 추가"
```

---

### Task 3: GCP Cloud KMS와 Azure Key Vault adapter

**Files:**
- Create: `apps/web/lib/key-management/gcp-kms-provider.ts`
- Create: `apps/web/lib/key-management/gcp-kms-provider.test.ts`
- Create: `apps/web/lib/key-management/azure-key-vault-provider.ts`
- Create: `apps/web/lib/key-management/azure-key-vault-provider.test.ts`

**Interfaces:**
- Produces `GcpKmsProvider`.
- Produces `AzureKeyVaultProvider`.
- Produces `createAzureCredential(mode, env, nodeEnv)`.

- [ ] **Step 1: GCP AAD mapping 실패 테스트를 작성한다**

```ts
test("GCP adapter는 full key name과 additionalAuthenticatedData를 사용한다", async () => {
  const provider = new GcpKmsProvider({ keyName: GCP_KEY_NAME, client });
  const wrapped = await provider.wrapKey(UCK, CONTEXT);
  assert.deepEqual(client.encryptInputs[0], {
    name: GCP_KEY_NAME,
    plaintext: encodeUserKeyPayload(UCK, CONTEXT),
    additionalAuthenticatedData: canonicalKeyContext(CONTEXT),
  });
  await provider.unwrapKey(wrapped, CONTEXT);
  assert.deepEqual(
    client.decryptInputs[0]!.additionalAuthenticatedData,
    canonicalKeyContext(CONTEXT),
  );
});
```

- [ ] **Step 2: Azure algorithm과 credential mode 실패 테스트를 작성한다**

```ts
test("Azure adapter는 RSA-OAEP-256 wrap/unwrap을 사용한다", async () => {
  const provider = new AzureKeyVaultProvider({ keyId: AZURE_KEY_ID, cryptoClient });
  const wrapped = await provider.wrapKey(UCK, CONTEXT);
  assert.equal(cryptoClient.wrapCalls[0]!.algorithm, "RSA-OAEP-256");
  await provider.unwrapKey(wrapped, CONTEXT);
  assert.equal(cryptoClient.unwrapCalls[0]!.algorithm, "RSA-OAEP-256");
});

test("Azure production credential은 deterministic identity만 허용한다", () => {
  assert.equal(createAzureCredential("managed-identity", env, "production").kind, "managed");
  assert.equal(createAzureCredential("workload-identity", env, "production").kind, "workload");
  assert.throws(() => createAzureCredential("default", env, "production"), /AZURE_DEFAULT_CREDENTIAL_FORBIDDEN/);
});
```

`AZURE_KEY_ID`는 `/keys/{name}/{version}` 형태여야 하며 adapter 직접 생성도
versionless ID를 거부한다. production의 `default` credential 금지는 injected
crypto client 사용 여부와 무관하게 생성자에서 먼저 검증한다.

- [ ] **Step 3: 두 테스트가 adapter 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/gcp-kms-provider.test.ts lib/key-management/azure-key-vault-provider.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: GCP adapter를 구현한다**

```ts
export class GcpKmsProvider implements KeyManagementProvider {
  readonly name = "gcp-kms" as const;

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const [response] = await this.client.encrypt({
      name: this.keyRef,
      plaintext: encodeUserKeyPayload(uck, context),
      additionalAuthenticatedData: canonicalKeyContext(context),
    });
    if (!response.ciphertext) throw providerError(this.name, "EMPTY_CIPHERTEXT");
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(response.ciphertext as Uint8Array),
      metadata: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION" },
    };
  }
}
```

기본 client는 `new KeyManagementServiceClient({ apiEndpoint })`이며 credential option을 넘기지 않아 ADC를 사용한다. `unwrapKey`는 `decrypt({name,ciphertext,additionalAuthenticatedData})` 결과를 context payload로 검증한다.

- [ ] **Step 5: Azure adapter와 credential factory를 구현한다**

```ts
export function createAzureCredential(
  mode: "managed-identity" | "workload-identity" | "default",
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): TokenCredential {
  if (mode === "managed-identity") {
    return env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential(env.AZURE_CLIENT_ID)
      : new ManagedIdentityCredential();
  }
  if (mode === "workload-identity") return new WorkloadIdentityCredential();
  if (nodeEnv === "production") throw new Error("AZURE_DEFAULT_CREDENTIAL_FORBIDDEN");
  return new DefaultAzureCredential();
}
```

```ts
export class AzureKeyVaultProvider implements KeyManagementProvider {
  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const result = await this.client.wrapKey(
      "RSA-OAEP-256",
      encodeUserKeyPayload(uck, context),
    );
    return {
      provider: "azure-key-vault",
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(result.result),
      metadata: { algorithm: "RSA-OAEP-256" },
    };
  }
}
```

기본 crypto client는 `new CryptographyClient(keyId, credential)`이다. `unwrapKey("RSA-OAEP-256", ciphertext)` 결과만 context payload로 검증한다.

- [ ] **Step 6: GCP/Azure tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/gcp-kms-provider.test.ts lib/key-management/azure-key-vault-provider.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 7: Task 3을 커밋한다**

```bash
git add apps/web/lib/key-management/gcp-kms-provider.ts apps/web/lib/key-management/gcp-kms-provider.test.ts apps/web/lib/key-management/azure-key-vault-provider.ts apps/web/lib/key-management/azure-key-vault-provider.test.ts
git commit -m "feat(security): GCP와 Azure KMS adapter 추가"
```

---

### Task 4: Vault/OpenBao Transit auth와 adapter

**Files:**
- Create: `apps/web/lib/key-management/transit-token-source.ts`
- Create: `apps/web/lib/key-management/transit-token-source.test.ts`
- Create: `apps/web/lib/key-management/transit-client.ts`
- Create: `apps/web/lib/key-management/transit-client.test.ts`
- Create: `apps/web/lib/key-management/vault-transit-provider.ts`
- Create: `apps/web/lib/key-management/openbao-transit-provider.ts`
- Create: `apps/web/lib/key-management/transit-providers.test.ts`

**Interfaces:**
- Produces `TransitTokenSource.getToken(): Promise<string>`.
- Produces `TransitClient.encrypt(payload, aad): Promise<string>`.
- Produces `TransitClient.decrypt(ciphertext, aad): Promise<Buffer>`.
- Produces separate `VaultTransitProvider`, `OpenBaoTransitProvider`.

- [ ] **Step 1: token source 만료·file rotation 실패 테스트를 작성한다**

```ts
test("token-file source는 매 요청 최신 secret file을 읽는다", async () => {
  const source = new FileTokenSource("/run/secrets/token", readFile);
  assert.equal(await source.getToken(), "token-a");
  files.set("/run/secrets/token", "token-b\n");
  assert.equal(await source.getToken(), "token-b");
});

test("AppRole source는 만료 30초 전에 다시 로그인한다", async () => {
  const source = new AppRoleTokenSource({ address, mount: "approle", roleIdFile, secretIdFile, fetch });
  assert.equal(await source.getToken(), "first");
  clock.advance(1_171_000);
  assert.equal(await source.getToken(), "second");
  assert.equal(loginCalls, 2);
});
```

- [ ] **Step 2: Transit AAD와 header 실패 테스트를 작성한다**

```ts
test("Transit client는 associated_data와 namespace를 encrypt/decrypt에 동일 적용한다", async () => {
  const client = new TransitClient({
    address: "https://vault.example.com",
    mount: "transit",
    keyName: "toard",
    namespace: "team-a",
    tokenSource,
    fetch,
  });
  const ciphertext = await client.encrypt(PAYLOAD, AAD);
  assert.equal(requests[0]!.headers["X-Vault-Namespace"], "team-a");
  assert.deepEqual(JSON.parse(requests[0]!.body), {
    plaintext: PAYLOAD.toString("base64"),
    associated_data: AAD.toString("base64"),
  });
  assert.deepEqual(await client.decrypt(ciphertext, AAD), PAYLOAD);
});
```

- [ ] **Step 3: 테스트가 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/transit-token-source.test.ts lib/key-management/transit-client.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: token source를 구현한다**

```ts
export interface TransitTokenSource {
  readonly description: CredentialSourceSummary;
  getToken(): Promise<string>;
}

export class KubernetesTokenSource extends CachedLoginTokenSource {
  protected async login(): Promise<LoginToken> {
    const jwt = readSecretFile(this.jwtFile);
    return loginTransit(this.fetch, this.address, this.namespace,
      `/v1/auth/${encodeURIComponent(this.mount)}/login`,
      { role: this.role, jwt });
  }
}

export class AppRoleTokenSource extends CachedLoginTokenSource {
  protected async login(): Promise<LoginToken> {
    return loginTransit(this.fetch, this.address, this.namespace,
      `/v1/auth/${encodeURIComponent(this.mount)}/login`,
      {
        role_id: readSecretFile(this.roleIdFile),
        secret_id: readSecretFile(this.secretIdFile),
      });
  }
}
```

`CachedLoginTokenSource`는 `client_token`, `lease_duration`, `renewable`만 읽고 `expiresAt=now+lease*1000`을 계산한다. token은 로그나 error에 넣지 않는다. 만료 30초 전이면 같은 source의 동시 login을 single-flight로 합친다.

- [ ] **Step 5: Transit HTTP client와 provider를 구현한다**

```ts
async function transitPost(
  path: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const token = await this.tokenSource.getToken();
  const response = await this.fetch(new URL(`/v1/${path}`, this.address), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vault-token": token,
      ...(this.namespace ? { "x-vault-namespace": this.namespace } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw classifyTransitStatus(response.status);
  const json = await response.json() as { data?: Record<string, unknown> };
  if (!json.data) throw new Error("TRANSIT_RESPONSE_INVALID");
  return json.data;
}
```

```ts
export class TransitKeyManagementProvider implements KeyManagementProvider {
  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const ciphertext = await this.client.encrypt(
      encodeUserKeyPayload(uck, context),
      canonicalKeyContext(context),
    );
    return {
      provider: this.name,
      keyRef: this.client.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(ciphertext, "utf8"),
      metadata: { algorithm: "transit-aead", format: "vault-ciphertext-v1" },
    };
  }
}
```

Vault와 OpenBao class는 같은 base를 사용하지만 `name`을 각각 `vault-transit`, `openbao-transit`로 고정한다. decrypt 결과는 base64 plaintext를 decode하고 context payload를 검증한다.

- [ ] **Step 6: Transit tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/transit-token-source.test.ts lib/key-management/transit-client.test.ts lib/key-management/transit-providers.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 7: Task 4를 커밋한다**

```bash
git add apps/web/lib/key-management/transit-token-source.ts apps/web/lib/key-management/transit-token-source.test.ts apps/web/lib/key-management/transit-client.ts apps/web/lib/key-management/transit-client.test.ts apps/web/lib/key-management/vault-transit-provider.ts apps/web/lib/key-management/openbao-transit-provider.ts apps/web/lib/key-management/transit-providers.test.ts
git commit -m "feat(security): Vault와 OpenBao Transit adapter 추가"
```

---

### Task 5: provider factory와 health canary

**Files:**
- Create: `apps/web/lib/key-management/provider-factory.ts`
- Create: `apps/web/lib/key-management/provider-factory.test.ts`
- Create: `apps/web/lib/key-management/provider-health-cache.ts`
- Create: `apps/web/lib/key-management/provider-health-cache.test.ts`
- Modify: `apps/web/lib/key-management/registry.ts`
- Modify: `apps/web/lib/key-management/registry.test.ts`

**Interfaces:**
- Produces `createKeyProvider(profile, dependencies): KeyManagementProvider`.
- Produces `createKeyProviderRegistry(config): KeyProviderRegistry`.
- Produces `ProviderHealthCache.check(provider): Promise<KeyProviderHealth>`.

- [ ] **Step 1: 모든 provider factory mapping 실패 테스트를 작성한다**

```ts
for (const name of [
  "local", "aws-kms", "gcp-kms", "azure-key-vault", "vault-transit", "openbao-transit",
] as const) {
  test(`${name} profile creates matching provider`, () => {
    assert.equal(createKeyProvider(profile(name), dependencies).name, name);
  });
}
```

- [ ] **Step 2: health cache 실패 테스트를 작성한다**

```ts
test("health canary는 60초 동안 재호출하지 않고 wrap 결과를 constant-time 검증한다", async () => {
  const cache = new ProviderHealthCache({ ttlMs: 60_000, now: clock.now });
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal(provider.wrapCalls, 1);
  assert.equal(provider.unwrapCalls, 1);
});
```

- [ ] **Step 3: factory와 health cache를 구현한다**

```ts
export async function runProviderCanary(provider: KeyManagementProvider): Promise<KeyProviderHealth> {
  const uck = randomBytes(32);
  const context = {
    installationId: "00000000-0000-0000-0000-000000000000",
    userId: "00000000-0000-0000-0000-000000000000",
    keyVersion: 1,
    purpose: "prompt-history" as const,
  };
  const started = performance.now();
  try {
    const wrapped = await provider.wrapKey(uck, context);
    const unwrapped = await provider.unwrapKey(wrapped, context);
    if (!timingSafeEqual(uck, unwrapped)) throw new Error("PROVIDER_CANARY_MISMATCH");
    return { status: "healthy", latencyMs: performance.now() - started, checkedAt: new Date() };
  } catch (error) {
    return toSafeHealth(error, performance.now() - started);
  } finally {
    uck.fill(0);
  }
}
```

`ProviderHealthCache`는 fingerprint별 promise를 cache해 health check 동시 호출도 single-flight로 합친다. `provider-factory.ts`는 profile parser가 검증한 설정만 읽고 provider 생성자에 secret raw 값을 전달하지 않는다.

- [ ] **Step 4: 전체 provider unit tests를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test 'lib/key-management/*.test.ts' && pnpm --filter @toard/web typecheck`

Expected: 모든 provider tests PASS, TypeScript error 0.

- [ ] **Step 5: opt-in 실제 provider canary runner를 추가한다**

Create `scripts/verify-key-provider.ts`에서 `TOARD_VERIFY_KEY_PROVIDER=1`일 때만 active profile을 로드하고 `runProviderCanary`를 실행한다. 출력은 아래 JSON 필드만 허용한다.

```ts
console.log(JSON.stringify({
  provider: provider.name,
  keyRef: provider.keyRef,
  fingerprint: provider.fingerprint,
  status: result.status,
  latencyMs: Math.round(result.latencyMs),
}));
```

Run: `TOARD_VERIFY_KEY_PROVIDER=0 node --import tsx scripts/verify-key-provider.ts`

Expected: exit code 2, `TOARD_VERIFY_KEY_PROVIDER=1 required`; provider API는 호출되지 않음.

- [ ] **Step 6: Task 5를 커밋한다**

```bash
git add apps/web/lib/key-management/provider-factory.ts apps/web/lib/key-management/provider-factory.test.ts apps/web/lib/key-management/provider-health-cache.ts apps/web/lib/key-management/provider-health-cache.test.ts apps/web/lib/key-management/registry.ts apps/web/lib/key-management/registry.test.ts scripts/verify-key-provider.ts
git commit -m "feat(security): KMS provider factory와 health canary 추가"
```

---

## Plan 2 Completion Gate

Run:

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm lint
git diff --check HEAD~5
```

Expected:

- 여섯 provider가 동일 contract suite를 통과한다.
- production Azure `default` credential이 fail-closed한다.
- Transit HTTP 테스트에서 TLS URL, namespace, associated data, token rotation이 검증된다.
- 실제 credential 없이 기본 CI가 통과한다.
