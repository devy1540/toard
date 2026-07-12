-- Up Migration

CREATE TABLE clickhouse_rollup_worker_status (
  worker TEXT PRIMARY KEY CHECK (worker IN ('usage_15m_v2', 'timezone')),
  paused BOOLEAN NOT NULL DEFAULT false,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_progress_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error TEXT,
  last_duration_ms BIGINT,
  last_processed_units INTEGER NOT NULL DEFAULT 0,
  last_processed_rows BIGINT NOT NULL DEFAULT 0,
  processed_units_total BIGINT NOT NULL DEFAULT 0,
  processed_rows_total BIGINT NOT NULL DEFAULT 0,
  throughput_units_per_minute DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO clickhouse_rollup_worker_status (worker)
VALUES ('usage_15m_v2'), ('timezone')
ON CONFLICT (worker) DO NOTHING;

-- Down Migration

DROP TABLE clickhouse_rollup_worker_status;
