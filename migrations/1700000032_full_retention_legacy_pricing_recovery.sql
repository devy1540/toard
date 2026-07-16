-- Up Migration

ALTER TABLE pricing_repair_status
  ADD COLUMN repriced_legacy_events BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN remaining_legacy_events BIGINT NOT NULL DEFAULT 0;

-- 기존 보존 데이터의 legacy 비용을 권위 있는 시점별 가격으로 자동 복구한다.
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

ALTER TABLE pricing_repair_status
  DROP COLUMN remaining_legacy_events,
  DROP COLUMN repriced_legacy_events;
