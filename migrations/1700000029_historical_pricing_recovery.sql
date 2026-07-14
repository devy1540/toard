-- Up Migration

ALTER TABLE pricing_revisions
  ADD COLUMN authoritative BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN valid_until TIMESTAMPTZ,
  ADD COLUMN source_ref TEXT,
  ADD COLUMN source_model_id TEXT,
  ADD CONSTRAINT pricing_revisions_valid_window_check
    CHECK (valid_until IS NULL OR valid_until > effective_at);

-- 최초 관측 가격을 과거 전체에 추정 적용한 revision은 신규 계산에서 제외한다.
UPDATE pricing_revisions
SET authoritative = FALSE
WHERE source = 'litellm-bootstrap';

-- 배포 직후 기존 unpriced와 비권위 bootstrap 비용을 자동으로 다시 확인한다.
UPDATE pricing_repair_status
SET generation = now(),
    state = 'pending',
    target_to = now(),
    processed_events = 0,
    recovered_events = 0,
    reconciled_events = 0,
    remaining_unpriced_events = 0,
    unresolved_models = '[]'::jsonb,
    eligible_since = now(),
    next_attempt_at = now(),
    consecutive_failures = 0,
    last_error = NULL,
    updated_at = now()
WHERE singleton;

CREATE TABLE pricing_history_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'listing', 'fetching', 'promoting',
    'completed', 'waiting_source', 'failed'
  )),
  range_from TIMESTAMPTZ NOT NULL,
  range_to TIMESTAMPTZ NOT NULL,
  models JSONB NOT NULL,
  commit_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  list_page INTEGER NOT NULL DEFAULT 0,
  next_commit_index INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  rate_limit_reset_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (range_to > range_from),
  CHECK (jsonb_typeof(models) = 'array'),
  CHECK (jsonb_typeof(commit_refs) = 'array'),
  CHECK (list_page >= 0),
  CHECK (next_commit_index >= 0)
);

CREATE UNIQUE INDEX pricing_history_one_active_job
  ON pricing_history_jobs ((TRUE))
  WHERE state <> 'completed';

CREATE TABLE pricing_history_candidates (
  job_id UUID NOT NULL REFERENCES pricing_history_jobs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  source_model_id TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  input_price_per_mtok NUMERIC NOT NULL,
  output_price_per_mtok NUMERIC NOT NULL,
  cache_read_price_per_mtok NUMERIC,
  cache_creation_price_per_mtok NUMERIC,
  input_price_above_200k_per_mtok NUMERIC,
  output_price_above_200k_per_mtok NUMERIC,
  fast_multiplier NUMERIC NOT NULL DEFAULT 1,
  source_commit_sha TEXT NOT NULL,
  source_committed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_id, model_id, effective_at),
  CHECK (valid_until IS NULL OR valid_until > effective_at),
  CHECK (source_commit_sha ~ '^[0-9a-fA-F]{40}$')
);

-- Down Migration

DROP TABLE pricing_history_candidates;
DROP TABLE pricing_history_jobs;

ALTER TABLE pricing_revisions
  DROP CONSTRAINT pricing_revisions_valid_window_check,
  DROP COLUMN source_model_id,
  DROP COLUMN source_ref,
  DROP COLUMN valid_until,
  DROP COLUMN authoritative;
