import { getPool } from "./db";
import { loadKeyManagementConfig, type KeyManagementConfig } from "./key-management/config";
import { createKeyProviderRegistry } from "./key-management/provider-factory";
import { ProviderHealthCache } from "./key-management/provider-health-cache";
import { recordCacheResult } from "./key-management/observability";
import { KeyProviderRegistry } from "./key-management/registry";
import { UserKeyCache } from "./key-management/user-key-cache";
import { ManagedUserKeyService } from "./managed-user-keys";

export type ManagedContentRuntime = {
  installationId: string;
  registry: KeyProviderRegistry;
  userKeys: Pick<
    ManagedUserKeyService,
    "withActiveUserKey" | "withUserKeyVersion"
  > & { evict?: ManagedUserKeyService["evict"] };
  health: ProviderHealthCache;
};

export type RuntimeDependencies = {
  env: Readonly<Record<string, string | undefined>>;
  loadInstallationId: () => Promise<string>;
  createRegistry: (config: KeyManagementConfig) => KeyProviderRegistry;
  createCache?: (ttlMs: number) => UserKeyCache;
  createUserKeys?: (input: {
    installationId: string;
    registry: KeyProviderRegistry;
    cache: UserKeyCache;
  }) => ManagedContentRuntime["userKeys"];
  createHealth?: () => ProviderHealthCache;
};

export type InstallationIdentityDb = {
  query(sql: string): Promise<{ rows: Array<{ installation_id?: unknown }> }>;
};

async function loadInstallationIdFromDb(db: InstallationIdentityDb): Promise<string> {
  const result = await db.query(
    "SELECT installation_id FROM installation_identity WHERE singleton=TRUE",
  );
  const installationId = result.rows[0]?.installation_id;
  if (typeof installationId !== "string" || installationId.length === 0) {
    throw new Error("INSTALLATION_IDENTITY_MISSING");
  }
  return installationId;
}

const defaultRuntimeDependencies: RuntimeDependencies = {
  env: process.env,
  loadInstallationId: () => loadInstallationIdFromDb(getPool()),
  createRegistry: (config) => createKeyProviderRegistry(config),
};

let runtimePromise: Promise<ManagedContentRuntime | null> | undefined;

export function managedContentConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!env.TOARD_KEY_ACTIVE_PROVIDER?.trim()) return false;
  try {
    loadKeyManagementConfig(env);
    return true;
  } catch {
    return false;
  }
}

export async function createManagedContentRuntime(
  dependencies: RuntimeDependencies = defaultRuntimeDependencies,
): Promise<ManagedContentRuntime | null> {
  if (!dependencies.env.TOARD_KEY_ACTIVE_PROVIDER?.trim()) {
    const hasPartialProfile = Object.entries(dependencies.env).some(
      ([name, value]) =>
        value?.trim()
        && (
          name.startsWith("TOARD_KEY_ACTIVE_")
          || name.startsWith("TOARD_KEY_MIGRATION_")
        ),
    );
    if (!hasPartialProfile) return null;
  }

  // 설정 파싱 오류는 안전한 환경변수 이름을 운영자에게 보여 주기 위해 보존한다.
  const config = loadKeyManagementConfig(dependencies.env);
  try {
    const installationId = await dependencies.loadInstallationId();
    const registry = dependencies.createRegistry(config);
    const cache = (dependencies.createCache ?? ((ttlMs) => new UserKeyCache({
      ttlMs,
      recordCacheResult,
    })))(
      config.cacheTtlMs,
    );
    const userKeys = (
      dependencies.createUserKeys
      ?? ((input) => new ManagedUserKeyService(input))
    )({ installationId, registry, cache });
    const health = (dependencies.createHealth ?? (() => new ProviderHealthCache()))();
    return { installationId, registry, userKeys, health };
  } catch {
    throw new Error("MANAGED_CONTENT_RUNTIME_INIT_FAILED");
  }
}

// CLI처럼 role guard가 선행되어야 하는 caller는 공유 pool을 쓰지 않고 자신이 보유한 lease만 전달한다.
export function createManagedContentRuntimeForDatabase(
  db: InstallationIdentityDb,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ManagedContentRuntime | null> {
  return createManagedContentRuntime({
    ...defaultRuntimeDependencies,
    env,
    loadInstallationId: () => loadInstallationIdFromDb(db),
  });
}

export function getManagedContentRuntime(
  dependencies: RuntimeDependencies = defaultRuntimeDependencies,
): Promise<ManagedContentRuntime | null> {
  runtimePromise ??= createManagedContentRuntime(dependencies);
  return runtimePromise;
}

export function resetManagedContentRuntimeForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("MANAGED_CONTENT_RUNTIME_RESET_TEST_ONLY");
  }
  runtimePromise = undefined;
}
