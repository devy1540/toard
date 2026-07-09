-- ClickHouse exact retry + dashboard rollup schema.
-- Existing deployments also run equivalent DDL at app startup because init scripts
-- do not rerun after the ClickHouse volume has been initialized.
-- Rollup rows are written by the app outbox worker with deterministic insert tokens.
-- Do not use a materialized-view trigger here: retry validation showed raw insert
-- deduplication does not reliably prevent dependent MV double-counting.

ALTER TABLE toard.usage_events
  MODIFY SETTING non_replicated_deduplication_window = 10000;

DROP VIEW IF EXISTS toard.usage_hourly_rollup_mv;

CREATE TABLE IF NOT EXISTS toard.usage_hourly_rollup
(
  bucket_hour           DateTime64(3, 'UTC'),
  provider_key          LowCardinality(String),
  user_id               String,
  team_id               String,
  session_id            String,
  model                 LowCardinality(String),
  host                  LowCardinality(String),
  event_count           UInt64,
  input_tokens          UInt64,
  output_tokens         UInt64,
  cache_read_tokens     UInt64,
  cache_creation_tokens UInt64,
  cost_usd              Decimal(18, 8)
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket_hour)
ORDER BY (bucket_hour, user_id, team_id, provider_key, model, host, session_id)
SETTINGS non_replicated_deduplication_window = 10000;

ALTER TABLE toard.usage_hourly_rollup
  MODIFY SETTING non_replicated_deduplication_window = 10000;
