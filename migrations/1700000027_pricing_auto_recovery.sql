-- Up Migration

CREATE TABLE pricing_repair_status (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  generation TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle', 'pending', 'running', 'waiting_for_catalog', 'failed')),
  target_to TIMESTAMPTZ,
  processed_events BIGINT NOT NULL DEFAULT 0,
  recovered_events BIGINT NOT NULL DEFAULT 0,
  remaining_unpriced_events BIGINT NOT NULL DEFAULT 0,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_error TEXT,
  adaptive_limit INTEGER NOT NULL DEFAULT 100,
  load_state TEXT NOT NULL DEFAULT 'normal'
    CHECK (load_state IN ('normal', 'throttled')),
  eligible_since TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO pricing_repair_status (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE clickhouse_rollup_scheduler_status
  DROP CONSTRAINT clickhouse_rollup_scheduler_status_last_selected_task_check;

ALTER TABLE clickhouse_rollup_scheduler_status
  ADD CONSTRAINT clickhouse_rollup_scheduler_status_last_selected_task_check
  CHECK (last_selected_task IN ('usage_15m_v2', 'timezone', 'validation', 'pricing_repair', 'idle'));

-- Down Migration

ALTER TABLE clickhouse_rollup_scheduler_status
  DROP CONSTRAINT clickhouse_rollup_scheduler_status_last_selected_task_check;

ALTER TABLE clickhouse_rollup_scheduler_status
  ADD CONSTRAINT clickhouse_rollup_scheduler_status_last_selected_task_check
  CHECK (last_selected_task IN ('usage_15m_v2', 'timezone', 'validation', 'idle'));

DROP TABLE pricing_repair_status;
