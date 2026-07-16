import { ToolWireParseError, type ToolActivityEvent, type ToolInventorySnapshot } from "@toard/core";
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
  const contentLength = req.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new RangeError(`payload too large (max ${maxBytes} bytes)`);
  }
  if (!req.body) return JSON.parse("");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let merged: Uint8Array | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new RangeError(`payload too large (max ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
    merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
    } catch {
      throw new SyntaxError("INVALID_JSON");
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    merged?.fill(0);
    reader.releaseLock();
  }
}

export function toolIngestClientError(error: unknown): Response | null {
  if (error instanceof RangeError) return new Response(error.message, { status: 413 });
  if (error instanceof ToolWireParseError) return new Response(error.message, { status: 400 });
  if (error instanceof SyntaxError) return new Response("본문이 유효한 JSON 이 아닙니다", { status: 400 });
  return null;
}
