-- Up Migration

CREATE TABLE IF NOT EXISTS clickhouse_rollup_watermarks (
  name TEXT PRIMARY KEY,
  watermark TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clickhouse_rollup_dirty_buckets (
  name TEXT NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name, bucket)
);

-- Down Migration

DROP TABLE IF EXISTS clickhouse_rollup_dirty_buckets;
DROP TABLE IF EXISTS clickhouse_rollup_watermarks;
