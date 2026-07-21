# Managed Encryption Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KMS 상태·비용·migration 진행률을 비밀 노출 없이 운영하고 Compose/Helm에서 여섯 공급자와 전용 content-admin 작업을 배포할 수 있게 한다.

**Architecture:** KMS 호출과 cache 결과는 비민감 일별 집계로 저장하고 키 생성·전환만 별도 security event로 기록한다. 관리자 시스템 화면은 provider health, credential source 종류, 호출량, 예상 비용, scheme별 행 수를 읽기 전용으로 표시한다. 배포 설정은 secret file directory와 workload identity service account를 지원하며 content-admin은 별도 이미지/프로필로만 실행한다.

**Tech Stack:** Next.js 15, React 19, PostgreSQL 16, Docker Compose, Helm 3, Kubernetes workload identity, Node test runner.

## Global Constraints

- 관리자 UI에서 credential, token, key material을 입력·저장·표시하지 않는다.
- provider key ref와 fingerprint는 비민감 값이지만 전체 URL query나 credential identifier를 포함하지 않는다.
- 일별 operation 집계에는 plaintext, wrapped key, user ID를 저장하지 않는다.
- security event에는 user ID를 저장할 수 있지만 본문·UCK·DEK·credential은 저장하지 않는다.
- operation metric 저장 실패는 본문 암호화 성공을 실패로 바꾸지 않는다.
- built-in 비용은 참고값과 기준일을 함께 표시하며 실제 청구 금액으로 표현하지 않는다.
- Azure/Vault/OpenBao는 operator 단가 override가 없으면 호출량만 표시하고 금액을 만들지 않는다.
- content-admin container는 평상시 실행하지 않고 명시적 one-shot profile/job으로만 실행한다.
- schema migrator와 seed container에는 KMS credential이나 secret volume을 주입하지 않는다.
- 신규 E2EE setup/activation은 항상 거부한다.
- 기존 E2EE recovery/migration API는 `e2ee_v1` 또는 blocked row가 남아 있는 동안 유지한다.
- legacy 데이터의 자동 삭제 기능을 만들지 않는다.

---

## File Structure

- `migrations/1700000037_content_key_operations.sql`: 비민감 일별 집계와 security events.
- `apps/web/lib/key-management/observability.ts`: provider/cache 관찰 hook.
- `apps/web/lib/encryption-admin-status.ts`: 관리자 read model과 비용 계산.
- `apps/web/app/api/admin/encryption/status/route.ts`: admin-only no-store JSON.
- `apps/web/app/(dashboard)/admin/encryption-panel.tsx`: 읽기 전용 운영 panel.
- `Dockerfile`: `content-admin` target.
- `docker-compose.yml`: provider env, secret directory, content-admin profile.
- `.github/workflows/docker-publish.yml`: content-admin 멀티아치 이미지 publish.
- `helm/toard/templates/serviceaccount.yaml`: workload identity service account.
- Helm values/templates: extra env/volume와 provider 설정.
- `docs/content-encryption-runbook.md`: provider별 연결·회전·복구 런북.

---

### Task 1: KMS operation 집계와 security audit

**Files:**
- Create: `migrations/1700000037_content_key_operations.sql`
- Create: `scripts/content-key-operations-migration.integration.test.ts`
- Create: `apps/web/lib/key-management/observability.ts`
- Create: `apps/web/lib/key-management/observability.test.ts`
- Modify: `apps/web/lib/key-management/provider-factory.ts`
- Modify: `apps/web/lib/key-management/user-key-cache.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `content_key_operation_daily`.
- Produces `content_key_security_events`.
- Produces `ObservedKeyManagementProvider`.
- Produces `recordCacheResult`.

- [ ] **Step 1: migration과 secret-free shape 실패 테스트를 작성한다**

```ts
test("operation aggregate stores counts without user or payload columns", { timeout: 90_000 }, async () => {
  const columns = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='content_key_operation_daily' ORDER BY column_name`,
  );
  const names = columns.rows.map((row) => row.column_name);
  assert.equal(names.includes("user_id"), false);
  assert.equal(names.includes("ciphertext"), false);
  assert.equal(names.includes("credential"), false);
  assert.equal(names.includes("count"), true);
});
```

- [ ] **Step 2: migration 파일 부재로 실패하는지 확인한다**

Run: `node --import tsx --test scripts/content-key-operations-migration.integration.test.ts`

Expected: FAIL with `ENOENT ... 1700000037_content_key_operations.sql`.

- [ ] **Step 3: operation aggregate와 security event table을 구현한다**

```sql
CREATE TABLE content_key_operation_daily (
  day DATE NOT NULL,
  provider TEXT NOT NULL,
  provider_fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('wrap','unwrap','health')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success','throttled','unavailable','auth','invalid')),
  cache_result TEXT NOT NULL CHECK (cache_result IN ('none','hit','miss','single_flight')),
  operation_count BIGINT NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
  total_latency_ms BIGINT NOT NULL DEFAULT 0 CHECK (total_latency_ms >= 0),
  PRIMARY KEY(day,provider,provider_fingerprint,operation,outcome,cache_result)
);

CREATE TABLE content_key_security_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'user_key_created','user_key_rewrapped','provider_migration_started',
    'provider_migration_completed','e2ee_migration_blocked','e2ee_migration_resumed'
  )),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  provider TEXT,
  provider_fingerprint TEXT,
  key_version SMALLINT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  app_instance_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX content_key_security_events_created
  ON content_key_security_events(created_at DESC);
```

app role에는 두 테이블의 SELECT/INSERT와 aggregate UPDATE 권한을 준다. Down은 데이터 존재 시 실패한다.

- [ ] **Step 4: provider 관찰 실패 테스트를 작성한다**

```ts
test("observed provider records safe success and ignores metrics DB failure", async () => {
  const provider = new ObservedKeyManagementProvider(inner, {
    record: async (event) => { events.push(event); throw new Error("metrics down"); },
  });
  const wrapped = await provider.wrapKey(UCK, CONTEXT);
  assert.equal(wrapped.provider, inner.name);
  assert.deepEqual(events[0], {
    provider: inner.name,
    fingerprint: inner.fingerprint,
    operation: "wrap",
    outcome: "success",
    latencyMs: 12,
  });
});
```

- [ ] **Step 5: observability wrapper와 aggregate upsert를 구현한다**

```ts
export async function recordKeyOperation(event: KeyOperationEvent): Promise<void> {
  await getPool().query(
    `INSERT INTO content_key_operation_daily
       (day,provider,provider_fingerprint,operation,outcome,cache_result,
        operation_count,total_latency_ms)
     VALUES(CURRENT_DATE,$1,$2,$3,$4,$5,1,$6)
     ON CONFLICT(day,provider,provider_fingerprint,operation,outcome,cache_result)
     DO UPDATE SET
       operation_count=content_key_operation_daily.operation_count+1,
       total_latency_ms=content_key_operation_daily.total_latency_ms+EXCLUDED.total_latency_ms`,
    [
      event.provider, event.fingerprint, event.operation, event.outcome,
      event.cacheResult ?? "none", Math.max(0, Math.round(event.latencyMs)),
    ],
  );
}
```

`ObservedKeyManagementProvider`는 inner 호출을 await하고 safe outcome을 기록한다. metric write는 `await recorder.record(event).catch(() => undefined)`로 처리한다. `UserKeyCache`는 hit/miss/single-flight hook을 호출하되 key bytes를 event에 전달하지 않는다.

- [ ] **Step 6: tests와 migration suite를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/observability.test.ts && node --import tsx --test scripts/content-key-operations-migration.integration.test.ts && pnpm test:migrations`

Expected: tests PASS, migration suite PASS.

- [ ] **Step 7: Task 1을 커밋한다**

```bash
git add migrations/1700000037_content_key_operations.sql scripts/content-key-operations-migration.integration.test.ts apps/web/lib/key-management/observability.ts apps/web/lib/key-management/observability.test.ts apps/web/lib/key-management/provider-factory.ts apps/web/lib/key-management/user-key-cache.ts package.json
git commit -m "feat(ops): KMS 호출 집계와 보안 감사 추가"
```

---

### Task 2: 관리자 암호화 상태와 예상 비용

**Files:**
- Create: `apps/web/lib/encryption-admin-status.ts`
- Create: `apps/web/lib/encryption-admin-status.test.ts`
- Create: `apps/web/app/api/admin/encryption/status/route.ts`
- Create: `apps/web/app/api/admin/encryption/status/route.test.ts`
- Create: `apps/web/app/(dashboard)/admin/encryption-panel.tsx`
- Create: `apps/web/app/(dashboard)/admin/encryption-panel.test.tsx`
- Modify: `apps/web/app/(dashboard)/admin/page.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`

**Interfaces:**
- Produces `getEncryptionAdminStatus`.
- Produces admin-only `/api/admin/encryption/status`.
- Produces read-only `EncryptionPanel`.

- [ ] **Step 1: 비용 계산과 secret-free status 실패 테스트를 작성한다**

```ts
test("AWS/GCP reference cost and operator override are explicit", async () => {
  const status = await getEncryptionAdminStatus({
    env: {
      TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
      TOARD_KEY_COST_PER_10000_USD: "0.04",
      TOARD_KEY_MONTHLY_KEY_COST_USD: "1.25",
    },
    db,
    runtime,
  });
  assert.deepEqual(status.costEstimate, {
    currency: "USD",
    requestCost: 0.08,
    monthlyKeyCost: 1.25,
    total: 1.33,
    source: "operator-override",
  });
  assert.equal(JSON.stringify(status).includes("client_secret"), false);
});
```

- [ ] **Step 2: status module 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/encryption-admin-status.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: admin read model을 구현한다**

```ts
export type EncryptionAdminStatus = {
  enabled: boolean;
  provider: KeyProviderName | null;
  keyRef: string | null;
  fingerprint: string | null;
  credentialSource: { kind: string; staticCredential: boolean } | null;
  health: KeyProviderHealth | null;
  records: { serverV1: number; e2eeV1: number; managedV1: number };
  userKeys: { active: number; pending: number; retiring: number };
  migrations: { e2eePending: number; e2eeBlocked: number };
  operations30d: Array<{
    operation: "wrap" | "unwrap" | "health";
    outcome: string;
    count: number;
    averageLatencyMs: number;
  }>;
  cache30d: { hit: number; miss: number; singleFlight: number };
  costEstimate: CostEstimate | null;
};
```

DB query는 `content_encryption_status`의 scheme·migration 집계와 `content_key_operation_daily` 최근 30일만 읽는다. RLS가 적용된 `content_e2ee_migrations`, wrapper table, prompt ciphertext를 관리자 status에서 직접 읽지 않는다.

내장 참고 단가는 아래 상수로 격리한다.

```ts
const REFERENCE_PRICING = {
  "aws-kms": { asOf: "2026-07-17", per10kUsd: 0.03, monthlyKeyUsd: 1.00 },
  "gcp-kms": { asOf: "2026-07-17", per10kUsd: 0.03, monthlyKeyUsd: 0.06 },
} as const;
```

override는 `TOARD_KEY_COST_PER_10000_USD`, `TOARD_KEY_MONTHLY_KEY_COST_USD`의 0 이상 유한 숫자만 허용한다. Azure/Vault/OpenBao/local은 override 없으면 `costEstimate=null`이다.
내장 계산은 무료 구간·약정·세금·네트워크 비용을 차감하지 않은 gross 참고치임을 UI에 표시한다.

- [ ] **Step 4: admin-only route를 구현한다**

```ts
export async function GET() {
  const user = await getSessionUser();
  if (!user) return noStoreJson({ code: "UNAUTHORIZED" }, 401);
  if (user.role !== "admin") return noStoreJson({ code: "FORBIDDEN" }, 403);
  return noStoreJson(await getEncryptionAdminStatus(), 200);
}
```

- [ ] **Step 5: read-only panel을 구현한다**

Panel은 provider/key ref, credential source, static credential 경고, health, cache hit rate, 30일 호출량, 예상 비용, 세 scheme 건수, pending/blocked migration을 표시한다. input, password field, provider select, 실행 button은 렌더하지 않는다.

```tsx
<SettingsRow wide label={t("encryption.provider")} description={t("encryption.providerDescription")}>
  <div className="space-y-1 text-sm">
    <p>{status.provider ?? t("encryption.disabled")}</p>
    <p className="text-muted-foreground font-mono text-xs">{status.keyRef ?? "—"}</p>
  </div>
</SettingsRow>
```

- [ ] **Step 6: status/route/panel tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/encryption-admin-status.test.ts app/api/admin/encryption/status/route.test.ts app/'(dashboard)'/admin/encryption-panel.test.tsx && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0, panel source에 `<input`과 `type="password"` 없음.

- [ ] **Step 7: Task 2를 커밋한다**

```bash
git add apps/web/lib/encryption-admin-status.ts apps/web/lib/encryption-admin-status.test.ts apps/web/app/api/admin/encryption/status apps/web/app/'(dashboard)'/admin/encryption-panel.tsx apps/web/app/'(dashboard)'/admin/encryption-panel.test.tsx apps/web/app/'(dashboard)'/admin/page.tsx apps/web/messages/ko/admin.json apps/web/messages/en/admin.json
git commit -m "feat(admin): managed 암호화 운영 상태 추가"
```

---

### Task 3: content-admin 이미지와 Compose provider 설정

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.github/workflows/docker-publish.yml`
- Create: `docs/examples/content-encryption.env.example`
- Create: `scripts/compose-encryption-config.test.ts`

**Interfaces:**
- Produces Docker target `content-admin`.
- Produces Compose profile service `content-admin`.
- Mounts only app/content-admin secret directory, never migrate/seed.

- [ ] **Step 1: Compose 구조 실패 테스트를 작성한다**

```ts
test("compose isolates KMS credentials from migrate and seed", () => {
  const compose = parse(readFileSync("docker-compose.yml", "utf8"));
  assert.equal(compose.services.migrate.environment.TOARD_KEY_ACTIVE_PROVIDER, undefined);
  assert.equal(compose.services.seed.environment.TOARD_KEY_ACTIVE_PROVIDER, undefined);
  assert.equal(compose.services.app.environment.TOARD_KEY_ACTIVE_PROVIDER, "${TOARD_KEY_ACTIVE_PROVIDER:-}");
  assert.deepEqual(compose.services["content-admin"].profiles, ["content-admin"]);
});
```

- [ ] **Step 2: test가 content-admin 부재로 실패하는지 확인한다**

Run: `node --import tsx --test scripts/compose-encryption-config.test.ts`

Expected: `content-admin` service assertion에서 FAIL.

- [ ] **Step 3: Docker content-admin target을 추가한다**

```dockerfile
FROM deps AS content-admin
ENV HOME=/tmp NODE_ENV=production
COPY . .
ENTRYPOINT ["pnpm", "toard-admin"]
CMD ["encryption", "status"]
```

schema migrator target은 현재처럼 migrations/scripts만 복사하고 KMS provider env나 secret volume을 요구하지 않는다.

- [ ] **Step 4: Compose app과 content-admin 공통 env anchor를 추가한다**

```yaml
x-content-encryption-env: &content-encryption-env
  TOARD_KEY_ACTIVE_PROVIDER: ${TOARD_KEY_ACTIVE_PROVIDER:-}
  TOARD_KEY_MIGRATION_PROVIDER: ${TOARD_KEY_MIGRATION_PROVIDER:-}
  TOARD_USER_KEY_CACHE_TTL_SECONDS: ${TOARD_USER_KEY_CACHE_TTL_SECONDS:-1800}
  TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: ${TOARD_KEY_ACTIVE_LOCAL_KEK_FILE:-}
  TOARD_KEY_MIGRATION_LOCAL_KEK_FILE: ${TOARD_KEY_MIGRATION_LOCAL_KEK_FILE:-}
  TOARD_KEY_ACTIVE_AWS_KEY_ARN: ${TOARD_KEY_ACTIVE_AWS_KEY_ARN:-}
  TOARD_KEY_ACTIVE_AWS_REGION: ${TOARD_KEY_ACTIVE_AWS_REGION:-}
  TOARD_KEY_ACTIVE_GCP_KEY_NAME: ${TOARD_KEY_ACTIVE_GCP_KEY_NAME:-}
  TOARD_KEY_ACTIVE_AZURE_KEY_ID: ${TOARD_KEY_ACTIVE_AZURE_KEY_ID:-}
  TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE: ${TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE:-}
  TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: ${TOARD_KEY_ACTIVE_TRANSIT_ADDRESS:-}
  TOARD_KEY_ACTIVE_TRANSIT_MOUNT: ${TOARD_KEY_ACTIVE_TRANSIT_MOUNT:-}
  TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: ${TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME:-}
  TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: ${TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD:-}
  AWS_REGION: ${AWS_REGION:-}
  AWS_ROLE_ARN: ${AWS_ROLE_ARN:-}
  AWS_WEB_IDENTITY_TOKEN_FILE: ${AWS_WEB_IDENTITY_TOKEN_FILE:-}
  GOOGLE_APPLICATION_CREDENTIALS: ${GOOGLE_APPLICATION_CREDENTIALS:-}
  AZURE_CLIENT_ID: ${AZURE_CLIENT_ID:-}
  AZURE_TENANT_ID: ${AZURE_TENANT_ID:-}
  AZURE_FEDERATED_TOKEN_FILE: ${AZURE_FEDERATED_TOKEN_FILE:-}
```

같은 패턴으로 migration provider와 Transit auth file 변수를 모두 명시한다. app과 content-admin에만 `*content-encryption-env`를 merge하고 `${TOARD_KEY_SECRET_DIR:-./secrets}:/run/toard-secrets:ro`를 mount한다.

- [ ] **Step 5: one-shot service를 추가한다**

```yaml
content-admin:
  image: ghcr.io/devy1540/toard-content-admin:${TOARD_TAG:-latest}
  build:
    context: .
    target: content-admin
  profiles: ["content-admin"]
  environment:
    <<: [*db-url, *content-encryption-env]
    TOARD_CONTENT_KEK_B64: ${TOARD_CONTENT_KEK_B64:-}
  volumes:
    - ${TOARD_KEY_SECRET_DIR:-./secrets}:/run/toard-secrets:ro
  depends_on:
    postgres:
      condition: service_healthy
  restart: "no"
```

- [ ] **Step 6: env example을 provider별 완성형으로 작성한다**

파일에는 실제 secret 값을 넣지 않고 경로·ARN·resource name 예시 표식만 둔다. AWS/GCP/Azure/Vault/OpenBao/local 각각 active 예시와 provider 전환용 migration 예시를 한 블록씩 제공한다.

- [ ] **Step 7: content-admin 이미지를 GHCR publish matrix에 추가한다**

`.github/workflows/docker-publish.yml`의 build·merge matrix에 아래 항목을 추가하고 상단 주석을 서버 이미지 4종으로 갱신한다.

```yaml
- target: content-admin
  image: toard-content-admin
```

digest artifact 이름은 기존처럼 target 기준으로 분리한다. runner/migrator/updater publish 동작은 변경하지 않는다.

- [ ] **Step 8: Compose config 검증을 통과시킨다**

Run:

```bash
AUTH_SECRET=dummy docker compose config >/tmp/toard-compose.yml
node --import tsx --test scripts/compose-encryption-config.test.ts
```

Expected: compose config exit 0, isolation test PASS.

- [ ] **Step 9: Task 3을 커밋한다**

```bash
git add Dockerfile docker-compose.yml .github/workflows/docker-publish.yml docs/examples/content-encryption.env.example scripts/compose-encryption-config.test.ts
git commit -m "feat(deploy): KMS와 content-admin Compose 배포 추가"
```

---

### Task 4: Helm workload identity와 secret file 확장

**Files:**
- Modify: `helm/toard/values.yaml`
- Create: `helm/toard/templates/serviceaccount.yaml`
- Modify: `helm/toard/templates/configmap.yaml`
- Modify: `helm/toard/templates/secret.yaml`
- Modify: `helm/toard/templates/deployment.yaml`
- Create: `helm/toard/templates/content-admin-job.yaml`
- Create: `scripts/helm-encryption-render.test.ts`

**Interfaces:**
- Supports AWS IRSA, GCP Workload Identity, Azure Workload Identity via service account annotations/labels.
- Supports operator-provided secret file volumes.
- Content admin Job is disabled by default.

- [ ] **Step 1: Helm render 실패 테스트를 작성한다**

```ts
test("helm renders workload identity only on app and content-admin", () => {
  const rendered = helmTemplate({
    serviceAccount: { create: true, annotations: { "eks.amazonaws.com/role-arn": ROLE_ARN } },
    encryption: { provider: "aws-kms", active: { aws: { keyArn: KEY_ARN, region: "ap-northeast-2" } } },
  });
  assert.match(rendered, /eks.amazonaws.com\\/role-arn/);
  assert.match(rendered, /TOARD_KEY_ACTIVE_PROVIDER.*aws-kms/);
  assert.doesNotMatch(resource(rendered, "Job", "migrate"), /TOARD_KEY_ACTIVE_PROVIDER/);
});
```

- [ ] **Step 2: test가 service account/template 부재로 실패하는지 확인한다**

Run: `node --import tsx --test scripts/helm-encryption-render.test.ts`

Expected: Helm template 또는 assertion FAIL.

- [ ] **Step 3: values 계약을 추가한다**

```yaml
image:
  contentAdmin:
    repository: toard-content-admin
    tag: latest
    pullPolicy: IfNotPresent

serviceAccount:
  create: true
  name: ""
  annotations: {}
  podLabels: {}

encryption:
  provider: ""
  cacheTtlSeconds: 1800
  active: {}
  migration: {}
  cost:
    per10000Usd: ""
    monthlyKeyUsd: ""
  secretMounts: []

contentAdmin:
  enabled: false
  command: ["encryption", "status"]
```

`secretMounts` item shape은 `{name, secretName, mountPath, items}`로 고정한다. 임의 hostPath와 inline secret value는 받지 않는다.

- [ ] **Step 4: service account와 app env를 렌더한다**

Deployment는 `serviceAccountName`, `serviceAccount.podLabels`, provider config env, standard AWS/GCP/Azure identity env, secret volumeMount를 app에만 적용한다. migrate initContainer에는 encryption env와 volumeMount를 적용하지 않는다.

- [ ] **Step 5: opt-in content-admin Job을 구현한다**

Job은 `contentAdmin.enabled=true`일 때만 렌더하고 app과 같은 service account, DB secret, encryption config, secret mounts를 사용한다. Helm hook으로 자동 실행하지 않으며 operator가 명시적으로 enable하고 command를 지정한다.

- [ ] **Step 6: provider별 Helm render tests를 통과시킨다**

Run: `node --import tsx --test scripts/helm-encryption-render.test.ts && helm template toard ./helm/toard --set secrets.authSecret=dummy >/tmp/toard-helm.yaml`

Expected: AWS/GCP/Azure/Vault/OpenBao/local fixtures PASS, default chart render exit 0.

- [ ] **Step 7: Task 4를 커밋한다**

```bash
git add helm/toard/values.yaml helm/toard/templates/serviceaccount.yaml helm/toard/templates/configmap.yaml helm/toard/templates/secret.yaml helm/toard/templates/deployment.yaml helm/toard/templates/content-admin-job.yaml scripts/helm-encryption-render.test.ts
git commit -m "feat(helm): KMS workload identity와 관리 Job 추가"
```

---

### Task 5: 운영 런북, 신규 E2EE 차단, 보안 회귀 검증

**Files:**
- Create: `docs/content-encryption-runbook.md`
- Modify: `README.md`
- Modify: `docs/DEPLOY.md`
- Modify: `apps/web/app/api/v1/content/setup/route.ts`
- Modify: `apps/web/app/api/v1/content/activate/route.ts`
- Modify: `apps/web/app/api/v1/content/approval-requests/route.ts`
- Create: `apps/web/lib/e2ee-legacy-gate.ts`
- Create: `apps/web/lib/e2ee-legacy-gate.test.ts`
- Modify: `scripts/e2ee-ciphertext-only.integration.test.ts`
- Create: `scripts/managed-content-security.integration.test.ts`

**Interfaces:**
- Produces provider connection and migration runbook.
- Rejects new E2EE account creation.
- Preserves existing recovery/migration for remaining E2EE data.

- [ ] **Step 1: legacy gate 실패 테스트를 작성한다**

```ts
test("new E2EE setup is disabled while existing account recovery remains allowed", async () => {
  assert.equal(await legacyE2eeCapability(USER_WITHOUT_ACCOUNT, db), "disabled");
  assert.equal(await legacyE2eeCapability(USER_WITH_E2EE_ROWS, db), "migration");
  assert.equal(await legacyE2eeCapability(USER_BLOCKED, db), "recovery");
});
```

- [ ] **Step 2: gate 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-legacy-gate.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 신규 E2EE setup을 차단한다**

```ts
export async function legacyE2eeCapability(
  userId: string,
  db: LegacyGateDb,
): Promise<"disabled" | "migration" | "recovery"> {
  const result = await db.query(
    `SELECT EXISTS(SELECT 1 FROM content_accounts WHERE user_id=$1) AS has_account,
            EXISTS(SELECT 1 FROM prompt_records
                    WHERE user_id=$1 AND encryption_scheme='e2ee_v1') AS has_rows,
            EXISTS(SELECT 1 FROM content_e2ee_migrations
                    WHERE user_id=$1 AND state='blocked') AS blocked`,
    [userId],
  );
  const row = result.rows[0]!;
  if (!row.has_account) return "disabled";
  if (row.blocked) return "recovery";
  return row.has_rows ? "migration" : "disabled";
}
```

`/api/v1/content/setup`과 `/activate`는 항상 `410 E2EE_SETUP_RETIRED`를 반환한다. approval request 조회는 기존 account에 E2EE rows가 있을 때만 허용한다. recovery wrapper/complete와 managed migration API는 `migration|recovery`에서 유지한다.

- [ ] **Step 4: 운영 런북을 작성한다**

`docs/content-encryption-runbook.md`에 아래 명령을 실제 형태로 포함한다.

```bash
# active provider canary
docker compose --profile content-admin run --rm content-admin encryption status

# server_v1 migration
docker compose --profile content-admin run --rm content-admin \
  encryption migrate-server --batch-size 25

# provider rewrap
docker compose --profile content-admin run --rm content-admin \
  encryption rewrap-provider --from aws-kms --to openbao-transit
```

각 공급자별 최소 IAM/ACL operation을 명시한다.

- AWS: `kms:Encrypt`, `kms:Decrypt`, `kms:DescribeKey`
- GCP: encrypt/decrypt/get key 권한을 포함한 최소 custom role 또는 대응 predefined role
- Azure: `keys/wrapKey`, `keys/unwrapKey`, key read
- Vault/OpenBao: `${mount}/encrypt/${key}`, `${mount}/decrypt/${key}`, key read health 경로

runbook은 전환 전 DB 백업, active+mode migration 동시 설정, wrapper 완료 확인, 유예 기간, old KMS 권한 제거 순서를 포함한다.

- [ ] **Step 5: DB/로그 보안 통합 테스트를 추가한다**

```ts
assert.equal(scanDumpForUtf8(pgDump, "secret prompt"), false);
assert.equal(scanDumpForUtf8(pgDump, rawUck.toString("base64")), false);
assert.equal(scanDumpForUtf8(pgDump, "AWS_SECRET_ACCESS_KEY"), false);
assert.equal(await adminCanReadOtherUserPlaintext(), false);
assert.equal(await otherUserCanReadPlaintext(), false);
assert.equal(await appCanDecryptWithKmsPermission(), true);
```

DB superuser는 ciphertext와 wrapper를 읽을 수 있으므로 테스트는 “DB dump만으로 known plaintext를 복구할 수 없음”을 검증한다. app runtime KMS credential을 test process에 제공하지 않은 별도 process에서 decrypt가 실패해야 한다.

- [ ] **Step 6: 전체 검증을 통과시킨다**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
cargo test --manifest-path shim/rust/Cargo.toml
node --import tsx --test scripts/managed-content-security.integration.test.ts
AUTH_SECRET=dummy docker compose config >/tmp/toard-compose.yml
helm template toard ./helm/toard --set secrets.authSecret=dummy >/tmp/toard-helm.yml
git diff --check
```

Expected: 모든 test/typecheck/lint PASS, Compose와 Helm render exit 0, secret scan PASS.

- [ ] **Step 7: Task 5를 커밋한다**

```bash
git add docs/content-encryption-runbook.md README.md docs/DEPLOY.md apps/web/app/api/v1/content/setup/route.ts apps/web/app/api/v1/content/activate/route.ts apps/web/app/api/v1/content/approval-requests/route.ts apps/web/lib/e2ee-legacy-gate.ts apps/web/lib/e2ee-legacy-gate.test.ts scripts/e2ee-ciphertext-only.integration.test.ts scripts/managed-content-security.integration.test.ts
git commit -m "docs(security): managed KMS 운영과 E2EE retirement 완료"
```

---

## Plan 5 Completion Gate

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
cargo test --manifest-path shim/rust/Cargo.toml
AUTH_SECRET=dummy docker compose config >/tmp/toard-compose.yml
helm template toard ./helm/toard --set secrets.authSecret=dummy >/tmp/toard-helm.yml
git diff --check HEAD~5
```

Operational acceptance:

- 관리자 화면에는 provider 상태·호출량·예상 비용만 있고 secret 입력 UI가 없다.
- Compose migrate/seed와 Helm migration initContainer에 KMS credential이 없다.
- content-admin은 명시적 one-shot 실행만 가능하다.
- 신규 사용자는 E2EE setup endpoint를 사용할 수 없다.
- blocked E2EE ciphertext는 삭제되지 않고 recovery/migration 경로가 유지된다.
- old provider 제거 전 status가 모든 active wrapper의 신규 fingerprint 전환을 증명한다.
