-- Up Migration

-- Codex의 내부 auto-review 별칭과 초기 무모델 로그를 새 가격 해석 규칙으로 즉시 다시 확인한다.
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
