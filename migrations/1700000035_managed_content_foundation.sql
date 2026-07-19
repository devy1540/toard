-- Up Migration

-- 설치마다 하나뿐인 비민감 식별자. 외부 KMS context와 운영 진단에서 사용한다.
CREATE TABLE installation_identity (
  singleton      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  installation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO installation_identity (singleton) VALUES (TRUE);

-- 사용자별 managed content key wrapper. 평문 user key는 저장하지 않는다.
CREATE TABLE managed_content_keys (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_version          SMALLINT NOT NULL CHECK (key_version > 0),
  provider             TEXT NOT NULL CHECK (provider IN (
    'local', 'aws-kms', 'gcp-kms', 'azure-key-vault', 'vault-transit', 'openbao-transit'
  )),
  provider_key_ref     TEXT NOT NULL CHECK (char_length(provider_key_ref) BETWEEN 1 AND 2048),
  provider_fingerprint TEXT NOT NULL CHECK (char_length(provider_fingerprint) BETWEEN 8 AND 128),
  wrapped_user_key     BYTEA NOT NULL CHECK (octet_length(wrapped_user_key) BETWEEN 32 AND 16384),
  wrapper_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(wrapper_metadata) = 'object'),
  context_version      SMALLINT NOT NULL DEFAULT 1 CHECK (context_version = 1),
  state                TEXT NOT NULL CHECK (state IN ('active', 'pending', 'retiring')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at          TIMESTAMPTZ,
  retired_at           TIMESTAMPTZ,
  UNIQUE (user_id, key_version, provider_fingerprint)
);

CREATE UNIQUE INDEX managed_content_keys_one_active
  ON managed_content_keys (user_id) WHERE state = 'active';
CREATE UNIQUE INDEX managed_content_keys_one_pending
  ON managed_content_keys (user_id) WHERE state = 'pending';

ALTER TABLE managed_content_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_content_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY managed_content_keys_owner_select ON managed_content_keys
  FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY managed_content_keys_owner_insert ON managed_content_keys
  FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY managed_content_keys_owner_update ON managed_content_keys
  FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE prompt_records
  DROP CONSTRAINT prompt_records_encryption_scheme_check,
  DROP CONSTRAINT prompt_records_e2ee_shape;

ALTER TABLE prompt_records
  ADD CONSTRAINT prompt_records_encryption_scheme_check
    CHECK (encryption_scheme IN ('server_v1', 'e2ee_v1', 'managed_v1')),
  ADD CONSTRAINT prompt_records_encryption_shape CHECK (
    encryption_scheme = 'server_v1'
    OR (
      encryption_scheme = 'e2ee_v1'
      AND content_owner_id IS NOT NULL
      AND content_key_version IS NOT NULL
      AND content_key_version > 0
      AND octet_length(wrapped_dek) = 32
      AND dek_wrap_iv IS NOT NULL
      AND octet_length(dek_wrap_iv) = 12
      AND dek_wrap_auth_tag IS NOT NULL
      AND octet_length(dek_wrap_auth_tag) = 16
      AND octet_length(iv) = 12
      AND octet_length(auth_tag) = 16
      AND octet_length(ciphertext) > 0
      AND aad_version IS NOT NULL
      AND aad_version = 1
    )
    OR (
      encryption_scheme = 'managed_v1'
      AND content_owner_id IS NULL
      AND content_key_version IS NOT NULL
      AND content_key_version > 0
      AND octet_length(wrapped_dek) = 32
      AND dek_wrap_iv IS NOT NULL
      AND octet_length(dek_wrap_iv) = 12
      AND dek_wrap_auth_tag IS NOT NULL
      AND octet_length(dek_wrap_auth_tag) = 16
      AND octet_length(iv) = 12
      AND octet_length(auth_tag) = 16
      AND octet_length(ciphertext) > 0
      AND aad_version IS NOT NULL
      AND aad_version = 2
    )
  );

-- 암호화 rollout 상태만 담는 singleton 집계. 본문과 wrapper 값은 포함하지 않는다.
CREATE TABLE content_encryption_status (
  singleton           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  server_records      BIGINT NOT NULL DEFAULT 0 CHECK (server_records >= 0),
  e2ee_records        BIGINT NOT NULL DEFAULT 0 CHECK (e2ee_records >= 0),
  managed_records     BIGINT NOT NULL DEFAULT 0 CHECK (managed_records >= 0),
  active_user_keys    BIGINT NOT NULL DEFAULT 0 CHECK (active_user_keys >= 0),
  pending_user_keys   BIGINT NOT NULL DEFAULT 0 CHECK (pending_user_keys >= 0),
  retiring_user_keys  BIGINT NOT NULL DEFAULT 0 CHECK (retiring_user_keys >= 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO content_encryption_status (
  singleton,
  server_records,
  e2ee_records,
  managed_records,
  active_user_keys,
  pending_user_keys,
  retiring_user_keys
)
SELECT
  TRUE,
  COUNT(*) FILTER (WHERE encryption_scheme = 'server_v1'),
  COUNT(*) FILTER (WHERE encryption_scheme = 'e2ee_v1'),
  COUNT(*) FILTER (WHERE encryption_scheme = 'managed_v1'),
  0,
  0,
  0
FROM prompt_records;

CREATE FUNCTION sync_content_encryption_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  server_delta  BIGINT := 0;
  e2ee_delta    BIGINT := 0;
  managed_delta BIGINT := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.encryption_scheme = 'server_v1' THEN server_delta := 1; END IF;
    IF NEW.encryption_scheme = 'e2ee_v1' THEN e2ee_delta := 1; END IF;
    IF NEW.encryption_scheme = 'managed_v1' THEN managed_delta := 1; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.encryption_scheme = 'server_v1' THEN server_delta := -1; END IF;
    IF OLD.encryption_scheme = 'e2ee_v1' THEN e2ee_delta := -1; END IF;
    IF OLD.encryption_scheme = 'managed_v1' THEN managed_delta := -1; END IF;
  ELSE
    IF OLD.encryption_scheme = 'server_v1' THEN server_delta := server_delta - 1; END IF;
    IF OLD.encryption_scheme = 'e2ee_v1' THEN e2ee_delta := e2ee_delta - 1; END IF;
    IF OLD.encryption_scheme = 'managed_v1' THEN managed_delta := managed_delta - 1; END IF;
    IF NEW.encryption_scheme = 'server_v1' THEN server_delta := server_delta + 1; END IF;
    IF NEW.encryption_scheme = 'e2ee_v1' THEN e2ee_delta := e2ee_delta + 1; END IF;
    IF NEW.encryption_scheme = 'managed_v1' THEN managed_delta := managed_delta + 1; END IF;
  END IF;

  IF server_delta <> 0 OR e2ee_delta <> 0 OR managed_delta <> 0 THEN
    UPDATE content_encryption_status
       SET server_records = server_records + server_delta,
           e2ee_records = e2ee_records + e2ee_delta,
           managed_records = managed_records + managed_delta,
           updated_at = now()
     WHERE singleton = TRUE;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER prompt_records_encryption_status
AFTER INSERT OR DELETE OR UPDATE OF encryption_scheme ON prompt_records
FOR EACH ROW EXECUTE FUNCTION sync_content_encryption_status();

CREATE FUNCTION sync_managed_content_key_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  active_delta   BIGINT := 0;
  pending_delta  BIGINT := 0;
  retiring_delta BIGINT := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'active' THEN active_delta := 1; END IF;
    IF NEW.state = 'pending' THEN pending_delta := 1; END IF;
    IF NEW.state = 'retiring' THEN retiring_delta := 1; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.state = 'active' THEN active_delta := -1; END IF;
    IF OLD.state = 'pending' THEN pending_delta := -1; END IF;
    IF OLD.state = 'retiring' THEN retiring_delta := -1; END IF;
  ELSE
    IF OLD.state = 'active' THEN active_delta := active_delta - 1; END IF;
    IF OLD.state = 'pending' THEN pending_delta := pending_delta - 1; END IF;
    IF OLD.state = 'retiring' THEN retiring_delta := retiring_delta - 1; END IF;
    IF NEW.state = 'active' THEN active_delta := active_delta + 1; END IF;
    IF NEW.state = 'pending' THEN pending_delta := pending_delta + 1; END IF;
    IF NEW.state = 'retiring' THEN retiring_delta := retiring_delta + 1; END IF;
  END IF;

  IF active_delta <> 0 OR pending_delta <> 0 OR retiring_delta <> 0 THEN
    UPDATE content_encryption_status
       SET active_user_keys = active_user_keys + active_delta,
           pending_user_keys = pending_user_keys + pending_delta,
           retiring_user_keys = retiring_user_keys + retiring_delta,
           updated_at = now()
     WHERE singleton = TRUE;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER managed_content_keys_encryption_status
AFTER INSERT OR DELETE OR UPDATE OF state ON managed_content_keys
FOR EACH ROW EXECUTE FUNCTION sync_managed_content_key_status();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    -- bootstrap가 migration 전에 실행된 topology에서도 default broad grant를 남기지 않는다.
    REVOKE ALL PRIVILEGES ON TABLE installation_identity, content_encryption_status, managed_content_keys FROM toard_app;
    GRANT SELECT ON installation_identity, content_encryption_status TO toard_app;
    GRANT SELECT, INSERT, UPDATE ON managed_content_keys TO toard_app;
  END IF;
END $$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM prompt_records WHERE encryption_scheme = 'managed_v1')
     OR EXISTS (SELECT 1 FROM managed_content_keys) THEN
    RAISE EXCEPTION 'migration 35 rollback blocked: managed content exists';
  END IF;
END $$;

DROP TRIGGER IF EXISTS prompt_records_encryption_status ON prompt_records;
DROP TRIGGER IF EXISTS managed_content_keys_encryption_status ON managed_content_keys;
DROP FUNCTION IF EXISTS sync_content_encryption_status();
DROP FUNCTION IF EXISTS sync_managed_content_key_status();
DROP TABLE IF EXISTS content_encryption_status;
DROP TABLE IF EXISTS managed_content_keys;
DROP TABLE IF EXISTS installation_identity;

ALTER TABLE prompt_records
  DROP CONSTRAINT IF EXISTS prompt_records_encryption_shape,
  DROP CONSTRAINT IF EXISTS prompt_records_encryption_scheme_check;

ALTER TABLE prompt_records
  ADD CONSTRAINT prompt_records_encryption_scheme_check
    CHECK (encryption_scheme IN ('server_v1', 'e2ee_v1')),
  ADD CONSTRAINT prompt_records_e2ee_shape CHECK (
    encryption_scheme = 'server_v1'
    OR (
      content_owner_id IS NOT NULL
      AND content_key_version > 0
      AND octet_length(wrapped_dek) = 32
      AND dek_wrap_iv IS NOT NULL
      AND octet_length(dek_wrap_iv) = 12
      AND dek_wrap_auth_tag IS NOT NULL
      AND octet_length(dek_wrap_auth_tag) = 16
      AND octet_length(iv) = 12
      AND octet_length(auth_tag) = 16
      AND octet_length(ciphertext) > 0
      AND aad_version = 1
    )
  );
