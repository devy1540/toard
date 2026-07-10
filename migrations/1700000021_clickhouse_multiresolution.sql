-- Up Migration

ALTER TABLE clickhouse_usage_outbox ADD COLUMN pricing_revision_id UUID;
ALTER TABLE clickhouse_usage_outbox ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (cost_status IN ('priced', 'unpriced', 'legacy'));

-- Down Migration

ALTER TABLE clickhouse_usage_outbox DROP COLUMN cost_status;
ALTER TABLE clickhouse_usage_outbox DROP COLUMN pricing_revision_id;
