import type { CollectionHealthReport, CollectionState, CollectionErrorCode } from "@toard/core";
import type { Pool } from "pg";
import { getPool } from "./db";

export type CollectionHealthRow = {
  tokenId: string;
  computer: string | null;
  provider: string;
  lastStoredAt: Date | null;
  lastReportAt: Date | null;
  state: CollectionState | null;
  scannedFiles: number | null;
  parsedEvents: number | null;
  parseErrors: number | null;
  pendingEvents: number | null;
  errorCode: CollectionErrorCode | null;
};

export async function recordCollectionHealth(userId: string, tokenId: string, report: CollectionHealthReport, pool: Pick<Pool, "query"> = getPool()): Promise<number> {
  const rows = report.collectors.map((row) => ({
    provider_key: row.providerKey, scan_state: row.state,
    scanned_files: row.scannedFiles, parsed_events: row.parsedEvents,
    parse_errors: row.parseErrors, pending_events: row.pendingEvents, error_code: row.errorCode,
  }));
  const result = await pool.query(
    `INSERT INTO collection_provider_health
       (token_id, provider_key, last_scan_report_at, scan_state, scanned_files, parsed_events, parse_errors, pending_events, error_code)
     SELECT t.id, r.provider_key, clock_timestamp(), r.scan_state, r.scanned_files, r.parsed_events, r.parse_errors, r.pending_events, r.error_code
     FROM ingest_tokens t
     CROSS JOIN jsonb_to_recordset($3::jsonb) AS r(provider_key TEXT, scan_state TEXT, scanned_files INTEGER, parsed_events INTEGER, parse_errors INTEGER, pending_events INTEGER, error_code TEXT)
     WHERE t.id = $1 AND t.user_id = $2 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
     ORDER BY r.provider_key
     ON CONFLICT (token_id, provider_key) DO UPDATE SET
       last_scan_report_at = EXCLUDED.last_scan_report_at, scan_state = EXCLUDED.scan_state,
       scanned_files = EXCLUDED.scanned_files, parsed_events = EXCLUDED.parsed_events,
       parse_errors = EXCLUDED.parse_errors, pending_events = EXCLUDED.pending_events, error_code = EXCLUDED.error_code`,
    [tokenId, userId, JSON.stringify(rows)],
  );
  return result.rowCount ?? 0;
}

export async function getCollectionHealth(userId: string, pool: Pick<Pool, "query"> = getPool()): Promise<CollectionHealthRow[]> {
  const result = await pool.query(
    `SELECT t.id AS token_id, COALESCE(t.device_label, t.last_host) AS computer,
            p.display_name AS provider, h.last_usage_stored_at, h.last_scan_report_at,
            h.scan_state, h.scanned_files, h.parsed_events, h.parse_errors, h.pending_events, h.error_code
     FROM collection_provider_health h
     JOIN ingest_tokens t ON t.id = h.token_id
     JOIN providers p ON p.key = h.provider_key
     WHERE t.user_id = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
     ORDER BY t.created_at DESC, p.display_name LIMIT 500`, [userId],
  );
  return result.rows.map((row) => ({
    tokenId: row.token_id, computer: row.computer, provider: row.provider,
    lastStoredAt: row.last_usage_stored_at, lastReportAt: row.last_scan_report_at, state: row.scan_state,
    scannedFiles: row.scanned_files, parsedEvents: row.parsed_events, parseErrors: row.parse_errors,
    pendingEvents: row.pending_events, errorCode: row.error_code,
  }));
}
