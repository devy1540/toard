-- Up Migration

-- Keep historical amounts intact and distinguish the calculator that produced them.
-- Old writers also retain cost-v1 rather than mislabelling their output as cost-v2.
ALTER TABLE pricing_revisions
  ADD COLUMN pricing_details JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(pricing_details) = 'object');
ALTER TABLE pricing_history_candidates
  ADD COLUMN pricing_details JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(pricing_details) = 'object');

ALTER TABLE usage_events
  ADD COLUMN cost_calculation_version TEXT NOT NULL DEFAULT 'cost-v1',
  ADD COLUMN cache_creation_1h_tokens BIGINT,
  ADD COLUMN is_fast BOOLEAN,
  DROP CONSTRAINT usage_events_cost_status_check,
  ADD CONSTRAINT usage_events_cost_status_check CHECK (cost_status IN ('priced', 'estimated', 'unpriced', 'legacy')),
  ADD CONSTRAINT usage_events_cache_1h_check CHECK (cache_creation_1h_tokens >= 0 AND cache_creation_1h_tokens <= cache_creation_tokens);

ALTER TABLE clickhouse_usage_outbox
  ADD COLUMN cost_calculation_version TEXT NOT NULL DEFAULT 'cost-v1',
  ADD COLUMN cache_creation_1h_tokens BIGINT,
  ADD COLUMN is_fast BOOLEAN,
  DROP CONSTRAINT clickhouse_usage_outbox_cost_status_check,
  ADD CONSTRAINT clickhouse_usage_outbox_cost_status_check CHECK (cost_status IN ('priced', 'estimated', 'unpriced', 'legacy')),
  ADD CONSTRAINT clickhouse_usage_outbox_cache_1h_check CHECK (cache_creation_1h_tokens >= 0 AND cache_creation_1h_tokens <= cache_creation_tokens);

-- Previous seed.ts labelled illustrative, backdated prices as observed LiteLLM data.
-- Keep referenced rows for audit, but never select these fixtures for new calculations.
UPDATE pricing_revisions SET authoritative = FALSE
WHERE source = 'litellm' AND effective_at = TIMESTAMPTZ '2025-01-01T00:00:00Z'
  AND ((model_id = 'claude-sonnet-4-5' AND input_price_per_mtok = 3 AND output_price_per_mtok = 15)
    OR (model_id = 'claude-opus-4-5' AND input_price_per_mtok = 15 AND output_price_per_mtok = 75));

-- The first new pricing sync must fetch the newly supported context tiers even if
-- the old process already synced this calendar day. Keep all old price snapshots.
UPDATE app_settings SET value = value - 'day', updated_at = now() WHERE key = 'pricing_sync_status';
INSERT INTO app_settings(key, value, updated_at)
VALUES ('pricing_cache_version', jsonb_build_object('updatedAt', clock_timestamp()::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- Down Migration
-- Do not silently discard calculator evidence or downgrade estimated rows.
DO $$ BEGIN
  RAISE EXCEPTION 'cost calculation evidence is forward-only; restore a pre-upgrade backup to downgrade';
END $$;
