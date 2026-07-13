-- Up Migration

ALTER TABLE clickhouse_timezone_rollup_jobs
  ADD COLUMN source_to TIMESTAMPTZ,
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 0;

UPDATE clickhouse_timezone_rollup_jobs
SET source_to = CASE
  WHEN resolution = 'hour' THEN bucket + INTERVAL '1 hour'
  ELSE (((bucket AT TIME ZONE timezone)::date + 1)::timestamp AT TIME ZONE timezone)
END;

ALTER TABLE clickhouse_timezone_rollup_jobs
  ALTER COLUMN source_to SET NOT NULL;

ALTER TABLE clickhouse_rollup_worker_status
  ADD COLUMN eligible_since TIMESTAMPTZ,
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE TABLE clickhouse_rollup_scheduler_status (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_heartbeat_at TIMESTAMPTZ,
  last_selected_task TEXT
    CHECK (last_selected_task IN ('usage_15m_v2', 'timezone', 'validation', 'idle')),
  last_task_started_at TIMESTAMPTZ,
  last_task_finished_at TIMESTAMPTZ,
  last_task_outcome TEXT
    CHECK (last_task_outcome IN ('success', 'failed', 'superseded', 'idle')),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO clickhouse_rollup_scheduler_status (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- Down Migration

DROP TABLE clickhouse_rollup_scheduler_status;

ALTER TABLE clickhouse_rollup_worker_status
  DROP COLUMN consecutive_failures,
  DROP COLUMN next_attempt_at,
  DROP COLUMN eligible_since;

ALTER TABLE clickhouse_timezone_rollup_jobs
  DROP COLUMN generation,
  DROP COLUMN source_to;
