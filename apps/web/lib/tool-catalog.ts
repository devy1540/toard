import type {
  CatalogInstallState,
  DeviceToolInventory,
  ToolCatalogFilter,
  ToolCatalogItem,
  ToolCatalogLifecycle,
  ToolCatalogSubmission,
  ToolCatalogTrust,
} from "@toard/core";
import { filterToolCatalogItems, resolveCatalogInstallState } from "@toard/core";
import { getPool } from "./db";
import { getMyDeviceInventories } from "./tool-metadata";
import {
  getPublicToolCatalogItem,
  PUBLIC_TOOL_CATALOG,
  PUBLIC_TOOL_CATALOG_SLUGS,
} from "./tool-catalog-public";

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number | null };

export type ToolCatalogDb = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
};

export type CatalogViewer = { id: string; role: string };
export type CatalogModeration = {
  trustStatus: ToolCatalogTrust;
  lifecycleStatus: ToolCatalogLifecycle;
  statusReason: string | null;
};

export type CatalogListFilter = Omit<ToolCatalogFilter, "viewerId">;
export type ToolCatalogListItem = ToolCatalogItem & { installState: CatalogInstallState };

type CatalogMutationResult =
  | { ok: true; id: string; slug: string }
  | { ok: false; reason: "slug-conflict" | "forbidden-or-not-found" };

type CatalogStatusResult =
  | { ok: true }
  | { ok: false; reason: "forbidden" | "not-found" | "forbidden-or-not-found" };

const SELECT_COLUMNS = `
  SELECT c.id, c.slug, c.name, c.description, c.kind, c.source_url, c.source_ref,
         c.supported_clients, c.required_env, c.network_hosts, c.install_notes,
         c.uninstall_notes, c.inventory_item_key, c.inventory_source_provider,
         c.trust_status, c.lifecycle_status, c.status_reason, c.owner_user_id,
         COALESCE(u.name, u.email) AS owner_name, c.created_at, c.updated_at
  FROM tool_catalog_items c
  LEFT JOIN users u ON u.id = c.owner_user_id`;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function mapCatalogRow(row: Record<string, unknown>): ToolCatalogItem {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    kind: row.kind as ToolCatalogItem["kind"],
    sourceUrl: String(row.source_url),
    sourceRef: String(row.source_ref),
    supportedClients: strings(row.supported_clients) as ToolCatalogItem["supportedClients"],
    requiredEnv: strings(row.required_env),
    networkHosts: strings(row.network_hosts),
    installNotes: String(row.install_notes ?? ""),
    uninstallNotes: String(row.uninstall_notes ?? ""),
    inventoryItemKey: String(row.inventory_item_key),
    inventorySourceProvider: row.inventory_source_provider as ToolCatalogItem["inventorySourceProvider"],
    origin: "workspace",
    trustStatus: row.trust_status as ToolCatalogTrust,
    lifecycleStatus: row.lifecycle_status as ToolCatalogLifecycle,
    statusReason: row.status_reason == null ? null : String(row.status_reason),
    ownerUserId: String(row.owner_user_id),
    ownerName: row.owner_name == null ? null : String(row.owner_name),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function submissionParams(submission: ToolCatalogSubmission): unknown[] {
  return [
    submission.slug,
    submission.name,
    submission.description,
    submission.kind,
    submission.sourceUrl,
    submission.sourceRef,
    submission.supportedClients,
    submission.requiredEnv,
    submission.networkHosts,
    submission.installNotes,
    submission.uninstallNotes,
    submission.inventoryItemKey,
    submission.inventorySourceProvider,
  ];
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function listWorkspaceToolCatalogWithDb(
  db: ToolCatalogDb,
  _viewer: CatalogViewer,
): Promise<ToolCatalogItem[]> {
  const result = await db.query(
    `${SELECT_COLUMNS}
     WHERE c.lifecycle_status IN ('published', 'deprecated')
     ORDER BY c.updated_at DESC, c.name`,
  );
  return result.rows.map(mapCatalogRow);
}

export async function listAdminWorkspaceToolCatalogWithDb(
  db: ToolCatalogDb,
  viewer: CatalogViewer,
): Promise<ToolCatalogItem[]> {
  if (viewer.role !== "admin") return [];
  const result = await db.query(`${SELECT_COLUMNS} ORDER BY c.updated_at DESC, c.name`);
  return result.rows.map(mapCatalogRow);
}

export async function getWorkspaceToolCatalogItemWithDb(
  db: ToolCatalogDb,
  viewer: CatalogViewer,
  slug: string,
): Promise<ToolCatalogItem | null> {
  const result = await db.query(`${SELECT_COLUMNS} WHERE c.slug = $1`, [slug]);
  const row = result.rows[0];
  if (!row) return null;
  const item = mapCatalogRow(row);
  if (item.lifecycleStatus === "archived" && item.ownerUserId !== viewer.id && viewer.role !== "admin") return null;
  return item;
}

export async function createToolCatalogItemWithDb(
  db: ToolCatalogDb,
  ownerUserId: string,
  submission: ToolCatalogSubmission,
): Promise<CatalogMutationResult> {
  if (PUBLIC_TOOL_CATALOG_SLUGS.has(submission.slug)) return { ok: false, reason: "slug-conflict" };
  try {
    const result = await db.query(
      `INSERT INTO tool_catalog_items
         (slug, name, description, kind, source_url, source_ref, supported_clients,
          required_env, network_hosts, install_notes, uninstall_notes, inventory_item_key,
          inventory_source_provider, trust_status, lifecycle_status, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'community', 'published',$14)
       RETURNING id, slug`,
      [...submissionParams(submission), ownerUserId],
    );
    const row = result.rows[0];
    return row
      ? { ok: true, id: String(row.id), slug: String(row.slug) }
      : { ok: false, reason: "forbidden-or-not-found" };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "slug-conflict" };
    throw error;
  }
}

export async function updateToolCatalogItemWithDb(
  db: ToolCatalogDb,
  ownerUserId: string,
  id: string,
  submission: ToolCatalogSubmission,
): Promise<CatalogMutationResult> {
  if (PUBLIC_TOOL_CATALOG_SLUGS.has(submission.slug)) return { ok: false, reason: "slug-conflict" };
  try {
    const result = await db.query(
      `UPDATE tool_catalog_items SET
         slug = $3, name = $4, description = $5, kind = $6, source_url = $7,
         source_ref = $8, supported_clients = $9, required_env = $10,
         network_hosts = $11, install_notes = $12, uninstall_notes = $13,
         inventory_item_key = $14, inventory_source_provider = $15,
         trust_status = 'community', updated_at = now()
       WHERE id = $1 AND owner_user_id = $2
       RETURNING id, slug`,
      [id, ownerUserId, ...submissionParams(submission)],
    );
    const row = result.rows[0];
    return row
      ? { ok: true, id: String(row.id), slug: String(row.slug) }
      : { ok: false, reason: "forbidden-or-not-found" };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "slug-conflict" };
    throw error;
  }
}

export async function archiveToolCatalogItemWithDb(
  db: ToolCatalogDb,
  ownerUserId: string,
  id: string,
): Promise<CatalogStatusResult> {
  const result = await db.query(
    `UPDATE tool_catalog_items
     SET lifecycle_status = 'archived', status_reason = NULL, updated_at = now()
     WHERE id = $1 AND owner_user_id = $2
     RETURNING id`,
    [id, ownerUserId],
  );
  return result.rows[0] ? { ok: true } : { ok: false, reason: "forbidden-or-not-found" };
}

export async function moderateToolCatalogItemWithDb(
  db: ToolCatalogDb,
  viewer: CatalogViewer,
  id: string,
  moderation: CatalogModeration,
): Promise<CatalogStatusResult> {
  if (viewer.role !== "admin") return { ok: false, reason: "forbidden" };
  const result = await db.query(
    `UPDATE tool_catalog_items
     SET trust_status = $2, lifecycle_status = $3, status_reason = $4, updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [id, moderation.trustStatus, moderation.lifecycleStatus, moderation.statusReason],
  );
  return result.rows[0] ? { ok: true } : { ok: false, reason: "not-found" };
}

export function listWorkspaceToolCatalog(viewer: CatalogViewer): Promise<ToolCatalogItem[]> {
  return listWorkspaceToolCatalogWithDb(getPool(), viewer);
}

export function listAdminWorkspaceToolCatalog(viewer: CatalogViewer): Promise<ToolCatalogItem[]> {
  return listAdminWorkspaceToolCatalogWithDb(getPool(), viewer);
}

export function getWorkspaceToolCatalogItem(viewer: CatalogViewer, slug: string): Promise<ToolCatalogItem | null> {
  return getWorkspaceToolCatalogItemWithDb(getPool(), viewer, slug);
}

export function createToolCatalogItem(ownerUserId: string, submission: ToolCatalogSubmission): Promise<CatalogMutationResult> {
  return createToolCatalogItemWithDb(getPool(), ownerUserId, submission);
}

export function updateToolCatalogItem(
  ownerUserId: string,
  id: string,
  submission: ToolCatalogSubmission,
): Promise<CatalogMutationResult> {
  return updateToolCatalogItemWithDb(getPool(), ownerUserId, id, submission);
}

export function archiveToolCatalogItem(ownerUserId: string, id: string): Promise<CatalogStatusResult> {
  return archiveToolCatalogItemWithDb(getPool(), ownerUserId, id);
}

export function moderateToolCatalogItem(
  viewer: CatalogViewer,
  id: string,
  moderation: CatalogModeration,
): Promise<CatalogStatusResult> {
  return moderateToolCatalogItemWithDb(getPool(), viewer, id, moderation);
}

export function composeToolCatalogItems(
  workspaceItems: readonly ToolCatalogItem[],
  viewer: CatalogViewer,
  filter: CatalogListFilter,
  inventories: readonly DeviceToolInventory[] | null,
): ToolCatalogListItem[] {
  return filterToolCatalogItems([...PUBLIC_TOOL_CATALOG, ...workspaceItems], {
    ...filter,
    viewerId: viewer.id,
  }).map((item) => ({
    ...item,
    installState: resolveCatalogInstallState(item, inventories),
  }));
}

export async function listToolCatalog(
  viewer: CatalogViewer,
  filter: CatalogListFilter,
): Promise<ToolCatalogListItem[]> {
  const [workspaceItems, inventories] = await Promise.all([
    listWorkspaceToolCatalog(viewer),
    getMyDeviceInventories(viewer.id).catch(() => null),
  ]);
  return composeToolCatalogItems(workspaceItems, viewer, filter, inventories);
}

export async function getToolCatalogItem(
  viewer: CatalogViewer,
  slug: string,
): Promise<ToolCatalogListItem | null> {
  const item = getPublicToolCatalogItem(slug) ?? (await getWorkspaceToolCatalogItem(viewer, slug));
  if (!item) return null;
  const inventories = await getMyDeviceInventories(viewer.id).catch(() => null);
  return { ...item, installState: resolveCatalogInstallState(item, inventories) };
}
