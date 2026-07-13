-- Up Migration

CREATE TABLE clickhouse_rollup_cutover_status (
  layer TEXT PRIMARY KEY CHECK (layer IN ('usage_15m_v2', 'timezone')),
  state TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (state IN ('backfilling', 'observing', 'active', 'fallback')),
  target_watermark TIMESTAMPTZ,
  healthy_seconds INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  last_validation_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_kind TEXT CHECK (last_failure_kind IN ('mismatch', 'lag', 'unavailable')),
  last_failure TEXT,
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO clickhouse_rollup_cutover_status (layer)
VALUES ('usage_15m_v2'), ('timezone')
ON CONFLICT (layer) DO NOTHING;

ALTER TABLE clickhouse_rollup_worker_status
  ADD COLUMN adaptive_limit INTEGER NOT NULL DEFAULT 16,
  ADD COLUMN load_state TEXT NOT NULL DEFAULT 'normal'
    CHECK (load_state IN ('normal', 'throttled'));

UPDATE clickhouse_rollup_worker_status SET adaptive_limit = 8 WHERE worker = 'timezone';

-- Down Migration

ALTER TABLE clickhouse_rollup_worker_status
  DROP COLUMN load_state,
  DROP COLUMN adaptive_limit;

DROP TABLE clickhouse_rollup_cutover_status;
