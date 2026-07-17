-- Up Migration

-- RLS 소유자 행이나 wrapper payload를 읽지 않고도 운영자가 공급자 전환을 증명할 수 있는
-- 비민감 집계다. 0 count 행은 trigger가 즉시 제거한다.
CREATE TABLE managed_content_key_distribution (
  provider             TEXT NOT NULL CHECK (provider IN (
    'local', 'aws-kms', 'gcp-kms', 'azure-key-vault', 'vault-transit', 'openbao-transit'
  )),
  provider_fingerprint TEXT NOT NULL CHECK (
    char_length(provider_fingerprint) BETWEEN 8 AND 128
  ),
  state                TEXT NOT NULL CHECK (state IN ('active', 'pending', 'retiring')),
  wrapper_count        BIGINT NOT NULL CHECK (wrapper_count >= 0),
  PRIMARY KEY (provider, provider_fingerprint, state)
);

-- backfill과 trigger 설치 사이에 wrapper write가 빠져나가지 않게 migration transaction 동안 잠근다.
LOCK TABLE managed_content_keys IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO managed_content_key_distribution (
  provider, provider_fingerprint, state, wrapper_count
)
SELECT provider, provider_fingerprint, state, COUNT(*)::bigint
  FROM managed_content_keys
 GROUP BY provider, provider_fingerprint, state;

CREATE FUNCTION sync_managed_content_key_distribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  changed_rows BIGINT;
BEGIN
  -- 서로 반대 방향의 provider/state 교체도 lock 순서 deadlock 없이 직렬화한다.
  PERFORM pg_advisory_xact_lock(1700000039);

  IF TG_OP = 'UPDATE'
     AND OLD.provider = NEW.provider
     AND OLD.provider_fingerprint = NEW.provider_fingerprint
     AND OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE managed_content_key_distribution
       SET wrapper_count = wrapper_count - 1
     WHERE provider = OLD.provider
       AND provider_fingerprint = OLD.provider_fingerprint
       AND state = OLD.state
       AND wrapper_count > 0;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'managed content key distribution underflow';
    END IF;
    DELETE FROM managed_content_key_distribution
     WHERE provider = OLD.provider
       AND provider_fingerprint = OLD.provider_fingerprint
       AND state = OLD.state
       AND wrapper_count = 0;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO managed_content_key_distribution (
      provider, provider_fingerprint, state, wrapper_count
    ) VALUES (
      NEW.provider, NEW.provider_fingerprint, NEW.state, 1
    )
    ON CONFLICT (provider, provider_fingerprint, state) DO UPDATE
       SET wrapper_count = managed_content_key_distribution.wrapper_count + 1
     WHERE managed_content_key_distribution.wrapper_count < 9223372036854775807;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'managed content key distribution overflow';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION sync_managed_content_key_distribution() FROM PUBLIC;

CREATE TRIGGER managed_content_keys_distribution
AFTER INSERT OR DELETE OR UPDATE OF provider, provider_fingerprint, state
ON managed_content_keys
FOR EACH ROW EXECUTE FUNCTION sync_managed_content_key_distribution();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE managed_content_key_distribution FROM toard_app;
    GRANT SELECT ON TABLE managed_content_key_distribution TO toard_app;
  END IF;
END $$;

-- Down Migration

LOCK TABLE managed_content_keys IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE managed_content_key_distribution IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    WITH expected AS (
      SELECT provider, provider_fingerprint, state, COUNT(*)::bigint AS wrapper_count
        FROM managed_content_keys
       GROUP BY provider, provider_fingerprint, state
    ), actual AS (
      SELECT provider, provider_fingerprint, state, wrapper_count
        FROM managed_content_key_distribution
    )
    SELECT 1
      FROM expected
      FULL JOIN actual USING (provider, provider_fingerprint, state)
     WHERE expected.wrapper_count IS DISTINCT FROM actual.wrapper_count
  ) THEN
    RAISE EXCEPTION 'migration 39 rollback blocked: managed content key distribution mismatch';
  END IF;
END $$;

DROP TRIGGER managed_content_keys_distribution ON managed_content_keys;
DROP FUNCTION sync_managed_content_key_distribution();
DROP TABLE managed_content_key_distribution;
