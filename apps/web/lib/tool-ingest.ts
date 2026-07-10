import type { ToolActivityEvent, ToolInventorySnapshot } from "@toard/core";
import type { IngestAuthResult } from "./ingest-auth";
import { sanitizeHost } from "./sanitize";
import { insertToolActivity, replaceDeviceInventory } from "./tool-metadata";

export type OwnedToolActivity = ToolActivityEvent & { userId: string; ingestTokenId: string };
export type OwnedToolInventory = ToolInventorySnapshot & { userId: string; ingestTokenId: string };

export function finalizeToolActivity(auth: IngestAuthResult, events: ToolActivityEvent[]): OwnedToolActivity[] {
  return events.map((event) => ({
    dedupKey: event.dedupKey,
    providerKey: event.providerKey,
    sessionId: event.sessionId,
    host: sanitizeHost(event.host),
    ts: event.ts,
    activityKind: event.activityKind,
    itemKey: event.itemKey,
    displayName: event.displayName,
    pluginKey: event.pluginKey,
    outcome: event.outcome,
    detection: event.detection,
    userId: auth.userId,
    ingestTokenId: auth.tokenId,
  }));
}

export function finalizeToolInventory(auth: IngestAuthResult, snapshot: ToolInventorySnapshot): OwnedToolInventory {
  return {
    host: sanitizeHost(snapshot.host),
    fingerprint: snapshot.fingerprint,
    observedAt: snapshot.observedAt,
    items: snapshot.items.map((item) => ({
      kind: item.kind,
      itemKey: item.itemKey,
      displayName: item.displayName,
      sourceProvider: item.sourceProvider,
      pluginKey: item.pluginKey,
      version: item.version,
      enabled: item.enabled,
    })),
    userId: auth.userId,
    ingestTokenId: auth.tokenId,
  };
}

export async function ingestToolActivity(auth: IngestAuthResult, events: ToolActivityEvent[]) {
  const finalized = finalizeToolActivity(auth, events);
  return insertToolActivity(auth, finalized);
}

export async function ingestToolInventory(auth: IngestAuthResult, snapshot: ToolInventorySnapshot) {
  const finalized = finalizeToolInventory(auth, snapshot);
  return replaceDeviceInventory(auth, finalized);
}

export async function readBoundedJson(req: Request, maxBytes: number): Promise<unknown> {
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new RangeError(`payload too large (max ${maxBytes} bytes)`);
  return JSON.parse(text);
}
