import type { PeriodQuery } from "./storage";

export type ToolActivityKind = "mcp" | "skill";
export type ToolOutcome = "success" | "failure" | "unknown";
export type ToolDetection = "explicit" | "derived_load";
export type ToolInventoryKind = "mcp" | "skill" | "plugin";

export interface ToolActivityEvent {
  dedupKey: string;
  providerKey: string;
  sessionId: string | null;
  host: string | null;
  ts: Date;
  activityKind: ToolActivityKind;
  itemKey: string;
  displayName: string;
  pluginKey: string | null;
  outcome: ToolOutcome;
  detection: ToolDetection;
}

export interface ToolInventoryItem {
  kind: ToolInventoryKind;
  itemKey: string;
  displayName: string;
  sourceProvider: string;
  pluginKey: string | null;
  version: string | null;
  enabled: boolean;
}

export interface ToolInventorySnapshot {
  host: string | null;
  fingerprint: string;
  observedAt: Date;
  items: ToolInventoryItem[];
}

export interface ToolActivitySummary {
  mcpCalls: number;
  distinctSkills: number;
  distinctPlugins: number;
  failures: number;
  activeUsers?: number;
  activeDevices?: number;
}

export interface ToolActivityRow {
  activityKind: ToolActivityKind;
  itemKey: string;
  displayName: string;
  pluginKey: string | null;
  detection: ToolDetection;
  calls: number;
  successes: number;
  failures: number;
  unknown: number;
  lastActivityAt: Date;
  hosts: string[];
}

export interface ToolActivityQuery extends PeriodQuery {
  userId?: string;
}

export interface DeviceToolInventory {
  tokenId: string;
  host: string | null;
  fingerprint: string;
  observedAt: Date;
  receivedAt: Date;
  items: ToolInventoryItem[];
}
