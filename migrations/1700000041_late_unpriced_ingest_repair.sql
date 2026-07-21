-- Up Migration

ALTER TABLE pricing_repair_status
  ADD COLUMN queued_target_to TIMESTAMPTZ;

CREATE FUNCTION enqueue_pricing_repair(requested_to TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE pricing_repair_status
  SET generation = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN requested_to
        ELSE generation
      END,
      state = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 'pending'
        ELSE state
      END,
      target_to = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN requested_to
        ELSE target_to
      END,
      queued_target_to = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN NULL
        ELSE GREATEST(COALESCE(queued_target_to, requested_to), requested_to)
      END,
      processed_events = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0
        ELSE processed_events
      END,
      recovered_events = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0
        ELSE recovered_events
      END,
      reconciled_events = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0
        ELSE reconciled_events
      END,
      repriced_legacy_events = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0
        ELSE repriced_legacy_events
      END,
      remaining_unpriced_events = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0
        ELSE remaining_unpriced_events
      END,
      remaining_legacy_events = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0
        ELSE remaining_legacy_events
      END,
      unresolved_models = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN '[]'::jsonb
        ELSE unresolved_models
      END,
      eligible_since = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN requested_to
        ELSE eligible_since
      END,
      next_attempt_at = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN requested_to
        ELSE next_attempt_at
      END,
      consecutive_failures = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0
        ELSE consecutive_failures
      END,
      last_error = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN NULL
        ELSE last_error
      END,
      updated_at = GREATEST(updated_at, requested_to)
  WHERE singleton;
END;
$$;

-- 업그레이드 전에 늦게 수집돼 남아 있는 미확정 사용량도 자동으로 다시 확인한다.
SELECT enqueue_pricing_repair(clock_timestamp());

-- Down Migration

DROP FUNCTION enqueue_pricing_repair(TIMESTAMPTZ);

ALTER TABLE pricing_repair_status
  DROP COLUMN queued_target_to;
