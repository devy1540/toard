import type { ToolCatalogItem, ToolCatalogSubmission } from "@toard/core";

const CATALOG_DATE = new Date("2026-07-13T00:00:00Z");

function publicItem(
  input: Omit<ToolCatalogSubmission, "installNotes" | "uninstallNotes"> &
    Partial<Pick<ToolCatalogSubmission, "installNotes" | "uninstallNotes">>,
): ToolCatalogItem {
  return {
    ...input,
    installNotes: input.installNotes ?? "See the source repository README for installation instructions.",
    uninstallNotes: input.uninstallNotes ?? "See the source repository README for removal instructions.",
    id: `public:${input.slug}`,
    origin: "public",
    trustStatus: "verified",
    lifecycleStatus: "published",
    statusReason: null,
    ownerUserId: null,
    ownerName: null,
    createdAt: CATALOG_DATE,
    updatedAt: CATALOG_DATE,
  };
}

export const PUBLIC_TOOL_CATALOG: readonly ToolCatalogItem[] = [
  publicItem({
    slug: "github-mcp-server",
    name: "GitHub MCP Server",
    description: "GitHub's official MCP server for repositories, issues, and pull requests.",
    kind: "mcp",
    sourceUrl: "https://github.com/github/github-mcp-server",
    sourceRef: "v0.31.0",
    supportedClients: ["codex", "claude_code"],
    requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    networkHosts: ["api.github.com", "github.com"],
    inventoryItemKey: "github",
    inventorySourceProvider: "codex",
  }),
  publicItem({
    slug: "context7",
    name: "Context7",
    description: "An MCP server for retrieving current library and API documentation.",
    kind: "mcp",
    sourceUrl: "https://github.com/upstash/context7",
    sourceRef: "@upstash/context7-mcp@3.2.0",
    supportedClients: ["codex", "claude_code"],
    requiredEnv: [],
    networkHosts: ["mcp.context7.com", "context7.com"],
    inventoryItemKey: "context7",
    inventorySourceProvider: "codex",
  }),
  publicItem({
    slug: "superpowers",
    name: "Superpowers",
    description: "An agentic skills framework and reusable software-development workflow.",
    kind: "plugin",
    sourceUrl: "https://github.com/obra/superpowers",
    sourceRef: "v5.0.7",
    supportedClients: ["codex", "claude_code"],
    requiredEnv: [],
    networkHosts: ["github.com"],
    inventoryItemKey: "superpowers",
    inventorySourceProvider: "codex",
  }),
] as const;

export const PUBLIC_TOOL_CATALOG_SLUGS = new Set(PUBLIC_TOOL_CATALOG.map((item) => item.slug));

export function getPublicToolCatalogItem(slug: string): ToolCatalogItem | null {
  return PUBLIC_TOOL_CATALOG.find((item) => item.slug === slug) ?? null;
}
