-- Up Migration

ALTER TABLE pricing_repair_status
  ADD COLUMN reconciled_events BIGINT NOT NULL DEFAULT 0;

-- 가격 sync가 migration보다 먼저 끝난 기존 설치도 배포 직후 자동 복구를 시작한다.
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
WHERE singleton
  AND generation IS NULL;

-- Down Migration

ALTER TABLE pricing_repair_status
  DROP COLUMN reconciled_events;
