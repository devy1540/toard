import type { ToolCatalogClient, ToolCatalogKind, ToolCatalogSubmission } from "@toard/core";
import { isToolCatalogClient } from "@toard/core";

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function lines(formData: FormData, name: string): string[] {
  return String(formData.get(name) ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function submissionFromFormData(formData: FormData): ToolCatalogSubmission {
  return {
    name: text(formData, "name"),
    slug: text(formData, "slug"),
    description: text(formData, "description"),
    kind: text(formData, "kind") as ToolCatalogKind,
    sourceUrl: text(formData, "sourceUrl"),
    sourceRef: text(formData, "sourceRef"),
    supportedClients: formData
      .getAll("supportedClients")
      .map(String)
      .filter(isToolCatalogClient),
    requiredEnv: lines(formData, "requiredEnv"),
    networkHosts: lines(formData, "networkHosts"),
    installNotes: text(formData, "installNotes"),
    uninstallNotes: text(formData, "uninstallNotes"),
    inventoryItemKey: text(formData, "inventoryItemKey"),
    inventorySourceProvider: text(formData, "inventorySourceProvider") as ToolCatalogClient,
  };
}
