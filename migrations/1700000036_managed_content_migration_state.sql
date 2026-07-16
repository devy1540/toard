-- Up Migration

ALTER TABLE content_accounts
  DROP CONSTRAINT content_accounts_state_check;
ALTER TABLE content_accounts
  ADD CONSTRAINT content_accounts_state_check
  CHECK (state IN ('pending', 'active', 'migrated'));

CREATE TABLE content_e2ee_migrations (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state                TEXT NOT NULL DEFAULT 'pending',
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  blocked_at           TIMESTAMPTZ,
  blocked_reason       TEXT,
  last_error_code      TEXT,
  -- Down 시 기존 E2EE 전환과 신규 managed 행을 구분하기 위한 비민감 provenance다.
  source_e2ee_records  BIGINT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_e2ee_migrations_state_check
    CHECK (state IN ('pending', 'running', 'blocked', 'complete')),
  CONSTRAINT content_e2ee_migrations_state_timestamps_check CHECK (
    (state <> 'running' OR started_at IS NOT NULL)
    AND (state = 'complete') = (completed_at IS NOT NULL)
    AND (state <> 'complete' OR started_at IS NOT NULL)
  ),
  CONSTRAINT content_e2ee_migrations_blocked_fields_check CHECK (
    (state = 'blocked') = (blocked_at IS NOT NULL)
    AND (state = 'blocked') = (blocked_reason IS NOT NULL)
    AND (blocked_reason IS NULL OR blocked_reason = 'key_unavailable')
  ),
  CONSTRAINT content_e2ee_migrations_last_error_code_check
    CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 80),
  CONSTRAINT content_e2ee_migrations_timestamp_order_check CHECK (
    (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    AND (blocked_at IS NULL OR started_at IS NULL OR blocked_at >= started_at)
    AND (started_at IS NULL OR updated_at >= started_at)
    AND (completed_at IS NULL OR updated_at >= completed_at)
    AND (blocked_at IS NULL OR updated_at >= blocked_at)
  ),
  CONSTRAINT content_e2ee_migrations_source_count_check
    CHECK (source_e2ee_records >= 0)
);

WITH active_accounts AS (
  SELECT
    account.user_id,
    COUNT(record.id) FILTER (WHERE record.encryption_scheme = 'e2ee_v1') AS source_e2ee_records,
    statement_timestamp() AS observed_at
  FROM content_accounts account
  LEFT JOIN prompt_records record ON record.user_id = account.user_id
  WHERE account.state = 'active'
  GROUP BY account.user_id
)
INSERT INTO content_e2ee_migrations (
  user_id,
  state,
  started_at,
  completed_at,
  source_e2ee_records,
  updated_at
)
SELECT
  user_id,
  CASE WHEN source_e2ee_records > 0 THEN 'pending' ELSE 'complete' END,
  CASE WHEN source_e2ee_records = 0 THEN observed_at END,
  CASE WHEN source_e2ee_records = 0 THEN observed_at END,
  source_e2ee_records,
  observed_at
FROM active_accounts;

ALTER TABLE content_e2ee_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_e2ee_migrations FORCE ROW LEVEL SECURITY;

CREATE POLICY content_e2ee_migrations_owner_select ON content_e2ee_migrations
  FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_e2ee_migrations_owner_insert ON content_e2ee_migrations
  FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_e2ee_migrations_owner_update ON content_e2ee_migrations
  FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE content_encryption_status
  ADD COLUMN e2ee_migration_pending BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN e2ee_migration_blocked BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT content_encryption_status_e2ee_migration_pending_check
    CHECK (e2ee_migration_pending >= 0),
  ADD CONSTRAINT content_encryption_status_e2ee_migration_blocked_check
    CHECK (e2ee_migration_blocked >= 0);

UPDATE content_encryption_status
SET e2ee_migration_pending = (
      SELECT COUNT(*) FROM content_e2ee_migrations WHERE state IN ('pending', 'running')
    ),
    e2ee_migration_blocked = (
      SELECT COUNT(*) FROM content_e2ee_migrations WHERE state = 'blocked'
    ),
    updated_at = now()
WHERE singleton = TRUE;

CREATE FUNCTION sync_content_e2ee_migration_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  pending_delta BIGINT := 0;
  blocked_delta BIGINT := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IN ('pending', 'running') THEN pending_delta := 1; END IF;
    IF NEW.state = 'blocked' THEN blocked_delta := 1; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.state IN ('pending', 'running') THEN pending_delta := -1; END IF;
    IF OLD.state = 'blocked' THEN blocked_delta := -1; END IF;
  ELSE
    IF OLD.state IN ('pending', 'running') THEN pending_delta := pending_delta - 1; END IF;
    IF OLD.state = 'blocked' THEN blocked_delta := blocked_delta - 1; END IF;
    IF NEW.state IN ('pending', 'running') THEN pending_delta := pending_delta + 1; END IF;
    IF NEW.state = 'blocked' THEN blocked_delta := blocked_delta + 1; END IF;
  END IF;

  IF pending_delta <> 0 OR blocked_delta <> 0 THEN
    UPDATE content_encryption_status
       SET e2ee_migration_pending = e2ee_migration_pending + pending_delta,
           e2ee_migration_blocked = e2ee_migration_blocked + blocked_delta,
           updated_at = clock_timestamp()
     WHERE singleton = TRUE;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER content_e2ee_migrations_encryption_status
AFTER INSERT OR DELETE OR UPDATE OF state ON content_e2ee_migrations
FOR EACH ROW EXECUTE FUNCTION sync_content_e2ee_migration_status();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON content_e2ee_migrations TO toard_app';
  END IF;
END $$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM content_e2ee_migrations WHERE state IN ('running', 'blocked')
  ) THEN
    RAISE EXCEPTION 'migration 36 rollback blocked: E2EE migration is running or blocked';
  END IF;

  IF EXISTS (SELECT 1 FROM content_accounts WHERE state = 'migrated') THEN
    RAISE EXCEPTION 'migration 36 rollback blocked: migrated content account exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM content_e2ee_migrations migration
    WHERE migration.state = 'complete'
      AND migration.source_e2ee_records > 0
      AND EXISTS (
        SELECT 1
        FROM prompt_records record
        WHERE record.user_id = migration.user_id
          AND record.encryption_scheme = 'managed_v1'
      )
  ) THEN
    RAISE EXCEPTION 'migration 36 rollback blocked: converted E2EE content exists';
  END IF;
END $$;

DROP TRIGGER IF EXISTS content_e2ee_migrations_encryption_status ON content_e2ee_migrations;
DROP FUNCTION IF EXISTS sync_content_e2ee_migration_status();
ALTER TABLE content_encryption_status
  DROP COLUMN IF EXISTS e2ee_migration_pending,
  DROP COLUMN IF EXISTS e2ee_migration_blocked;

DROP POLICY IF EXISTS content_e2ee_migrations_owner_select ON content_e2ee_migrations;
DROP POLICY IF EXISTS content_e2ee_migrations_owner_insert ON content_e2ee_migrations;
DROP POLICY IF EXISTS content_e2ee_migrations_owner_update ON content_e2ee_migrations;
DROP TABLE IF EXISTS content_e2ee_migrations;

ALTER TABLE content_accounts
  DROP CONSTRAINT content_accounts_state_check;
ALTER TABLE content_accounts
  ADD CONSTRAINT content_accounts_state_check
  CHECK (state IN ('pending', 'active'));
