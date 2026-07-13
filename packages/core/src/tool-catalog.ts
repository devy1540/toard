import type { DeviceToolInventory } from "./tool-metadata";

export type ToolCatalogKind = "mcp" | "skill" | "plugin";
export type ToolCatalogTrust = "community" | "verified";
export type ToolCatalogLifecycle = "published" | "deprecated" | "blocked" | "archived";
export type ToolCatalogOrigin = "public" | "workspace";
export type ToolCatalogClient = "codex" | "claude_code";
export type ToolCatalogScope = "all" | "public" | "workspace" | "mine";

export type ToolCatalogSubmission = {
  name: string;
  slug: string;
  description: string;
  kind: ToolCatalogKind;
  sourceUrl: string;
  sourceRef: string;
  supportedClients: ToolCatalogClient[];
  requiredEnv: string[];
  networkHosts: string[];
  installNotes: string;
  uninstallNotes: string;
  inventoryItemKey: string;
  inventorySourceProvider: ToolCatalogClient;
};

export type ToolCatalogItem = ToolCatalogSubmission & {
  id: string;
  origin: ToolCatalogOrigin;
  trustStatus: ToolCatalogTrust;
  lifecycleStatus: ToolCatalogLifecycle;
  statusReason: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogFieldErrors = Partial<Record<keyof ToolCatalogSubmission, "invalid">>;
export type CatalogParseResult =
  | { ok: true; value: ToolCatalogSubmission }
  | { ok: false; fieldErrors: CatalogFieldErrors };

export type ToolCatalogFilter = {
  scope: ToolCatalogScope;
  kind: ToolCatalogKind | "all";
  query: string;
  viewerId: string;
};

export type CatalogInstallState =
  | { status: "not_installed" }
  | { status: "unavailable" }
  | { status: "installed"; version: string | null; versionRelation: "same" | "different" | "unknown" };

const SEMANTIC_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

export function isToolCatalogKind(value: string): value is ToolCatalogKind {
  return value === "mcp" || value === "skill" || value === "plugin";
}

export function isToolCatalogClient(value: string): value is ToolCatalogClient {
  return value === "codex" || value === "claude_code";
}

export function isToolCatalogTrust(value: string): value is ToolCatalogTrust {
  return value === "community" || value === "verified";
}

export function isToolCatalogLifecycle(value: string): value is ToolCatalogLifecycle {
  return value === "published" || value === "deprecated" || value === "blocked" || value === "archived";
}

export function isToolCatalogScope(value: string): value is ToolCatalogScope {
  return value === "all" || value === "public" || value === "workspace" || value === "mine";
}

function uniqueTrimmed(values: readonly string[], lower = false): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return [...new Set(lower ? normalized.map((value) => value.toLowerCase()) : normalized)];
}

function isPrivateSourceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(host)) return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const a = octets[0]!;
  const b = octets[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isValidSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      Boolean(url.hostname) &&
      !isPrivateSourceHost(url.hostname)
    );
  } catch {
    return false;
  }
}

export function parseToolCatalogSubmission(input: ToolCatalogSubmission): CatalogParseResult {
  const value: ToolCatalogSubmission = {
    ...input,
    name: input.name.trim(),
    slug: input.slug.trim(),
    description: input.description.trim(),
    sourceUrl: input.sourceUrl.trim(),
    sourceRef: input.sourceRef.trim(),
    supportedClients: [...new Set(input.supportedClients)],
    requiredEnv: uniqueTrimmed(input.requiredEnv),
    networkHosts: uniqueTrimmed(input.networkHosts, true),
    installNotes: input.installNotes.trim(),
    uninstallNotes: input.uninstallNotes.trim(),
    inventoryItemKey: input.inventoryItemKey.trim(),
  };
  const fieldErrors: CatalogFieldErrors = {};

  if (!value.name || value.name.length > 100) fieldErrors.name = "invalid";
  if (!SLUG.test(value.slug) || value.slug.length > 100) fieldErrors.slug = "invalid";
  if (!value.description || value.description.length > 500) fieldErrors.description = "invalid";
  if (!isToolCatalogKind(value.kind)) fieldErrors.kind = "invalid";
  if (!isValidSourceUrl(value.sourceUrl)) fieldErrors.sourceUrl = "invalid";
  if (!SEMANTIC_TAG.test(value.sourceRef) && !FULL_COMMIT_SHA.test(value.sourceRef)) {
    fieldErrors.sourceRef = "invalid";
  }
  if (
    value.supportedClients.length === 0 ||
    value.supportedClients.length > 2 ||
    value.supportedClients.some((client) => !isToolCatalogClient(client))
  ) {
    fieldErrors.supportedClients = "invalid";
  }
  if (value.requiredEnv.length > 50 || value.requiredEnv.some((name) => !ENV_NAME.test(name))) {
    fieldErrors.requiredEnv = "invalid";
  }
  if (value.networkHosts.length > 50 || value.networkHosts.some((host) => !HOSTNAME.test(host))) {
    fieldErrors.networkHosts = "invalid";
  }
  if (value.installNotes.length > 10_000) fieldErrors.installNotes = "invalid";
  if (value.uninstallNotes.length > 10_000) fieldErrors.uninstallNotes = "invalid";
  if (!value.inventoryItemKey || value.inventoryItemKey.length > 200) fieldErrors.inventoryItemKey = "invalid";
  if (!isToolCatalogClient(value.inventorySourceProvider)) fieldErrors.inventorySourceProvider = "invalid";

  return Object.keys(fieldErrors).length > 0 ? { ok: false, fieldErrors } : { ok: true, value };
}

export function filterToolCatalogItems(items: readonly ToolCatalogItem[], filter: ToolCatalogFilter): ToolCatalogItem[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filter.scope === "public" && item.origin !== "public") return false;
    if (filter.scope === "workspace" && item.origin !== "workspace") return false;
    if (filter.scope === "mine" && item.ownerUserId !== filter.viewerId) return false;
    if (filter.kind !== "all" && item.kind !== filter.kind) return false;
    if (!query) return true;
    return `${item.name}\n${item.description}`.toLocaleLowerCase().includes(query);
  });
}

export function resolveCatalogInstallState(
  item: Pick<ToolCatalogItem, "kind" | "inventoryItemKey" | "inventorySourceProvider" | "sourceRef">,
  inventories: readonly DeviceToolInventory[] | null,
): CatalogInstallState {
  if (inventories === null) return { status: "unavailable" };
  const match = inventories
    .flatMap((inventory) => inventory.items)
    .find(
      (inventoryItem) =>
        inventoryItem.kind === item.kind &&
        inventoryItem.itemKey === item.inventoryItemKey &&
        inventoryItem.sourceProvider === item.inventorySourceProvider,
    );
  if (!match) return { status: "not_installed" };
  if (!match.version) return { status: "installed", version: null, versionRelation: "unknown" };
  const normalizedInstalled = match.version.replace(/^v(?=\d)/, "");
  const normalizedCatalog = item.sourceRef.replace(/^v(?=\d)/, "");
  return {
    status: "installed",
    version: match.version,
    versionRelation: normalizedInstalled === normalizedCatalog ? "same" : "different",
  };
}
