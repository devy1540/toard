import { WireParseError } from "./wire";

export const COLLECTION_STATES = ["ok", "no_records", "error", "unsupported", "paused"] as const;
export const COLLECTION_ERROR_CODES = ["read_failed", "parse_failed", "queue_full", "transport_failed", "unsupported_schema", "unknown"] as const;
export type CollectionState = typeof COLLECTION_STATES[number];
export type CollectionErrorCode = typeof COLLECTION_ERROR_CODES[number];
export type CollectorHealth = {
  providerKey: string;
  state: CollectionState;
  scannedFiles: number | null;
  parsedEvents: number | null;
  parseErrors: number | null;
  pendingEvents: number | null;
  errorCode: CollectionErrorCode | null;
};
export type CollectionHealthReport = { schemaVersion: 1; host: string | null; collectors: CollectorHealth[] };

function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new WireParseError("invalid collection health report");
  return value as Record<string, unknown>;
}
function knownKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new WireParseError("unsupported collection health field");
}
function count(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) throw new WireParseError("invalid collection health count");
  return value;
}

/** Deliberately closed metadata-only contract: no raw logs, arguments or paths. */
export function parseCollectionHealthReport(value: unknown): CollectionHealthReport {
  const report = object(value);
  knownKeys(report, ["schemaVersion", "host", "collectors"]);
  if (report.schemaVersion !== 1 || !Array.isArray(report.collectors) || report.collectors.length > 32) throw new WireParseError("unsupported collection health schema");
  if (report.host != null && (typeof report.host !== "string" || report.host.length > 255 || /[\x00-\x1f\x7f]/.test(report.host) || /^(?:[/\\]|[a-z]:[/\\]|~[/\\])/i.test(report.host))) throw new WireParseError("invalid collection host label");
  const seen = new Set<string>();
  const collectors = report.collectors.map((input) => {
    const row = object(input);
    knownKeys(row, ["providerKey", "state", "scannedFiles", "parsedEvents", "parseErrors", "pendingEvents", "errorCode"]);
    if (typeof row.providerKey !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.providerKey) || seen.has(row.providerKey)) throw new WireParseError("invalid or repeated collection provider");
    seen.add(row.providerKey);
    if (!COLLECTION_STATES.includes(row.state as CollectionState)) throw new WireParseError("invalid collection state");
    if (row.errorCode != null && !COLLECTION_ERROR_CODES.includes(row.errorCode as CollectionErrorCode)) throw new WireParseError("invalid collection error code");
    const parsed: CollectorHealth = {
      providerKey: row.providerKey, state: row.state as CollectionState,
      scannedFiles: count(row.scannedFiles), parsedEvents: count(row.parsedEvents),
      parseErrors: count(row.parseErrors), pendingEvents: count(row.pendingEvents),
      errorCode: row.errorCode as CollectionErrorCode | null ?? null,
    };
    if ((parsed.parseErrors ?? 0) > 0 && parsed.state === "ok") throw new WireParseError("inconsistent collection health report");
    return parsed;
  });
  return { schemaVersion: 1, host: report.host as string | null ?? null, collectors };
}
