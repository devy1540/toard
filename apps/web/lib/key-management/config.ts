import { isAbsolute } from "node:path";
import type { KeyProviderName } from "./types";

const PROVIDER_NAMES = new Set<KeyProviderName>([
  "local",
  "aws-kms",
  "gcp-kms",
  "azure-key-vault",
  "vault-transit",
  "openbao-transit",
]);

const RAW_CREDENTIAL_NAME =
  /(?:^|_)(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|CREDENTIALS?|ACCESS_KEY|CLIENT_KEY|API_KEY|ACCOUNT_KEY)(?:_|$)/i;
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const AWS_KMS_KEY_ARN =
  /^arn:aws(?:-us-gov|-cn|-iso(?:-[bef])?)?:kms:([a-z0-9-]+):\d{12}:key\/[A-Za-z0-9][A-Za-z0-9-]*$/;
const GCP_KMS_KEY_NAME =
  /^projects\/[^/\s]+\/locations\/[^/\s]+\/keyRings\/[^/\s]+\/cryptoKeys\/[^/\s]+$/;
const AZURE_CREDENTIAL_MODES = new Set([
  "default",
  "managed-identity",
  "workload-identity",
]);
const TRANSIT_AUTH_REQUIRED = {
  "token-file": ["TRANSIT_TOKEN_FILE"],
  kubernetes: ["TRANSIT_KUBERNETES_ROLE", "TRANSIT_KUBERNETES_JWT_FILE"],
  approle: ["TRANSIT_APPROLE_ROLE_ID_FILE", "TRANSIT_APPROLE_SECRET_ID_FILE"],
  "static-token": ["TRANSIT_TOKEN_FILE"],
} as const;
const TRANSIT_AUTH_SETTINGS = new Set(
  Object.values(TRANSIT_AUTH_REQUIRED).flat(),
);

type ProfilePrefix = "TOARD_KEY_ACTIVE" | "TOARD_KEY_MIGRATION";
type TransitAuthMethod = keyof typeof TRANSIT_AUTH_REQUIRED;

export type ProviderProfile = {
  slot: "active" | "migration";
  provider: KeyProviderName;
  settings: Readonly<Record<string, string>>;
};

export type KeyManagementConfig = {
  active: ProviderProfile;
  migration: ProviderProfile | null;
  cacheTtlMs: number;
};

type KeyManagementEnvironment = Readonly<Record<string, string | undefined>>;

function configuredValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function parseProviderName(value: string | undefined, variable: string): KeyProviderName {
  const configured = configuredValue(value);
  if (!configured || !PROVIDER_NAMES.has(configured as KeyProviderName)) {
    throw new Error(`${variable}는 지원하는 provider여야 합니다`);
  }
  return configured as KeyProviderName;
}

function configuredProfileSettings(
  prefix: ProfilePrefix,
  env: KeyManagementEnvironment,
): Array<readonly [string, string, string]> {
  const settings: Array<readonly [string, string, string]> = [];
  for (const [variable, value] of Object.entries(env)) {
    const configured = configuredValue(value);
    if (
      configured !== undefined
      && variable.startsWith(`${prefix}_`)
      && variable !== `${prefix}_PROVIDER`
    ) {
      settings.push([
        variable,
        variable.slice(prefix.length + 1),
        configured,
      ]);
    }
  }
  return settings;
}

function parseExactSettings(
  prefix: ProfilePrefix,
  provider: Exclude<KeyProviderName, "local">,
  allowedSettings: ReadonlySet<string>,
  env: KeyManagementEnvironment,
): Readonly<Record<string, string>> {
  const settings: Array<readonly [string, string]> = [];
  for (const [variable, settingName, value] of configuredProfileSettings(prefix, env)) {
    if (!allowedSettings.has(settingName)) {
      if (RAW_CREDENTIAL_NAME.test(settingName) && !settingName.endsWith("_FILE")) {
        throw new Error(`${prefix} raw credential 환경변수는 허용하지 않습니다`);
      }
      throw new Error(`${variable}은 ${provider} profile에서 허용되지 않습니다`);
    }
    settings.push([settingName, value]);
  }
  settings.sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(Object.fromEntries(settings));
}

function requiredSetting(
  prefix: ProfilePrefix,
  settings: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = settings[name];
  if (!value) throw new Error(`${prefix}_${name}이 필요합니다`);
  return value;
}

function parseUrl(value: string, variable: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${variable}은 유효한 URL이어야 합니다`);
  }
}

function parseLocalSettings(
  prefix: ProfilePrefix,
  env: KeyManagementEnvironment,
): Readonly<Record<string, string>> {
  const fileVariable = `${prefix}_LOCAL_KEK_FILE`;
  const keyFile = configuredValue(env[fileVariable]);
  if (!keyFile) throw new Error(`${fileVariable}이 필요합니다`);
  if (!isAbsolute(keyFile)) throw new Error(`${fileVariable}은 절대 경로여야 합니다`);

  const unexpectedProfileVariables = Object.entries(env)
    .filter(([name, value]) => (
      configuredValue(value) !== undefined
      && name.startsWith(`${prefix}_`)
      && name !== `${prefix}_PROVIDER`
      && name !== fileVariable
    ))
    .map(([name]) => name);
  if (
    configuredValue(env.TOARD_CONTENT_KEK_B64) !== undefined
    || unexpectedProfileVariables.length > 0
  ) {
    throw new Error("local profile은 KEK file 하나만 허용하며 raw 환경변수를 받지 않습니다");
  }

  return Object.freeze({ LOCAL_KEK_FILE: keyFile });
}

function parseAwsSettings(
  prefix: ProfilePrefix,
  env: KeyManagementEnvironment,
): Readonly<Record<string, string>> {
  const settings = parseExactSettings(prefix, "aws-kms", new Set([
    "AWS_KEY_ARN",
    "AWS_REGION",
    "AWS_ENDPOINT",
  ]), env);
  const keyArn = requiredSetting(prefix, settings, "AWS_KEY_ARN");
  const region = requiredSetting(prefix, settings, "AWS_REGION");
  const arnMatch = AWS_KMS_KEY_ARN.exec(keyArn);
  if (!arnMatch || !AWS_REGION.test(arnMatch[1]!)) {
    throw new Error(`${prefix}_AWS_KEY_ARN은 AWS KMS key ARN이어야 합니다`);
  }
  if (!AWS_REGION.test(region)) {
    throw new Error(`${prefix}_AWS_REGION은 유효한 AWS region이어야 합니다`);
  }
  const endpoint = settings.AWS_ENDPOINT;
  if (endpoint) {
    const url = parseUrl(endpoint, `${prefix}_AWS_ENDPOINT`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${prefix}_AWS_ENDPOINT는 credential 없는 HTTP(S) URL이어야 합니다`);
    }
  }
  return settings;
}

function parseGcpSettings(
  prefix: ProfilePrefix,
  env: KeyManagementEnvironment,
): Readonly<Record<string, string>> {
  const settings = parseExactSettings(prefix, "gcp-kms", new Set([
    "GCP_KEY_NAME",
    "GCP_API_ENDPOINT",
  ]), env);
  const keyName = requiredSetting(prefix, settings, "GCP_KEY_NAME");
  if (!GCP_KMS_KEY_NAME.test(keyName)) {
    throw new Error(
      `${prefix}_GCP_KEY_NAME은 projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey} 형식이어야 합니다`,
    );
  }
  return settings;
}

function parseAzureSettings(
  prefix: ProfilePrefix,
  env: KeyManagementEnvironment,
): Readonly<Record<string, string>> {
  const settings = parseExactSettings(prefix, "azure-key-vault", new Set([
    "AZURE_KEY_ID",
    "AZURE_CREDENTIAL_MODE",
    "AZURE_MANAGED_IDENTITY_CLIENT_ID",
  ]), env);
  const credentialMode = requiredSetting(prefix, settings, "AZURE_CREDENTIAL_MODE");
  if (!AZURE_CREDENTIAL_MODES.has(credentialMode)) {
    throw new Error(
      `${prefix}_AZURE_CREDENTIAL_MODE는 default, managed-identity, workload-identity 중 하나여야 합니다`,
    );
  }
  if (env.NODE_ENV === "production" && credentialMode === "default") {
    throw new Error("production에서는 Azure credential mode default를 허용하지 않습니다");
  }

  const keyIdVariable = `${prefix}_AZURE_KEY_ID`;
  const keyId = requiredSetting(prefix, settings, "AZURE_KEY_ID");
  const keyUrl = parseUrl(keyId, keyIdVariable);
  if (
    keyUrl.protocol !== "https:"
    || keyUrl.username
    || keyUrl.password
    || keyUrl.search
    || keyUrl.hash
    || !/^\/keys\/[^/]+(?:\/[^/]+)?$/.test(keyUrl.pathname)
  ) {
    throw new Error(`${keyIdVariable}는 full HTTPS Azure Key Vault key ID여야 합니다`);
  }
  return settings;
}

function parseTransitSettings(
  prefix: ProfilePrefix,
  provider: "vault-transit" | "openbao-transit",
  env: KeyManagementEnvironment,
): Readonly<Record<string, string>> {
  const allowedSettings = new Set([
    "TRANSIT_ADDRESS",
    "TRANSIT_MOUNT",
    "TRANSIT_KEY_NAME",
    "TRANSIT_AUTH_METHOD",
    "TRANSIT_NAMESPACE",
    ...TRANSIT_AUTH_SETTINGS,
  ]);
  const settings = parseExactSettings(prefix, provider, allowedSettings, env);
  const addressVariable = `${prefix}_TRANSIT_ADDRESS`;
  const address = requiredSetting(prefix, settings, "TRANSIT_ADDRESS");
  const addressUrl = parseUrl(address, addressVariable);
  if (addressUrl.protocol !== "https:" || addressUrl.username || addressUrl.password) {
    throw new Error(`${addressVariable}는 credential 없는 https URL이어야 합니다`);
  }
  requiredSetting(prefix, settings, "TRANSIT_MOUNT");
  requiredSetting(prefix, settings, "TRANSIT_KEY_NAME");

  const authMethodValue = requiredSetting(prefix, settings, "TRANSIT_AUTH_METHOD");
  if (!(authMethodValue in TRANSIT_AUTH_REQUIRED)) {
    throw new Error(
      `${prefix}_TRANSIT_AUTH_METHOD는 token-file, kubernetes, approle, static-token 중 하나여야 합니다`,
    );
  }
  const authMethod = authMethodValue as TransitAuthMethod;
  const requiredAuthSettings = new Set<string>(TRANSIT_AUTH_REQUIRED[authMethod]);
  for (const settingName of TRANSIT_AUTH_SETTINGS) {
    if (settings[settingName] && !requiredAuthSettings.has(settingName)) {
      throw new Error(
        `${prefix}_${settingName}은 선택한 Transit auth method에서 허용되지 않습니다`,
      );
    }
  }
  for (const settingName of requiredAuthSettings) {
    const value = requiredSetting(prefix, settings, settingName);
    if (settingName.endsWith("_FILE") && !isAbsolute(value)) {
      throw new Error(`${prefix}_${settingName}은 절대 경로여야 합니다`);
    }
  }
  return settings;
}

function parseNonLocalSettings(
  prefix: ProfilePrefix,
  provider: Exclude<KeyProviderName, "local">,
  env: KeyManagementEnvironment,
): Readonly<Record<string, string>> {
  switch (provider) {
    case "aws-kms":
      return parseAwsSettings(prefix, env);
    case "gcp-kms":
      return parseGcpSettings(prefix, env);
    case "azure-key-vault":
      return parseAzureSettings(prefix, env);
    case "vault-transit":
    case "openbao-transit":
      return parseTransitSettings(prefix, provider, env);
  }
}

function parseProfile(
  slot: "active" | "migration",
  env: KeyManagementEnvironment,
): ProviderProfile {
  const prefix = slot === "active" ? "TOARD_KEY_ACTIVE" : "TOARD_KEY_MIGRATION";
  const provider = parseProviderName(env[`${prefix}_PROVIDER`], `${prefix}_PROVIDER`);
  const settings = provider === "local"
    ? parseLocalSettings(prefix, env)
    : parseNonLocalSettings(prefix, provider, env);
  return { slot, provider, settings };
}

function stableSettings(settings: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.entries(settings).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function loadKeyManagementConfig(env: KeyManagementEnvironment): KeyManagementConfig {
  const active = parseProfile("active", env);
  const migrationProvider = configuredValue(env.TOARD_KEY_MIGRATION_PROVIDER);
  if (!migrationProvider && configuredProfileSettings("TOARD_KEY_MIGRATION", env).length > 0) {
    throw new Error("TOARD_KEY_MIGRATION_PROVIDER가 필요합니다");
  }
  const migration = migrationProvider ? parseProfile("migration", env) : null;
  const ttl = Number(configuredValue(env.TOARD_USER_KEY_CACHE_TTL_SECONDS) ?? "1800");
  if (!Number.isSafeInteger(ttl) || ttl < 300 || ttl > 3600) {
    throw new Error("TOARD_USER_KEY_CACHE_TTL_SECONDS는 300~3600 정수여야 합니다");
  }
  if (
    migration
    && migration.provider === active.provider
    && stableSettings(migration.settings) === stableSettings(active.settings)
  ) {
    throw new Error("active와 migration provider fingerprint가 같을 수 없습니다");
  }
  return { active, migration, cacheTtlMs: ttl * 1000 };
}
