import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("..", import.meta.url);
const COMPOSE_ENV = [
  "TOARD_KEY_ACTIVE_PROVIDER",
  "TOARD_KEY_MIGRATION_PROVIDER",
  "TOARD_USER_KEY_CACHE_TTL_SECONDS",
  "TOARD_CONTENT_KEK_B64",
  "TOARD_KEY_COST_PER_10000_USD",
  "TOARD_KEY_MONTHLY_KEY_COST_USD",
  ...["ACTIVE", "MIGRATION"].flatMap((slot) => [
    `TOARD_KEY_${slot}_LOCAL_KEK_FILE`,
    `TOARD_KEY_${slot}_AWS_KEY_ARN`,
    `TOARD_KEY_${slot}_AWS_REGION`,
    `TOARD_KEY_${slot}_AWS_ENDPOINT`,
    `TOARD_KEY_${slot}_GCP_KEY_NAME`,
    `TOARD_KEY_${slot}_GCP_API_ENDPOINT`,
    `TOARD_KEY_${slot}_AZURE_KEY_ID`,
    `TOARD_KEY_${slot}_AZURE_CREDENTIAL_MODE`,
    `TOARD_KEY_${slot}_AZURE_MANAGED_IDENTITY_CLIENT_ID`,
    `TOARD_KEY_${slot}_TRANSIT_ADDRESS`,
    `TOARD_KEY_${slot}_TRANSIT_MOUNT`,
    `TOARD_KEY_${slot}_TRANSIT_KEY_NAME`,
    `TOARD_KEY_${slot}_TRANSIT_AUTH_METHOD`,
    `TOARD_KEY_${slot}_TRANSIT_NAMESPACE`,
    `TOARD_KEY_${slot}_TRANSIT_TOKEN_FILE`,
    `TOARD_KEY_${slot}_TRANSIT_KUBERNETES_ROLE`,
    `TOARD_KEY_${slot}_TRANSIT_KUBERNETES_JWT_FILE`,
    `TOARD_KEY_${slot}_TRANSIT_APPROLE_ROLE_ID_FILE`,
    `TOARD_KEY_${slot}_TRANSIT_APPROLE_SECRET_ID_FILE`,
  ]),
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_SDK_LOAD_CONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_FEDERATED_TOKEN_FILE",
] as const;

const FORBIDDEN_INLINE_CREDENTIALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS_JSON",
  "TOARD_KEY_ACTIVE_TRANSIT_TOKEN",
  "TOARD_KEY_MIGRATION_TRANSIT_TOKEN",
] as const;

type ComposeService = {
  build?: { target?: string };
  command?: string[];
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
  image?: string;
  ports?: unknown[];
  profiles?: string[];
  restart?: string;
  volumes?: Array<{ source?: string; target?: string; read_only?: boolean }>;
};

function composeConfig(): { services: Record<string, ComposeService> } {
  const sentinelEnv = Object.fromEntries(
    COMPOSE_ENV.map((name) => [name, `sentinel-${name.toLowerCase()}`]),
  );
  return JSON.parse(execFileSync(
    "docker",
    ["compose", "--profile", "*", "config", "--format", "json"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTH_SECRET: "dummy",
        APP_DATABASE_URL: "postgres://app-user:dummy@postgres:5432/toard",
        MIGRATION_DATABASE_URL: "postgres://migration-owner:dummy@postgres:5432/toard",
        ...sentinelEnv,
      },
    },
  )) as { services: Record<string, ComposeService> };
}

test("Compose는 app/content-admin과 migrate/seed의 DATABASE_URL을 분리한다", () => {
  const services = composeConfig().services;
  const appDatabaseUrl = "postgres://app-user:dummy@postgres:5432/toard";
  const migrationDatabaseUrl = "postgres://migration-owner:dummy@postgres:5432/toard";

  assert.equal(services.app?.environment?.DATABASE_URL, appDatabaseUrl);
  assert.equal(services["content-admin"]?.environment?.DATABASE_URL, appDatabaseUrl);
  assert.equal(services.migrate?.environment?.DATABASE_URL, migrationDatabaseUrl);
  assert.equal(services.seed?.environment?.DATABASE_URL, migrationDatabaseUrl);
});

function parseYaml(path: string): unknown {
  const ruby = [
    "require 'yaml'",
    "require 'json'",
    "document = YAML.safe_load(File.read(ARGV.fetch(0)), permitted_classes: [], permitted_symbols: [], aliases: true)",
    "puts JSON.generate(document)",
  ].join("; ");
  return JSON.parse(execFileSync(
    "ruby",
    ["-e", ruby, path],
    { cwd: ROOT, encoding: "utf8" },
  ));
}

test("Compose는 KMS 설정과 secret mount를 app/content-admin에만 제공한다", () => {
  const { services } = composeConfig();
  const permitted = new Set(["app", "content-admin"]);

  for (const serviceName of permitted) {
    const service = services[serviceName];
    assert.ok(service, `${serviceName} service가 필요합니다`);
    for (const name of COMPOSE_ENV) {
      assert.equal(
        service.environment?.[name],
        `sentinel-${name.toLowerCase()}`,
        `${serviceName}에 ${name} 전달이 필요합니다`,
      );
    }
    const secretMount = service.volumes?.find(
      (volume) => volume.target === "/run/toard-secrets",
    );
    assert.ok(secretMount, `${serviceName} secret mount가 필요합니다`);
    assert.equal(secretMount.read_only, true);
  }

  for (const [serviceName, service] of Object.entries(services)) {
    if (permitted.has(serviceName)) continue;
    for (const name of COMPOSE_ENV) {
      assert.equal(
        service.environment?.[name],
        undefined,
        `${serviceName}에 ${name}을 전달하면 안 됩니다`,
      );
    }
    assert.equal(
      service.volumes?.some((volume) => volume.target === "/run/toard-secrets") ?? false,
      false,
      `${serviceName}에 KMS secret mount를 제공하면 안 됩니다`,
    );
  }

  for (const service of Object.values(services)) {
    for (const name of FORBIDDEN_INLINE_CREDENTIALS) {
      assert.equal(service.environment?.[name], undefined, `${name}은 허용하지 않습니다`);
    }
  }
});

test("content-admin은 격리된 one-shot profile 서비스다", () => {
  const services = composeConfig().services;
  const service = services["content-admin"];
  assert.ok(service, "content-admin service가 필요합니다");
  assert.deepEqual(service.profiles, ["content-admin"]);
  assert.equal(service.build?.target, "content-admin");
  assert.match(service.image ?? "", /toard-content-admin/);
  assert.deepEqual(service.command, ["encryption", "status"]);
  assert.equal(service.restart, "no");
  assert.equal(service.depends_on?.postgres?.condition, "service_healthy");
  assert.equal(service.ports, undefined);
  assert.equal(
    service.volumes?.some((volume) => volume.source === "/var/run/docker.sock"),
    false,
  );

  const defaultServices = execFileSync(
    "docker",
    ["compose", "config", "--services"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, AUTH_SECRET: "dummy" } },
  ).trim().split("\n");
  assert.ok(!defaultServices.includes("content-admin"));

  assert.equal(services.app?.build?.target, "runner");
  assert.equal(services.migrate?.build?.target, "migrator");
  assert.equal(services.seed?.build?.target, "migrator");
  assert.equal(services.updater?.build?.target, "updater");
});

test("Dockerfile은 non-root content-admin target과 안전한 기본 명령을 제공한다", () => {
  const dockerfile = readFileSync(new URL("Dockerfile", ROOT), "utf8");
  const stage = dockerfile.split(/^FROM /m).find((section) => /^deps AS content-admin\b/m.test(section));
  assert.ok(stage, "content-admin target이 필요합니다");
  assert.match(stage, /^USER \S+/m);
  assert.match(stage, /ENV HOME=\/tmp\b/);
  assert.match(stage, /ENTRYPOINT \["pnpm", "toard-admin"\]/);
  assert.match(stage, /CMD \["encryption", "status"\]/);
  assert.doesNotMatch(stage, /COPY .*secrets/i);
});

test("Docker build context는 secret 파일을 제외하고 public env example은 유지한다", () => {
  const dockerignore = readFileSync(new URL(".dockerignore", ROOT), "utf8");
  const ignoredLines = new Set(dockerignore.split(/\r?\n/));
  for (const pattern of [
    "secrets",
    "**/secrets",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/*.secret",
    "**/*credentials*.json",
    ".superpowers/",
    ".codex/",
    "outputs/",
  ]) {
    assert.ok(ignoredLines.has(pattern), `${pattern} ignore 규칙이 필요합니다`);
  }
  assert.match(dockerignore, /^!\.env\.example$/m);
  assert.doesNotThrow(() => readFileSync(new URL("docs/examples/content-encryption.env.example", ROOT)));
});

test("env example은 각 provider의 active/migration 설정을 secret 원문 없이 제공한다", () => {
  const example = readFileSync(
    new URL("docs/examples/content-encryption.env.example", ROOT),
    "utf8",
  );
  for (const provider of [
    "aws-kms",
    "gcp-kms",
    "azure-key-vault",
    "vault-transit",
    "openbao-transit",
    "local",
  ]) {
    assert.match(example, new RegExp(`TOARD_KEY_ACTIVE_PROVIDER=${provider}`));
    assert.match(example, new RegExp(`TOARD_KEY_MIGRATION_PROVIDER=${provider}`));
  }
  for (const name of FORBIDDEN_INLINE_CREDENTIALS) {
    assert.doesNotMatch(example, new RegExp(`^#?\\s*${name}=`, "m"));
  }
  assert.doesNotMatch(example, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
  assert.match(example, /TOARD_KEY_COST_PER_10000_USD=0\.04/);
  assert.match(example, /TOARD_KEY_MONTHLY_KEY_COST_USD=1\.25/);
  assert.match(example, /두 값을.*함께/);
  assert.match(example, /active provider/);
  assert.match(example, /Azure.*Vault.*OpenBao.*local/s);
  assert.match(
    example,
    /TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE=workload-identity/,
  );
  assert.match(
    example,
    /TOARD_KEY_MIGRATION_AZURE_CREDENTIAL_MODE=workload-identity/,
  );
  assert.match(example, /docker compose config.*(?:공유|저장).*금지/s);
});

test("Compose bootstrap 문서는 app role 비밀번호를 process argv로 전달하지 않는다", () => {
  const deploy = readFileSync(new URL("docs/DEPLOY.md", ROOT), "utf8");
  const runbook = readFileSync(new URL("docs/content-encryption-runbook.md", ROOT), "utf8");
  const bootstrap = readFileSync(new URL("scripts/bootstrap-app-role.sql", ROOT), "utf8");

  assert.doesNotMatch(deploy, /-v\s+app_password=/);
  assert.doesNotMatch(bootstrap, /-v\s+app_password=/);
  assert.match(deploy, /owner-only.*0600.*psql input file/is);
  assert.match(deploy, /-f\s+\/secure\/bootstrap-app-role\.psql/);
  assert.match(runbook, /owner-only.*psql input file/is);
  assert.match(bootstrap, /owner-only.*psql input file/is);
});

test("GHCR build matrix는 4 target × 2 platform의 8개 row를 정확히 매핑한다", () => {
  const workflow = parseYaml(".github/workflows/docker-publish.yml") as {
    jobs: {
      build: { strategy: { matrix: {
        target: string[];
        platform: string[];
        include: Array<Record<string, string>>;
      } } };
      merge: { strategy: { matrix: { include: Array<Record<string, string>> } } };
    };
  };
  const expected = new Map([
    ["runner", "toard"],
    ["migrator", "toard-migrate"],
    ["updater", "toard-updater"],
    ["content-admin", "toard-content-admin"],
  ]);
  assert.deepEqual(new Set(workflow.jobs.build.strategy.matrix.target), new Set(expected.keys()));

  const platforms = new Map([
    ["linux/amd64", { runner: "ubuntu-latest", arch: "amd64" }],
    ["linux/arm64", { runner: "ubuntu-24.04-arm", arch: "arm64" }],
  ]);
  assert.deepEqual(
    new Set(workflow.jobs.build.strategy.matrix.platform),
    new Set(platforms.keys()),
  );
  const expanded = workflow.jobs.build.strategy.matrix.target.flatMap((target) => (
    workflow.jobs.build.strategy.matrix.platform.map((platform) => {
      const targetValues = workflow.jobs.build.strategy.matrix.include.filter(
        (item) => item.target === target && item.image,
      );
      const platformValues = workflow.jobs.build.strategy.matrix.include.filter(
        (item) => item.platform === platform && item.runner && item.arch,
      );
      assert.equal(targetValues.length, 1, `${target} image mapping은 하나여야 합니다`);
      assert.equal(platformValues.length, 1, `${platform} runner mapping은 하나여야 합니다`);
      return { target, platform, ...targetValues[0], ...platformValues[0] };
    })
  ));
  assert.equal(expanded.length, 8);
  for (const row of expanded) {
    assert.equal(row.image, expected.get(row.target));
    assert.deepEqual(
      { runner: row.runner, arch: row.arch },
      platforms.get(row.platform),
    );
  }

  for (const matrix of [
    workflow.jobs.build.strategy.matrix.include,
    workflow.jobs.merge.strategy.matrix.include,
  ]) {
    const mappings = new Map(
      matrix.filter((item) => item.target && item.image).map((item) => [item.target, item.image]),
    );
    assert.deepEqual(mappings, expected);
  }
});
