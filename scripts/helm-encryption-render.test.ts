import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadKeyManagementConfig } from "../apps/web/lib/key-management/config";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHART = join(ROOT, "helm/toard");
const HELM_IMAGE = process.env.TOARD_HELM_IMAGE ?? "alpine/helm:3.17.3";

type HelmResult = Readonly<{ status: number; stdout: string; stderr: string }>;

function hasCommand(command: string): boolean {
  return spawnSync(command, ["version", "--short"], { encoding: "utf8" }).status === 0;
}

function helm(args: readonly string[], input?: string): HelmResult {
  const localHelm = process.env.HELM_BIN || (hasCommand("helm") ? "helm" : "");
  const command = localHelm || "docker";
  const commandArgs = localHelm
    ? [...args]
    : ["run", "--rm", "-i", "-v", `${ROOT}:/work`, "-w", "/work", HELM_IMAGE, ...args.map((arg) => (
        arg.startsWith(ROOT) ? `/work/${arg.slice(ROOT.length).replace(/^\//, "")}` : arg
      ))];
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    input,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function render(values = ""): string {
  const result = helm([
    "template", "toard", CHART,
    "--set", "secrets.authSecret=dummy",
    ...(values ? ["-f", "-"] : []),
  ], values || undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function renderFailure(values: string): HelmResult {
  return helm([
    "template", "toard", CHART,
    "--set", "secrets.authSecret=dummy",
    "-f", "-",
  ], values);
}

function documents(rendered: string): string[] {
  return rendered.split(/^---\s*$/m).map((document) => document.trim()).filter(Boolean);
}

function resource(rendered: string, kind: string, name: string): string {
  const found = documents(rendered).find((document) => (
    new RegExp(`^kind: ${kind}$`, "m").test(document)
    && new RegExp(`^  name: ${name}$`, "m").test(document)
  ));
  assert.ok(found, `${kind}/${name} 리소스가 필요합니다`);
  return found;
}

function containerBlock(resourceYaml: string, name: string): string {
  const marker = `- name: ${name}`;
  const start = resourceYaml.indexOf(marker);
  assert.notEqual(start, -1, `${name} container가 필요합니다`);
  const indent = resourceYaml.slice(resourceYaml.lastIndexOf("\n", start) + 1, start).length;
  const tail = resourceYaml.slice(start + marker.length);
  const next = tail.search(new RegExp(`\\n {${indent}}- name: `));
  return resourceYaml.slice(start, next < 0 ? undefined : start + marker.length + next);
}

function configEnvironment(configMap: string): Record<string, string> {
  return Object.fromEntries(configMap.split("\n").flatMap((line) => {
    const match = /^  ([A-Z0-9_]+): (".*")$/.exec(line);
    return match ? [[match[1]!, JSON.parse(match[2]!) as string]] : [];
  }));
}

const AWS_VALUES = `
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/toard-kms
  podLabels:
    identity.test/provider: aws
encryption:
  provider: aws-kms
  active:
    aws:
      keyArn: arn:aws:kms:ap-northeast-2:123456789012:key/00000000-0000-0000-0000-000000000000
      region: ap-northeast-2
  migration:
    provider: aws-kms
    aws:
      keyArn: arn:aws:kms:ap-northeast-2:123456789012:key/11111111-1111-1111-1111-111111111111
      region: ap-northeast-2
  workloadIdentity:
    aws:
      roleArn: arn:aws:iam::123456789012:role/toard-kms
      roleSessionName: toard
      webIdentityTokenFile: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
  cost:
    per10000Usd: "0.03"
    monthlyKeyUsd: "1"
  secretMounts:
    - name: kms-files
      secretName: toard-kms-files
      mountPath: /run/toard-secrets
      items:
        - key: token
          path: token
contentAdmin:
  enabled: true
  command: ["encryption", "status"]
`;

test("실제 Helm renderer를 사용한다", () => {
  const version = helm(["version", "--short"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /v3\./);
});

test("default chart에는 content-admin과 encryption ConfigMap이 없다", () => {
  const rendered = render();
  assert.doesNotMatch(rendered, /kind: Job[\s\S]*toard-content-admin/);
  assert.doesNotMatch(rendered, /name: toard-encryption-config/);
});

test("workload identity와 KMS 설정은 app/content-admin에만 연결된다", () => {
  const rendered = render(AWS_VALUES);
  const deployment = resource(rendered, "Deployment", "toard");
  const serviceAccount = resource(rendered, "ServiceAccount", "toard");
  const admin = resource(rendered, "Job", "toard-content-admin");
  const encryptionConfig = resource(rendered, "ConfigMap", "toard-encryption-config");
  const seedRendered = render(`${AWS_VALUES}\nmigrate:\n  seedOnInstall: true\nsecrets:\n  bootstrapAdmin:\n    email: admin@example.com\n    password: test-password\n`);
  const seed = resource(seedRendered, "Job", "toard-seed");

  assert.match(serviceAccount, /eks\.amazonaws\.com\/role-arn:/);
  assert.match(deployment, /serviceAccountName: toard/);
  assert.match(deployment, /identity\.test\/provider: aws/);
  assert.match(admin, /serviceAccountName: toard/);
  assert.match(admin, /identity\.test\/provider: aws/);
  assert.match(encryptionConfig, /TOARD_KEY_ACTIVE_PROVIDER: "aws-kms"/);
  assert.match(encryptionConfig, /TOARD_KEY_MIGRATION_PROVIDER: "aws-kms"/);
  assert.match(encryptionConfig, /AWS_ROLE_ARN:/);
  assert.match(encryptionConfig, /TOARD_KEY_COST_PER_10000_USD: "0\.03"/);

  const wait = containerBlock(deployment, "wait-for-postgres");
  const migrate = containerBlock(deployment, "migrate");
  assert.doesNotMatch(wait, /encryption-config|TOARD_KEY_|AWS_ROLE_ARN|volumeMounts:/);
  assert.doesNotMatch(migrate, /encryption-config|TOARD_KEY_|AWS_ROLE_ARN|volumeMounts:/);
  assert.doesNotMatch(seed, /encryption-config|TOARD_KEY_|AWS_ROLE_ARN|kms-files|serviceAccountName:/);
});

test("secret file은 app/content-admin에 read-only로만 mount되고 DB Secret 전체를 admin에 주입하지 않는다", () => {
  const rendered = render(AWS_VALUES);
  const deployment = resource(rendered, "Deployment", "toard");
  const admin = resource(rendered, "Job", "toard-content-admin");
  const app = containerBlock(deployment, "app");
  const migrate = containerBlock(deployment, "migrate");

  for (const block of [app, admin]) {
    assert.match(block, /mountPath: \/run\/toard-secrets/);
    assert.match(block, /readOnly: true/);
  }
  assert.match(deployment, /secretName: toard-kms-files/);
  assert.match(admin, /secretName: toard-kms-files/);
  for (const workload of [deployment, admin]) {
    assert.match(workload, /items:\s*\n\s*- key: token\s*\n\s*path: token/);
  }
  assert.doesNotMatch(migrate, /kms-files|\/run\/toard-secrets/);
  assert.match(admin, /name: DATABASE_URL[\s\S]*secretKeyRef:[\s\S]*key: DATABASE_URL/);
  assert.doesNotMatch(admin, /envFrom:[\s\S]*secretRef:/);
  assert.doesNotMatch(admin, /AUTH_SECRET|BOOTSTRAP_ADMIN|AUTH_GITHUB|AUTH_GOOGLE/);
});

test("content-admin은 명시적 one-shot Job이며 hook이 아니다", () => {
  const admin = resource(render(AWS_VALUES), "Job", "toard-content-admin");
  assert.match(admin, /restartPolicy: Never/);
  assert.match(admin, /backoffLimit: 1/);
  assert.match(admin, /args:\s*\n\s*- encryption\s*\n\s*- status/);
  assert.doesNotMatch(admin, /^\s*command:/m);
  assert.doesNotMatch(admin, /helm\.sh\/hook/);
});

const PROVIDERS: ReadonlyArray<Readonly<{ name: string; values: string; expected: readonly string[] }>> = [
  {
    name: "aws-kms",
    values: AWS_VALUES,
    expected: ["TOARD_KEY_ACTIVE_AWS_KEY_ARN", "TOARD_KEY_MIGRATION_AWS_KEY_ARN", "AWS_REGION"],
  },
  {
    name: "gcp-kms",
    values: `
encryption:
  provider: gcp-kms
  active:
    gcp:
      keyName: projects/example/locations/asia-northeast3/keyRings/toard/cryptoKeys/active
      apiEndpoint: cloudkms.googleapis.com
  migration:
    provider: gcp-kms
    gcp:
      keyName: projects/example/locations/asia-northeast3/keyRings/toard/cryptoKeys/next
  workloadIdentity:
    gcp:
      applicationCredentials: /run/toard-secrets/gcp.json
`,
    expected: ["TOARD_KEY_ACTIVE_GCP_KEY_NAME", "TOARD_KEY_ACTIVE_GCP_API_ENDPOINT", "TOARD_KEY_MIGRATION_GCP_KEY_NAME", "GOOGLE_APPLICATION_CREDENTIALS"],
  },
  {
    name: "azure-key-vault",
    values: `
serviceAccount:
  annotations:
    azure.workload.identity/client-id: 00000000-0000-0000-0000-000000000000
  podLabels:
    azure.workload.identity/use: "true"
encryption:
  provider: azure-key-vault
  active:
    azure:
      keyId: https://example.vault.azure.net/keys/toard-active/00000000000000000000000000000000
      credentialMode: workload-identity
  migration:
    provider: azure-key-vault
    azure:
      keyId: https://example.vault.azure.net/keys/toard-next/11111111111111111111111111111111
      credentialMode: workload-identity
  workloadIdentity:
    azure:
      clientId: 00000000-0000-0000-0000-000000000000
      tenantId: 11111111-1111-1111-1111-111111111111
      federatedTokenFile: /var/run/secrets/azure/tokens/azure-identity-token
`,
    expected: ["TOARD_KEY_ACTIVE_AZURE_KEY_ID", "TOARD_KEY_MIGRATION_AZURE_KEY_ID", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_FEDERATED_TOKEN_FILE"],
  },
  ...(["vault-transit", "openbao-transit"] as const).map((name) => ({
    name,
    values: `
encryption:
  provider: ${name}
  active:
    ${name === "vault-transit" ? "vault" : "openbao"}:
      address: https://${name === "vault-transit" ? "vault" : "openbao"}.example.com:8200
      mount: transit
      keyName: active
      authMethod: kubernetes
      kubernetesRole: toard
      kubernetesJwtFile: /var/run/secrets/kubernetes.io/serviceaccount/token
  migration:
    provider: ${name}
    ${name === "vault-transit" ? "vault" : "openbao"}:
      address: https://${name === "vault-transit" ? "vault" : "openbao"}.example.com:8200
      mount: transit
      keyName: next
      authMethod: token-file
      tokenFile: /run/toard-secrets/migration-token
`,
    expected: ["TOARD_KEY_ACTIVE_TRANSIT_ADDRESS", "TOARD_KEY_ACTIVE_TRANSIT_KUBERNETES_ROLE", "TOARD_KEY_MIGRATION_TRANSIT_TOKEN_FILE"],
  })),
  {
    name: "local",
    values: `
encryption:
  provider: local
  active:
    local:
      kekFile: /run/toard-secrets/active-kek
  migration:
    provider: local
    local:
      kekFile: /run/toard-secrets/next-kek
`,
    expected: ["TOARD_KEY_ACTIVE_LOCAL_KEK_FILE", "TOARD_KEY_MIGRATION_LOCAL_KEK_FILE"],
  },
];

for (const fixture of PROVIDERS) {
  test(`${fixture.name} active/migration 환경변수를 정확히 렌더한다`, () => {
    const config = resource(render(fixture.values), "ConfigMap", "toard-encryption-config");
    assert.match(config, new RegExp(`TOARD_KEY_ACTIVE_PROVIDER: "${fixture.name}"`));
    assert.match(config, new RegExp(`TOARD_KEY_MIGRATION_PROVIDER: "${fixture.name}"`));
    for (const variable of fixture.expected) assert.match(config, new RegExp(`${variable}:`));
    assert.doesNotMatch(config, /ACCESS_KEY|CLIENT_SECRET|PRIVATE_KEY|PASSWORD/);
    const parsed = loadKeyManagementConfig({ NODE_ENV: "production", ...configEnvironment(config) });
    assert.equal(parsed.active.provider, fixture.name);
    assert.equal(parsed.migration?.provider, fixture.name);
  });
}

test("existingSecret와 외부 DB에서도 content-admin은 DATABASE_URL key만 참조한다", () => {
  const values = `${AWS_VALUES}
postgres:
  enabled: false
secrets:
  existingSecret: production-secrets
`;
  const rendered = render(values);
  const admin = resource(rendered, "Job", "toard-content-admin");
  assert.match(admin, /name: production-secrets[\s\S]*key: DATABASE_URL/);
  assert.doesNotMatch(admin, /envFrom:[\s\S]*secretRef:/);
  assert.doesNotMatch(rendered, /kind: StatefulSet/);
});

test("serviceAccount create=false와 name override를 지원한다", () => {
  const rendered = render(`${AWS_VALUES}\nserviceAccount:\n  create: false\n  name: kms-existing\n  annotations: {}\n  podLabels: {}\n`);
  assert.doesNotMatch(rendered, /^kind: ServiceAccount$/m);
  assert.match(resource(rendered, "Deployment", "toard"), /serviceAccountName: kms-existing/);
  assert.match(resource(rendered, "Job", "toard-content-admin"), /serviceAccountName: kms-existing/);
});

test("podLabels가 chart 소유 selector label을 덮어쓰지 못한다", () => {
  const result = renderFailure(`
serviceAccount:
  podLabels:
    app.kubernetes.io/component: attacker
`);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stderr}\n${result.stdout}`, /podLabels.*reserved|component/i);
});

const INVALID_SECRET_MOUNT_BASE = `
encryption:
  provider: aws-kms
  active:
    aws:
      keyArn: arn:aws:kms:ap-northeast-2:123456789012:key/00000000-0000-0000-0000-000000000000
      region: ap-northeast-2
  secretMounts:
`;

for (const [name, invalid] of Object.entries({
  "inline value": `${INVALID_SECRET_MOUNT_BASE}    - name: bad\n      secretName: kms\n      mountPath: /run/kms\n      items: [{key: token, path: token}]\n      value: plaintext\n`,
  hostPath: `${INVALID_SECRET_MOUNT_BASE}    - name: bad\n      secretName: kms\n      mountPath: /run/kms\n      items: [{key: token, path: token}]\n      hostPath: /tmp/kms\n`,
  "relative mountPath": `${INVALID_SECRET_MOUNT_BASE}    - name: bad\n      secretName: kms\n      mountPath: run/kms\n      items: [{key: token, path: token}]\n`,
  "duplicate name": `${INVALID_SECRET_MOUNT_BASE}    - {name: duplicate, secretName: one, mountPath: /run/one, items: [{key: a, path: a}]}
    - {name: duplicate, secretName: two, mountPath: /run/two, items: [{key: b, path: b}]}
`,
})) {
  test(`잘못된 secretMounts를 fail-fast 한다: ${name}`, () => {
    const result = renderFailure(invalid);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stderr}\n${result.stdout}`, /secretMounts|Additional property|mountPath|duplicate/i);
  });
}

test("chart lint도 실제 Helm으로 통과한다", () => {
  const result = helm(["lint", CHART, "--set", "secrets.authSecret=dummy"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
