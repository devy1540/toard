-- Up Migration

ALTER TABLE pricing_history_jobs
  ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 1
  CHECK (algorithm_version >= 1);

-- 새 소급 보정 알고리즘으로 기존 미확정·이전 가격 사용량을 다시 확인한다.
UPDATE pricing_repair_status
SET generation = now(),
    state = 'pending',
    target_to = now(),
    processed_events = 0,
    recovered_events = 0,
    reconciled_events = 0,
    repriced_legacy_events = 0,
    remaining_unpriced_events = 0,
    remaining_legacy_events = 0,
    unresolved_models = '[]'::jsonb,
    eligible_since = now(),
    next_attempt_at = now(),
    consecutive_failures = 0,
    last_error = NULL,
    updated_at = now()
WHERE singleton;

-- Down Migration

ALTER TABLE pricing_history_jobs
  DROP COLUMN algorithm_version;
