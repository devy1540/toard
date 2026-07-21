-- Up Migration

-- 가격 원본 보정과 15분 compactor가 경합해 남긴 stale 가격 rollup을 자동 탐지한다.
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

SELECT 1;
