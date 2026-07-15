import type { ToolCatalogClient, ToolCatalogKind } from "./tool-catalog";

export type ToolDeploymentStatus =
  | "queued"
  | "applying"
  | "settings_required"
  | "installed"
  | "conflict"
  | "failed"
  | "rolled_back"
  | "excluded"
  | "unsupported";

export type ToolDeploymentOrigin = "personal" | "team";
export type ToolRolloutPhase = "preflight" | "canary" | "expand" | "active" | "paused" | "rollback";

export type ToolDeploymentSource = {
  provider: "github";
  repository: string;
  exactRef: string;
  path: string;
  treeDigest: string;
  downloadUrl: string;
};

export type ToolDeploymentPermissions = {
  env: string[];
  networkHosts: string[];
  executables: string[];
};

export type ToolDeploymentPayload =
  | { type: "skill"; files: string[]; targetKey: string }
  | { type: "mcp_stdio"; command: string; args: string[]; requiredEnvNames: string[]; managedKey: string }
  | { type: "mcp_http"; url: string; auth: "none" | "oauth" | "manual_secret_header"; managedKey: string }
  | { type: "plugin"; components: { type: "skill" | "mcp_stdio" | "mcp_http"; key: string }[] };

export type ToolDeploymentManifestV1 = {
  schemaVersion: 1;
  catalogItemId: string;
  versionId: string;
  slug: string;
  kind: ToolCatalogKind;
  source: ToolDeploymentSource;
  clients: ToolCatalogClient[];
  minProtocolVersion: 1;
  permissions: ToolDeploymentPermissions;
  payload: ToolDeploymentPayload;
};

export type ToolPreference = {
  catalogItemId: string;
  mode: "install" | "exclude";
  scope: "all_devices" | "selected_devices";
  versionId: string | null;
  deviceFingerprints: string[];
};

export type TeamToolPolicy = {
  catalogItemId: string;
  versionId: string;
  rolloutId: string;
  rolloutSeed: string;
  rolloutPercent: number;
};

export type ResolveDesiredInput = {
  userId: string;
  deviceFingerprint: string;
  preferences: ToolPreference[];
  teamPolicies: TeamToolPolicy[];
};

export type DesiredTool = {
  catalogItemId: string;
  versionId: string;
  origin: ToolDeploymentOrigin;
  rolloutId: string | null;
};

export type ToolPermissionDiff = {
  approvalRequired: boolean;
  addedEnv: string[];
  addedHosts: string[];
  sourceChanged: boolean;
  commandChanged: boolean;
  componentsAdded: string[];
};

export type RolloutEvaluation = {
  phase: ToolRolloutPhase;
  eligible: number;
  attempted: number;
  failed: number;
  phaseStartedAt: Date;
};

export type RolloutDecision =
  | { action: "hold" }
  | { action: "advance"; nextPhase: "expand" | "active"; percent: 50 | 100 }
  | { action: "rollback"; reason: "failure_threshold" };

function selectedForDevice(preference: ToolPreference, fingerprint: string): boolean {
  return preference.scope === "all_devices" || preference.deviceFingerprints.includes(fingerprint);
}

export function resolveDesiredTools(input: ResolveDesiredInput): DesiredTool[] {
  const excluded = new Set(
    input.preferences
      .filter((preference) => preference.mode === "exclude")
      .map((preference) => preference.catalogItemId),
  );
  const personal = new Map(
    input.preferences
      .filter(
        (preference) =>
          preference.mode === "install" &&
          preference.versionId !== null &&
          selectedForDevice(preference, input.deviceFingerprint),
      )
      .map((preference) => [preference.catalogItemId, preference]),
  );
  const policies = new Map(input.teamPolicies.map((policy) => [policy.catalogItemId, policy]));
  const ids = [...new Set([...personal.keys(), ...policies.keys()])].sort();

  return ids.flatMap((catalogItemId): DesiredTool[] => {
    if (excluded.has(catalogItemId)) return [];
    const preference = personal.get(catalogItemId);
    if (preference?.versionId) {
      return [{ catalogItemId, versionId: preference.versionId, origin: "personal", rolloutId: null }];
    }
    const policy = policies.get(catalogItemId);
    if (
      !policy ||
      rolloutCohortPercent(policy.rolloutSeed, input.deviceFingerprint) >= policy.rolloutPercent
    ) {
      return [];
    }
    return [{ catalogItemId, versionId: policy.versionId, origin: "team", rolloutId: policy.rolloutId }];
  });
}

function addedValues(previous: readonly string[], next: readonly string[]): string[] {
  const existing = new Set(previous);
  return [...new Set(next)].filter((value) => !existing.has(value)).sort();
}

function stdioIdentity(payload: ToolDeploymentPayload): string | null {
  return payload.type === "mcp_stdio" ? JSON.stringify([payload.command, payload.args]) : null;
}

function componentKeys(payload: ToolDeploymentPayload): string[] {
  return payload.type === "plugin"
    ? payload.components.map((component) => `${component.type}:${component.key}`)
    : [];
}

export function diffToolPermissions(
  previous: ToolDeploymentManifestV1,
  next: ToolDeploymentManifestV1,
): ToolPermissionDiff {
  const addedEnv = addedValues(previous.permissions.env, next.permissions.env);
  const addedHosts = addedValues(previous.permissions.networkHosts, next.permissions.networkHosts);
  const componentsAdded = addedValues(componentKeys(previous.payload), componentKeys(next.payload));
  const sourceChanged =
    previous.source.provider !== next.source.provider ||
    previous.source.repository !== next.source.repository;
  const commandChanged = stdioIdentity(previous.payload) !== stdioIdentity(next.payload);
  return {
    approvalRequired:
      addedEnv.length > 0 ||
      addedHosts.length > 0 ||
      componentsAdded.length > 0 ||
      sourceChanged ||
      commandChanged,
    addedEnv,
    addedHosts,
    sourceChanged,
    commandChanged,
    componentsAdded,
  };
}

export function rolloutCohortPercent(seed: string, fingerprint: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(`${seed}:${fingerprint}`)) {
    hash = Math.imul(hash ^ byte, 16_777_619);
  }
  return (hash >>> 0) % 100;
}

export function evaluateRollout(state: RolloutEvaluation, now: Date): RolloutDecision {
  if (state.failed >= 2 || (state.attempted > 0 && state.failed / state.attempted >= 0.2)) {
    return { action: "rollback", reason: "failure_threshold" };
  }
  const elapsedMs = now.getTime() - state.phaseStartedAt.getTime();
  const canaryTarget = Math.max(1, Math.ceil(state.eligible * 0.1));
  if (state.phase === "canary" && elapsedMs >= 30 * 60_000 && state.attempted >= canaryTarget) {
    return { action: "advance", nextPhase: "expand", percent: 50 };
  }
  if (state.phase === "expand" && elapsedMs >= 60 * 60_000) {
    return { action: "advance", nextPhase: "active", percent: 100 };
  }
  return { action: "hold" };
}
