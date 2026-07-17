import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadKeyManagementConfig } from "../apps/web/lib/key-management/config";
import { LATEST_SCHEMA_VERSION } from "../packages/core/src/deployment-release";

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

function lintValues(values: string): void {
  const result = helm([
    "lint", CHART, "--strict",
    "--set", "secrets.authSecret=dummy",
    "-f", "-",
  ], values);
  assert.equal(result.status, 0, result.stderr || result.stdout);
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

function migrationJob(rendered: string): string {
  const found = documents(rendered).find((document) => (
    /^kind: Job$/m.test(document)
    && /app\.kubernetes\.io\/component: migration/m.test(document)
  ));
  assert.ok(found, "migration Job 리소스가 필요합니다");
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

function listNamesInSection(resourceYaml: string, section: "initContainers" | "containers"): string[] {
  const lines = resourceYaml.split("\n");
  const sectionIndex = lines.findIndex((line) => line.trim() === `${section}:`);
  if (sectionIndex < 0) return [];
  const sectionIndent = lines[sectionIndex]!.search(/\S/);
  const names: string[] = [];
  for (const line of lines.slice(sectionIndex + 1)) {
    const indent = line.search(/\S/);
    if (indent >= 0 && indent <= sectionIndent) break;
    const match = new RegExp(`^ {${sectionIndent + 2}}- name: (.+)$`).exec(line);
    if (match) names.push(match[1]!);
  }
  return names;
}

function serviceAccountName(workload: string): string {
  const match = /^\s+serviceAccountName: (\S+)$/m.exec(workload);
  assert.ok(match, "Pod workload에는 serviceAccountName이 필요합니다");
  return match[1]!;
}

function resourceName(resourceYaml: string): string {
  const match = /^  name: (\S+)$/m.exec(resourceYaml);
  assert.ok(match, "resource name이 필요합니다");
  return match[1]!;
}

function environmentNames(containerYaml: string): string[] {
  return [...containerYaml.matchAll(/^\s+- name: ([A-Z][A-Z0-9_]*)$/gm)]
    .map((match) => match[1]!)
    .sort();
}

function validator(args: readonly string[]): HelmResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, "scripts/validate-helm-encryption.ts"), ...args],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
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
  const migration = migrationJob(rendered);
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

  assert.deepEqual(listNamesInSection(deployment, "initContainers"), []);
  assert.doesNotMatch(migration, /encryption-config|TOARD_KEY_|AWS_ROLE_ARN|kms-files/);
  assert.doesNotMatch(seed, /encryption-config|TOARD_KEY_|AWS_ROLE_ARN|kms-files/);
});

test("KMS Pod에는 app/content-admin만 있고 migration/seed는 별도 non-KMS SA를 사용한다", () => {
  const rendered = render(`${AWS_VALUES}\nmigrate:\n  seedOnInstall: true\nsecrets:\n  bootstrapAdmin:\n    email: admin@example.com\n    password: test-password\n`);
  const workloads = documents(rendered).filter((document) => /^(?:kind: Deployment|kind: Job)$/m.test(document));
  const app = resource(rendered, "Deployment", "toard");
  const migration = migrationJob(rendered);
  const seed = resource(rendered, "Job", "toard-seed");
  const admin = resource(rendered, "Job", "toard-content-admin");
  const migrationSa = resource(rendered, "ServiceAccount", "toard-migration");

  assert.deepEqual(listNamesInSection(app, "initContainers"), []);
  assert.deepEqual(listNamesInSection(app, "containers"), ["app"]);
  assert.deepEqual(listNamesInSection(admin, "containers"), ["content-admin"]);
  assert.deepEqual(listNamesInSection(migration, "initContainers"), ["wait-for-postgres"]);
  assert.deepEqual(listNamesInSection(migration, "containers"), ["migrate"]);
  assert.deepEqual(listNamesInSection(seed, "initContainers"), ["wait-for-postgres"]);
  assert.deepEqual(listNamesInSection(seed, "containers"), ["seed"]);
  assert.deepEqual(environmentNames(containerBlock(migration, "migrate")), [
    "DATABASE_URL",
    "TOARD_DEPLOYMENT_ID",
    "TOARD_EXPECTED_SCHEMA_VERSION",
    "TOARD_RELEASE_COMPLETION_ID",
  ]);
  assert.deepEqual(environmentNames(containerBlock(seed, "seed")), [
    "BOOTSTRAP_ADMIN_EMAIL",
    "BOOTSTRAP_ADMIN_PASSWORD",
    "DATABASE_URL",
  ]);

  assert.match(migrationSa, /automountServiceAccountToken: false/);
  assert.doesNotMatch(migrationSa, /eks\.amazonaws|identity\.test|azure\.workload|iam\.gke/);
  for (const workload of workloads) {
    const names = [
      ...listNamesInSection(workload, "initContainers"),
      ...listNamesInSection(workload, "containers"),
    ];
    const account = serviceAccountName(workload);
    if (names.some((name) => ["wait-for-postgres", "migrate", "seed"].includes(name))) {
      assert.equal(account, "toard-migration", `${resourceName(workload)} operational SA`);
      assert.match(workload, /automountServiceAccountToken: false/);
      assert.doesNotMatch(workload, /identity\.test|encryption-config|TOARD_KEY_|AWS_ROLE_ARN|kms-files/);
    }
    if (account === "toard") {
      assert.ok(names.every((name) => ["app", "content-admin"].includes(name)), names.join(","));
    }
  }
});

test("migration Job은 completion ID별 one-shot이며 최소 release env만 받고 readiness가 실패를 traffic에서 격리한다", () => {
  const rendered = render(AWS_VALUES);
  const migration = migrationJob(rendered);
  const deployment = resource(rendered, "Deployment", "toard");
  const migrationTemplate = [
    readFileSync(join(CHART, "templates/migration-job.yaml"), "utf8"),
    readFileSync(join(CHART, "templates/_helpers.tpl"), "utf8"),
  ].join("\n");
  const readyRoute = [
    readFileSync(join(ROOT, "apps/web/app/api/ready/route.ts"), "utf8"),
    readFileSync(join(ROOT, "apps/web/lib/legacy-content-readiness.ts"), "utf8"),
  ].join("\n");

  assert.match(migrationTemplate, /\.Release\.Revision/);
  assert.match(migration, /ttlSecondsAfterFinished: 86400/);
  assert.match(migration, /backoffLimit: 4/);
  assert.match(migration, /restartPolicy: Never/);
  assert.doesNotMatch(migration, /helm\.sh\/hook/);
  assert.match(migration, /until pg_isready/);
  assert.match(migration, /name: DATABASE_URL[\s\S]*secretKeyRef:[\s\S]*key: DATABASE_URL/);
  assert.doesNotMatch(migration, /envFrom:|AUTH_SECRET|AUTH_GITHUB|AUTH_GOOGLE|BOOTSTRAP_ADMIN|encryption-config/);
  assert.match(deployment, /maxUnavailable: 0/);
  assert.match(deployment, /readinessProbe:[\s\S]*path: \/api\/ready/);
  assert.match(readyRoute, /content_legacy_retirement|assertLegacyContentKeyReady/);
  assert.match(readyRoute, /status: 503/);

  const external = render(`${AWS_VALUES}\npostgres:\n  enabled: false\nsecrets:\n  existingSecret: external-db\n`);
  const externalMigration = migrationJob(external);
  assert.deepEqual(listNamesInSection(externalMigration, "initContainers"), []);
  assert.match(externalMigration, /backoffLimit: 4/);
  assert.match(externalMigration, /name: external-db[\s\S]*key: DATABASE_URL/);
});

test("동일 desired state는 random Secret 없이 byte-for-byte 동일 completion manifest를 만든다", () => {
  const rendered = render(AWS_VALUES);
  const rerendered = render(AWS_VALUES);
  const deployment = resource(rendered, "Deployment", "toard");
  const completionId = /toard\.dev\/release-completion-id: "([0-9a-f]{64})"/.exec(deployment)?.[1];
  assert.ok(completionId);
  const migration = resource(rendered, "Job", `toard-migrate-${completionId.slice(0, 20)}`);
  const app = containerBlock(deployment, "app");
  const migrate = containerBlock(migration, "migrate");

  assert.equal(rerendered, rendered);
  assert.doesNotMatch(rendered, /release-readiness|TOARD_RELEASE_TOKEN|randAlphaNum/);
  const completionSources = [
    "templates/_helpers.tpl",
    "templates/deployment.yaml",
    "templates/migration-job.yaml",
  ].map((path) => readFileSync(join(CHART, path), "utf8")).join("\n");
  assert.doesNotMatch(completionSources, /randAlphaNum|releaseReadinessSecret|TOARD_RELEASE_TOKEN/);
  for (const workload of [app, migrate]) {
    assert.match(workload, /name: TOARD_DEPLOYMENT_ID\s+value: "default\/toard"/);
    assert.match(workload, new RegExp(
      `name: TOARD_EXPECTED_SCHEMA_VERSION\\s+value: "${LATEST_SCHEMA_VERSION}"`,
    ));
    assert.match(workload, new RegExp(
      `name: TOARD_RELEASE_COMPLETION_ID\\s+value: "${completionId}"`,
    ));
    assert.doesNotMatch(workload, /secretKeyRef:[\s\S]*release-readiness|TOARD_RELEASE_REVISION/);
  }
  assert.match(
    migrate,
    /pnpm migrate && pnpm seed && pnpm mark:deployment-release/,
  );
  assert.doesNotMatch(deployment, /pnpm migrate|pnpm seed|mark:deployment-release/);
});

test("GitOps releaseId와 핵심 Job 입력 변경은 새 completion ID와 immutable Job을 만든다", () => {
  const base = render(`${AWS_VALUES}\nmigrate:\n  releaseId: git-abc123\n`);
  const same = render(`${AWS_VALUES}\nmigrate:\n  releaseId: git-abc123\n`);
  const releaseChanged = render(`${AWS_VALUES}\nmigrate:\n  releaseId: git-def456\n`);
  const imageChanged = render(`${AWS_VALUES}\nimage:\n  migrate:\n    repository: registry.example/toard-migrate\n    tag: sha-222\n    pullPolicy: IfNotPresent\nmigrate:\n  releaseId: git-abc123\n`);
  const databaseChanged = render(`${AWS_VALUES}\nmigrate:\n  releaseId: git-abc123\n  databaseSecret:\n    name: owner-v2\n    key: DATABASE_URL\n`);
  const podSpecChanged = render(`${AWS_VALUES}\nresources:\n  requests:\n    cpu: 250m\nmigrate:\n  releaseId: git-abc123\n`);
  const id = (manifest: string) => {
    const match = /toard\.dev\/release-completion-id: "([0-9a-f]{64})"/.exec(manifest);
    assert.ok(match);
    return match[1]!;
  };

  assert.equal(base, same);
  assert.notEqual(id(base), id(releaseChanged));
  assert.notEqual(id(base), id(imageChanged));
  assert.notEqual(id(base), id(databaseChanged));
  assert.notEqual(id(base), id(podSpecChanged));
  for (const manifest of [base, releaseChanged, imageChanged, databaseChanged, podSpecChanged]) {
    assert.match(manifest, new RegExp(`name: toard-migrate-${id(manifest).slice(0, 20)}`));
  }
  const helpers = readFileSync(join(CHART, "templates/_helpers.tpl"), "utf8");
  assert.match(helpers, /printf "helm-revision:%d" \.Release\.Revision/);
  assert.match(helpers, /expectedSchemaVersion/);
  assert.match(helpers, /\$completionSpec := dict/);
  assert.match(helpers, /\$completionSpec \| mustToJson \| sha256sum/);
  assert.doesNotMatch(helpers, /printf "toard-release-completion-v1|job_spec=/);
});

test("동일 release ID에서도 encryption ConfigMap 변경은 secret-free pod-template checksum rollout을 만든다", () => {
  const base = render(`${AWS_VALUES}\nmigrate:\n  releaseId: git-fixed\n`);
  const keyRefChanged = render(`${AWS_VALUES.replace("00000000-0000-0000-0000-000000000000", "99999999-9999-9999-9999-999999999999")}\nmigrate:\n  releaseId: git-fixed\n`);
  const migrationChanged = render(`${AWS_VALUES.replace("11111111-1111-1111-1111-111111111111", "88888888-8888-8888-8888-888888888888")}\nmigrate:\n  releaseId: git-fixed\n`);
  const costChanged = render(`${AWS_VALUES.replace('per10000Usd: "0.03"', 'per10000Usd: "0.04"')}\nmigrate:\n  releaseId: git-fixed\n`);
  const checksum = (manifest: string) => {
    const deployment = resource(manifest, "Deployment", "toard");
    const value = /checksum\/toard-encryption-config: "([0-9a-f]{64})"/.exec(deployment)?.[1];
    assert.ok(value, deployment);
    const annotations = deployment.slice(
      deployment.indexOf("annotations:"),
      deployment.indexOf("labels:", deployment.indexOf("annotations:")),
    );
    assert.doesNotMatch(annotations, /00000000-0000-0000-0000-000000000000|11111111-1111-1111-1111-111111111111|kms-files|token/);
    return value;
  };

  const baseChecksum = checksum(base);
  assert.notEqual(baseChecksum, checksum(keyRefChanged));
  assert.notEqual(baseChecksum, checksum(migrationChanged));
  assert.notEqual(baseChecksum, checksum(costChanged));
  assert.equal(
    /toard\.dev\/release-completion-id: "([0-9a-f]{64})"/.exec(base)?.[1],
    /toard\.dev\/release-completion-id: "([0-9a-f]{64})"/.exec(keyRefChanged)?.[1],
  );
});

test("schema-valid delimiter collision 쌍은 서로 다른 completion ID와 Job 이름을 만든다", () => {
  const postgresA = `
postgres:
  image: postgres:16-alpine
  auth:
    user: toard
migrate:
  releaseId: git-canonical
`;
  const postgresB = `
postgres:
  image: postgres
  auth:
    user: 16-alpine:toard
migrate:
  releaseId: git-canonical
`;
  const migrateImageA = `
image:
  migrate:
    repository: registry.example/toard-migrate:part
    tag: v1
    pullPolicy: IfNotPresent
migrate:
  releaseId: git-canonical
`;
  const migrateImageB = `
image:
  migrate:
    repository: registry.example/toard-migrate
    tag: part:v1
    pullPolicy: IfNotPresent
migrate:
  releaseId: git-canonical
`;
  const databaseSecretA = `
migrate:
  releaseId: git-canonical
  databaseSecret:
    name: owner
    key: v2.KEY
`;
  const databaseSecretB = `
migrate:
  releaseId: git-canonical
  databaseSecret:
    name: owner.v2
    key: KEY
`;
  const completion = (values: string) => {
    lintValues(values);
    const rendered = render(values);
    const id = /toard\.dev\/release-completion-id: "([0-9a-f]{64})"/.exec(rendered)?.[1];
    assert.ok(id);
    assert.match(rendered, new RegExp(`name: toard-migrate-${id.slice(0, 20)}`));
    return id;
  };

  assert.equal(
    ["postgres:16-alpine", "toard"].join(":"),
    ["postgres", "16-alpine:toard"].join(":"),
  );
  assert.equal(
    ["registry.example/toard-migrate:part", "v1"].join(":"),
    ["registry.example/toard-migrate", "part:v1"].join(":"),
  );
  assert.equal(
    ["owner", "v2.KEY"].join("."),
    ["owner.v2", "KEY"].join("."),
  );
  assert.notEqual(completion(postgresA), completion(postgresB));
  assert.notEqual(completion(migrateImageA), completion(migrateImageB));
  assert.notEqual(completion(databaseSecretA), completion(databaseSecretB));
});

test("migrate.releaseId 기본값은 실제 Helm revision 1과 2를 서로 다른 completion ID로 만든다", () => {
  const parent = join(ROOT, "node_modules/.cache/toard-helm-test");
  mkdirSync(parent, { recursive: true });
  const chart = mkdtempSync(join(parent, "revision-"));
  cpSync(CHART, chart, { recursive: true });
  writeFileSync(join(chart, "templates/revision-fixture.yaml"), `
{{- $release1 := dict "Name" .Release.Name "Namespace" .Release.Namespace "Revision" 1 -}}
{{- $release2 := dict "Name" .Release.Name "Namespace" .Release.Namespace "Revision" 2 -}}
{{- $context1 := dict "Values" .Values "Chart" .Chart "Release" $release1 -}}
{{- $context2 := dict "Values" .Values "Chart" .Chart "Release" $release2 -}}
apiVersion: v1
kind: ConfigMap
metadata:
  name: revision-fixture
data:
  revision-1: {{ include "toard.releaseCompletionId" $context1 | quote }}
  revision-2: {{ include "toard.releaseCompletionId" $context2 | quote }}
`);
  try {
    const result = helm([
      "template", "toard", chart,
      "--set", "secrets.authSecret=dummy",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const revision1 = /revision-1: "([0-9a-f]{64})"/.exec(result.stdout)?.[1];
    const revision2 = /revision-2: "([0-9a-f]{64})"/.exec(result.stdout)?.[1];
    assert.ok(revision1);
    assert.ok(revision2);
    assert.notEqual(revision1, revision2);
  } finally {
    rmSync(chart, { recursive: true, force: true });
  }
});

test("malformed GitOps releaseId를 fail-fast 한다", () => {
  for (const releaseId of ["bad/id", "space id", "", "a".repeat(129)]) {
    if (releaseId === "") continue;
    const result = renderFailure(`migrate:\n  releaseId: ${JSON.stringify(releaseId)}\n`);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /releaseId|pattern|length/i);
  }
});

test("Helm notes는 install/upgrade migration 대기와 readiness 의미를 문서화한다", () => {
  const notes = readFileSync(join(CHART, "templates/NOTES.txt"), "utf8");
  const deployGuide = readFileSync(join(ROOT, "docs/DEPLOY.md"), "utf8");
  assert.match(notes, /--wait-for-jobs/);
  assert.match(notes, /migrate\.releaseId/);
  assert.match(notes, /Argo|Flux|GitOps/);
  assert.match(notes, /readiness|503/);
  assert.match(notes, /maxUnavailable=0/);
  assert.match(notes, /marker|completion/);
  assert.match(deployGuide, /migrate\.releaseId/);
  assert.match(deployGuide, /Argo CD|Flux|GitOps/);
  assert.match(deployGuide, /--wait --wait-for-jobs/);
  assert.match(deployGuide, /\/api\/ready.*503/s);
  assert.match(deployGuide, /migrate.*seed.*marker/is);
  assert.match(deployGuide, /mutable tag|가변 태그/i);
  assert.match(deployGuide, /force.*rerun|강제 재실행/i);
  assert.match(deployGuide, /rollback|롤백/i);
  assert.match(deployGuide, /forward-only/i);
  assert.doesNotMatch(notes, /release token|correlation nonce|dedicated Kubernetes Secret/i);
});

test("standalone Helm validator는 lint와 template을 모두 실행한다", () => {
  const result = validator(["--set-string", "secrets.authSecret=dummy"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /helm lint.*PASS/);
  assert.match(result.stdout, /helm template.*PASS/);
});

test("standalone Helm validator는 package script 인자 구분자를 무시한다", () => {
  const result = validator(["--", "--set-string", "secrets.authSecret=dummy"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /helm lint.*PASS/);
  assert.match(result.stdout, /helm template.*PASS/);
});

for (const [name, mountPath] of [["duplicate", "/run/one"], ["traversal", "/run/../escape"]] as const) {
  test(`standalone validator가 template-time ${name} mount를 거부한다`, () => {
    const args = [
      "--set-string", "secrets.authSecret=dummy",
      "--set-string", "encryption.provider=aws-kms",
      "--set-string", "encryption.active.aws.keyArn=arn:aws:kms:ap-northeast-2:123456789012:key/00000000-0000-0000-0000-000000000000",
      "--set-string", "encryption.active.aws.region=ap-northeast-2",
      "--set-string", "encryption.secretMounts[0].name=duplicate",
      "--set-string", "encryption.secretMounts[0].secretName=one",
      "--set-string", `encryption.secretMounts[0].mountPath=${mountPath}`,
      "--set-string", "encryption.secretMounts[0].items[0].key=a",
      "--set-string", "encryption.secretMounts[0].items[0].path=a",
    ];
    if (name === "duplicate") {
      args.push(
        "--set-string", "encryption.secretMounts[1].name=duplicate",
        "--set-string", "encryption.secretMounts[1].secretName=two",
        "--set-string", "encryption.secretMounts[1].mountPath=/run/two",
        "--set-string", "encryption.secretMounts[1].items[0].key=b",
        "--set-string", "encryption.secretMounts[1].items[0].path=b",
      );
    }
    const result = validator(args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /helm (?:template|lint --strict).*FAIL|duplicate|normalized|mountPath/i);
    if (name === "duplicate") assert.match(result.stdout, /helm lint --strict: PASS/);
  });
}

test("secret file은 app/content-admin에 read-only로만 mount되고 DB Secret 전체를 admin에 주입하지 않는다", () => {
  const rendered = render(AWS_VALUES);
  const deployment = resource(rendered, "Deployment", "toard");
  const admin = resource(rendered, "Job", "toard-content-admin");
  const migration = migrationJob(rendered);
  const app = containerBlock(deployment, "app");
  const migrate = containerBlock(migration, "migrate");

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
  test(`${fixture.name} values를 lint하고 active/migration 환경변수를 정확히 렌더한다`, () => {
    const lint = helm([
      "lint", "--strict", CHART,
      "--set", "secrets.authSecret=dummy",
      "-f", "-",
    ], fixture.values);
    assert.equal(lint.status, 0, lint.stderr || lint.stdout);
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

test("migration/seed는 app DB Secret과 분리한 owner DATABASE_URL key를 지원한다", () => {
  const rendered = render(`
postgres:
  enabled: false
secrets:
  existingSecret: app-runtime-db
  bootstrapAdmin:
    email: admin@example.com
    password: test-password
migrate:
  seedOnInstall: true
  databaseSecret:
    name: migration-owner-db
    key: OWNER_DATABASE_URL
`);
  const deployment = resource(rendered, "Deployment", "toard");
  const migration = migrationJob(rendered);
  const seed = resource(rendered, "Job", "toard-seed");

  assert.match(deployment, /secretRef:\s*\n\s*name: app-runtime-db/);
  for (const workload of [migration, seed]) {
    assert.match(workload, /name: DATABASE_URL[\s\S]*name: migration-owner-db[\s\S]*key: OWNER_DATABASE_URL/);
  }
  assert.doesNotMatch(migration, /name: app-runtime-db/);
});

test("KMS/migration serviceAccount create=false와 name override를 지원한다", () => {
  const rendered = render(`${AWS_VALUES}\nserviceAccount:\n  create: false\n  name: kms-existing\n  annotations: {}\n  podLabels: {}\nmigrate:\n  serviceAccount:\n    create: false\n    name: migration-existing\n`);
  assert.doesNotMatch(rendered, /^kind: ServiceAccount$/m);
  assert.match(resource(rendered, "Deployment", "toard"), /serviceAccountName: kms-existing/);
  assert.match(resource(rendered, "Job", "toard-content-admin"), /serviceAccountName: kms-existing/);
  assert.match(migrationJob(rendered), /serviceAccountName: migration-existing/);
});

test("KMS와 migration ServiceAccount 이름은 같을 수 없다", () => {
  const result = renderFailure(`
serviceAccount:
  create: false
  name: shared
migrate:
  serviceAccount:
    create: false
    name: shared
`);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stderr}\n${result.stdout}`, /ServiceAccount.*different|같을 수 없다/i);
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
