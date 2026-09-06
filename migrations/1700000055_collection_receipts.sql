-- Up Migration

ALTER TABLE ingest_tokens
  ADD COLUMN first_usage_stored_at TIMESTAMPTZ,
  ADD COLUMN last_usage_stored_at TIMESTAMPTZ,
  ADD COLUMN last_usage_count INTEGER NOT NULL DEFAULT 0 CHECK (last_usage_count >= 0);

CREATE TABLE collection_provider_health (
  token_id UUID NOT NULL REFERENCES ingest_tokens(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL REFERENCES providers(key),
  first_usage_stored_at TIMESTAMPTZ,
  last_usage_stored_at TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ,
  last_usage_count INTEGER NOT NULL DEFAULT 0 CHECK (last_usage_count >= 0),
  last_scan_report_at TIMESTAMPTZ,
  scan_state TEXT CHECK (scan_state IN ('ok', 'no_records', 'error', 'unsupported', 'paused')),
  scanned_files INTEGER CHECK (scanned_files >= 0),
  parsed_events INTEGER CHECK (parsed_events >= 0),
  parse_errors INTEGER CHECK (parse_errors >= 0),
  pending_events INTEGER CHECK (pending_events >= 0),
  error_code TEXT CHECK (error_code IN ('read_failed', 'parse_failed', 'queue_full', 'transport_failed', 'unsupported_schema', 'unknown')),
  PRIMARY KEY (token_id, provider_key)
);

-- Called by the storage backend inside its usage/outbox transaction. Authentication
-- alone, empty batches, foreign dedup collisions and failed transactions cannot
-- establish a successful usage receipt.
CREATE FUNCTION record_ingest_usage_receipt(
  requested_token UUID, requested_user UUID, storage_kind TEXT, requested_keys TEXT[]
) RETURNS INTEGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public AS $$
DECLARE
  accepted RECORD;
  accepted_count INTEGER := 0;
  stored_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF storage_kind NOT IN ('postgres', 'clickhouse') THEN
    RAISE EXCEPTION 'invalid receipt storage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ingest_tokens WHERE id = requested_token AND user_id = requested_user) THEN
    RAISE EXCEPTION 'receipt token owner mismatch';
  END IF;
  FOR accepted IN
    SELECT provider_key, count(*)::INTEGER AS records, max(ts) AS last_event_at
    FROM (
      SELECT provider_key, ts FROM public.usage_events
      WHERE storage_kind = 'postgres' AND user_id = requested_user AND dedup_key = ANY(requested_keys)
      UNION ALL
      SELECT provider_key, ts FROM public.clickhouse_usage_outbox
      WHERE storage_kind = 'clickhouse' AND user_id = requested_user AND dedup_key = ANY(requested_keys)
    ) own_events GROUP BY provider_key ORDER BY provider_key
  LOOP
    accepted_count := accepted_count + accepted.records;
    INSERT INTO public.collection_provider_health
      (token_id, provider_key, first_usage_stored_at, last_usage_stored_at, last_event_at, last_usage_count)
    VALUES (requested_token, accepted.provider_key, stored_at, stored_at, accepted.last_event_at, accepted.records)
    ON CONFLICT (token_id, provider_key) DO UPDATE SET
      first_usage_stored_at = COALESCE(collection_provider_health.first_usage_stored_at, stored_at),
      last_usage_stored_at = stored_at,
      last_event_at = GREATEST(collection_provider_health.last_event_at, EXCLUDED.last_event_at),
      last_usage_count = EXCLUDED.last_usage_count;
  END LOOP;
  IF accepted_count > 0 THEN
    UPDATE public.ingest_tokens
    SET first_usage_stored_at = COALESCE(first_usage_stored_at, stored_at),
        last_usage_stored_at = stored_at, last_usage_count = accepted_count
    WHERE id = requested_token AND user_id = requested_user;
  END IF;
  RETURN accepted_count;
END $$;
REVOKE ALL ON FUNCTION record_ingest_usage_receipt(UUID, UUID, TEXT, TEXT[]) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    GRANT SELECT, INSERT, UPDATE ON collection_provider_health TO toard_app;
    GRANT EXECUTE ON FUNCTION record_ingest_usage_receipt(UUID, UUID, TEXT, TEXT[]) TO toard_app;
  END IF;
END $$;

-- Down Migration
DO $$ BEGIN
  RAISE EXCEPTION 'collection receipt evidence is forward-only; an older app may ignore the added fields';
END $$;
