-- ClickHouse exact retry + dashboard rollup schema.
-- Existing deployments also run equivalent DDL at app startup because init scripts
-- do not rerun after the ClickHouse volume has been initialized.
-- Rollup rows are written by the app outbox worker with deterministic insert tokens.
-- Do not use a materialized-view trigger here: retry validation showed raw insert
-- deduplication does not reliably prevent dependent MV double-counting.

ALTER TABLE toard.usage_events
  MODIFY SETTING non_replicated_deduplication_window = 10000;

ALTER TABLE toard.usage_events
  ADD COLUMN IF NOT EXISTS pricing_revision_id String DEFAULT '' AFTER cost_usd;

ALTER TABLE toard.usage_events
  ADD COLUMN IF NOT EXISTS cost_status LowCardinality(String) DEFAULT 'legacy' AFTER pricing_revision_id;

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

CREATE TABLE IF NOT EXISTS toard.usage_15m_rollup
(
  bucket_15m            DateTime64(3, 'UTC'),
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
  cost_usd              Decimal(18, 8),
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(bucket_15m)
ORDER BY (bucket_15m, user_id, team_id, provider_key, model, host, session_id);

CREATE TABLE IF NOT EXISTS toard.usage_15m_rollup_v2
(
  bucket_15m            DateTime64(3, 'UTC'),
  provider_key          LowCardinality(String),
  user_id               String,
  team_id               String,
  session_id            String,
  model                 LowCardinality(String),
  host                  LowCardinality(String),
  pricing_revision_id   String,
  cost_status           LowCardinality(String),
  event_count           UInt64,
  input_tokens          UInt64,
  output_tokens         UInt64,
  cache_read_tokens     UInt64,
  cache_creation_tokens UInt64,
  cost_usd              Decimal(18, 8),
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(bucket_15m)
ORDER BY (bucket_15m, provider_key, user_id, team_id, session_id, model, host, pricing_revision_id, cost_status)
TTL toDateTime(bucket_15m) + INTERVAL 400 DAY DELETE;

CREATE TABLE IF NOT EXISTS toard.usage_hourly_timezone_rollup
(
  timezone              LowCardinality(String),
  bucket_start          DateTime64(3, 'UTC'),
  user_id               String,
  team_id               String,
  provider_key          LowCardinality(String),
  model                 LowCardinality(String),
  host                  LowCardinality(String),
  session_id            String,
  pricing_revision_id   String,
  cost_status           LowCardinality(String),
  event_count           UInt64,
  input_tokens          UInt64,
  output_tokens         UInt64,
  cache_read_tokens     UInt64,
  cache_creation_tokens UInt64,
  cost_usd              Decimal(18, 8),
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (timezone, bucket_start, user_id, team_id, provider_key, model, host, session_id, pricing_revision_id, cost_status)
TTL toDateTime(bucket_start) + INTERVAL 400 DAY DELETE;

CREATE TABLE IF NOT EXISTS toard.usage_daily_timezone_rollup
(
  timezone              LowCardinality(String),
  bucket_start          DateTime64(3, 'UTC'),
  user_id               String,
  team_id               String,
  provider_key          LowCardinality(String),
  model                 LowCardinality(String),
  host                  LowCardinality(String),
  session_id            String,
  pricing_revision_id   String,
  cost_status           LowCardinality(String),
  event_count           UInt64,
  input_tokens          UInt64,
  output_tokens         UInt64,
  cache_read_tokens     UInt64,
  cache_creation_tokens UInt64,
  cost_usd              Decimal(18, 8),
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (timezone, bucket_start, user_id, team_id, provider_key, model, host, session_id, pricing_revision_id, cost_status)
TTL toDateTime(bucket_start) + INTERVAL 400 DAY DELETE;
