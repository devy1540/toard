-- Up Migration

CREATE TABLE content_legacy_retirement (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  legacy_records BIGINT NOT NULL DEFAULT 0 CHECK (legacy_records >= 0),
  zero_observed_at TIMESTAMPTZ,
  backup_confirmed_at TIMESTAMPTZ,
  backup_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  key_retired_observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO content_legacy_retirement (singleton, legacy_records)
SELECT TRUE, COUNT(*)
FROM prompt_records
WHERE encryption_scheme = 'server_v1'
ON CONFLICT (singleton) DO NOTHING;

CREATE FUNCTION sync_content_legacy_retirement_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  delta BIGINT := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.encryption_scheme = 'server_v1' THEN delta := 1; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.encryption_scheme = 'server_v1' THEN delta := -1; END IF;
  ELSE
    IF OLD.encryption_scheme = 'server_v1' AND NEW.encryption_scheme <> 'server_v1' THEN delta := -1; END IF;
    IF OLD.encryption_scheme <> 'server_v1' AND NEW.encryption_scheme = 'server_v1' THEN delta := 1; END IF;
  END IF;
  IF delta <> 0 THEN
    UPDATE content_legacy_retirement
       SET legacy_records = legacy_records + delta, updated_at = now()
     WHERE singleton = TRUE;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER prompt_records_legacy_retirement_count
AFTER INSERT OR DELETE OR UPDATE OF encryption_scheme ON prompt_records
FOR EACH ROW EXECUTE FUNCTION sync_content_legacy_retirement_count();

CREATE TABLE content_legacy_retirement_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'zero_observed', 'zero_invalidated', 'backup_confirmed', 'key_retired_observed'
  )),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  legacy_records BIGINT NOT NULL CHECK (legacy_records >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_legacy_retirement_events_created
  ON content_legacy_retirement_events (created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    EXECUTE 'GRANT SELECT, UPDATE ON content_legacy_retirement TO toard_app';
    EXECUTE 'GRANT SELECT, INSERT ON content_legacy_retirement_events TO toard_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE content_legacy_retirement_events_id_seq TO toard_app';
  END IF;
END $$;

-- Down Migration

DROP TABLE IF EXISTS content_legacy_retirement_events;
DROP TRIGGER IF EXISTS prompt_records_legacy_retirement_count ON prompt_records;
DROP FUNCTION IF EXISTS sync_content_legacy_retirement_count();
DROP TABLE IF EXISTS content_legacy_retirement;
