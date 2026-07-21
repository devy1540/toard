import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type VerificationModules = {
  loadKeyManagementConfig:
    typeof import("../apps/web/lib/key-management/config").loadKeyManagementConfig;
  createKeyProvider:
    typeof import("../apps/web/lib/key-management/provider-factory").createKeyProvider;
  runProviderCanary:
    typeof import("../apps/web/lib/key-management/provider-health-cache").runProviderCanary;
};

type VerificationDependencies = {
  load: () => Promise<VerificationModules>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

async function loadVerificationModules(): Promise<VerificationModules> {
  const [
    { loadKeyManagementConfig },
    { createKeyProvider },
    { runProviderCanary },
  ] = await Promise.all([
    import("../apps/web/lib/key-management/config"),
    import("../apps/web/lib/key-management/provider-factory"),
    import("../apps/web/lib/key-management/provider-health-cache"),
  ]);
  return {
    loadKeyManagementConfig,
    createKeyProvider,
    runProviderCanary,
  };
}

export async function verifyKeyProvider(
  env: NodeJS.ProcessEnv,
  dependencies: VerificationDependencies = {
    load: loadVerificationModules,
  },
): Promise<0 | 1 | 2> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  if (env.TOARD_VERIFY_KEY_PROVIDER !== "1") {
    stderr("TOARD_VERIFY_KEY_PROVIDER=1 required");
    return 2;
  }

  try {
    const {
      loadKeyManagementConfig,
      createKeyProvider,
      runProviderCanary,
    } = await dependencies.load();
    const config = loadKeyManagementConfig(env);
    const provider = createKeyProvider(config.active);
    const result = await runProviderCanary(provider);
    stdout(JSON.stringify({
      provider: provider.name,
      keyRef: provider.keyRef,
      fingerprint: provider.fingerprint,
      status: result.status,
      latencyMs: Math.round(result.latencyMs),
    }));
    return result.status === "healthy" ? 0 : 1;
  } catch {
    stderr("KEY_PROVIDER_VERIFY_FAILED");
    return 1;
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint
  && import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  process.exitCode = await verifyKeyProvider(process.env);
}
