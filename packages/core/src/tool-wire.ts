import type {
  ToolActivityEvent,
  ToolActivityKind,
  ToolDetection,
  ToolInventoryItem,
  ToolInventoryKind,
  ToolInventorySnapshot,
  ToolOutcome,
} from "./tool-metadata";

const ACTIVITY_KEYS = new Set([
  "dedupKey",
  "providerKey",
  "sessionId",
  "host",
  "ts",
  "activityKind",
  "itemKey",
  "displayName",
  "pluginKey",
  "outcome",
  "detection",
]);
const INVENTORY_KEYS = new Set(["host", "fingerprint", "observedAt", "items"]);
const INVENTORY_ITEM_KEYS = new Set([
  "kind",
  "itemKey",
  "displayName",
  "sourceProvider",
  "pluginKey",
  "version",
  "enabled",
]);

export class ToolWireParseError extends Error {
  constructor(message: string, public readonly index?: number) {
    super(index === undefined ? message : `items[${index}]: ${message}`);
    this.name = "ToolWireParseError";
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolWireParseError(`${field} 는 객체여야 합니다`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  if (key) throw new ToolWireParseError(`허용되지 않은 필드: ${key}`);
}

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > max) {
    throw new ToolWireParseError(`${field} 는 1~${max}자 문자열이어야 합니다`);
  }
  return value;
}

function nullableText(value: unknown, field: string, max = 200): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field, max);
}

function date(value: unknown, field: string): Date {
  const raw = text(value, field, 100);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new ToolWireParseError(`${field} 는 유효한 ISO 8601 이어야 합니다`);
  return parsed;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ToolWireParseError(`${field} 는 ${allowed.join(" | ")} 중 하나여야 합니다`);
  }
  return value as T;
}

function parseActivity(value: unknown): ToolActivityEvent {
  const item = record(value, "activity");
  rejectUnknown(item, ACTIVITY_KEYS);
  const dedupKey = text(item.dedupKey, "dedupKey", 64);
  if (!/^[a-f0-9]{64}$/.test(dedupKey)) {
    throw new ToolWireParseError("dedupKey 는 64자 lowercase hex 이어야 합니다");
  }
  return {
    dedupKey,
    providerKey: text(item.providerKey, "providerKey", 100),
    sessionId: nullableText(item.sessionId, "sessionId", 500),
    host: nullableText(item.host, "host", 255),
    ts: date(item.ts, "ts"),
    activityKind: oneOf<ToolActivityKind>(item.activityKind, "activityKind", ["mcp", "skill"]),
    itemKey: text(item.itemKey, "itemKey"),
    displayName: text(item.displayName, "displayName"),
    pluginKey: nullableText(item.pluginKey, "pluginKey"),
    outcome: oneOf<ToolOutcome>(item.outcome, "outcome", ["success", "failure", "unknown"]),
    detection: oneOf<ToolDetection>(item.detection, "detection", ["explicit", "derived_load"]),
  };
}

export function parseToolActivityBody(value: unknown): ToolActivityEvent[] {
  if (!Array.isArray(value)) throw new ToolWireParseError("본문은 activity 배열이어야 합니다");
  if (value.length > 500) throw new ToolWireParseError("activity 배치는 최대 500건입니다");
  return value.map((item, index) => {
    try {
      return parseActivity(item);
    } catch (error) {
      if (error instanceof ToolWireParseError && error.index === undefined) {
        throw new ToolWireParseError(error.message, index);
      }
      throw error;
    }
  });
}

function parseInventoryItem(value: unknown, index: number): ToolInventoryItem {
  try {
    const item = record(value, "inventory item");
    rejectUnknown(item, INVENTORY_ITEM_KEYS);
    if (typeof item.enabled !== "boolean") throw new ToolWireParseError("enabled 는 boolean 이어야 합니다");
    return {
      kind: oneOf<ToolInventoryKind>(item.kind, "kind", ["mcp", "skill", "plugin"]),
      itemKey: text(item.itemKey, "itemKey"),
      displayName: text(item.displayName, "displayName"),
      sourceProvider: text(item.sourceProvider, "sourceProvider", 100),
      pluginKey: nullableText(item.pluginKey, "pluginKey"),
      version: nullableText(item.version, "version", 100),
      enabled: item.enabled,
    };
  } catch (error) {
    if (error instanceof ToolWireParseError && error.index === undefined) {
      throw new ToolWireParseError(error.message, index);
    }
    throw error;
  }
}

export function parseToolInventoryBody(value: unknown): ToolInventorySnapshot {
  const snapshot = record(value, "inventory");
  rejectUnknown(snapshot, INVENTORY_KEYS);
  const fingerprint = text(snapshot.fingerprint, "fingerprint", 64);
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new ToolWireParseError("fingerprint 는 64자 lowercase hex 이어야 합니다");
  }
  if (!Array.isArray(snapshot.items)) throw new ToolWireParseError("items 는 배열이어야 합니다");
  if (snapshot.items.length > 2000) throw new ToolWireParseError("inventory items 는 최대 2000건입니다");
  return {
    host: nullableText(snapshot.host, "host", 255),
    fingerprint,
    observedAt: date(snapshot.observedAt, "observedAt"),
    items: snapshot.items.map(parseInventoryItem),
  };
}
