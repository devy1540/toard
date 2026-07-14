-- Up Migration

-- E2EE 콘텐츠 계정. content_owner_id는 로그인/ingest user id를 AAD에 직접 노출하지 않는
-- 불변 식별자이며, recovery_salt는 공개값이다. 평문 UCK와 recovery secret은 저장하지 않는다.
CREATE TABLE content_accounts (
  user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_owner_id      UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  state                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'active')),
  active_key_version    SMALLINT NOT NULL DEFAULT 1 CHECK (active_key_version > 0),
  recovery_salt         BYTEA NOT NULL DEFAULT gen_random_bytes(32)
                        CHECK (octet_length(recovery_salt) = 32),
  recovery_confirmed_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, content_owner_id),
  CHECK (state <> 'active' OR recovery_confirmed_at IS NOT NULL)
);

CREATE TABLE content_devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('shim', 'browser')),
  label             TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  platform          TEXT NOT NULL CHECK (char_length(platform) BETWEEN 1 AND 40),
  public_key        BYTEA NOT NULL CHECK (octet_length(public_key) = 65),
  algorithm_version TEXT NOT NULL CHECK (algorithm_version = 'hpke-p256-v1'),
  approved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ
);
CREATE INDEX idx_content_devices_user_active
  ON content_devices (user_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE content_key_wrappers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_key_version SMALLINT NOT NULL CHECK (content_key_version > 0),
  wrapper_type        TEXT NOT NULL CHECK (wrapper_type IN ('device', 'recovery')),
  wrapper_ref         TEXT NOT NULL CHECK (char_length(wrapper_ref) BETWEEN 1 AND 128),
  kdf_version         TEXT NOT NULL CHECK (kdf_version IN ('hpke-p256-v1', 'hkdf-sha256-v1')),
  public_salt_or_input BYTEA,
  nonce               BYTEA,
  auth_tag            BYTEA,
  encapsulated_key    BYTEA,
  wrapped_content_key BYTEA NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  CONSTRAINT content_key_wrappers_shape CHECK (
    (wrapper_type = 'device'
      AND kdf_version = 'hpke-p256-v1'
      AND public_salt_or_input IS NULL
      AND nonce IS NULL
      AND auth_tag IS NULL
      AND octet_length(encapsulated_key) = 65
      AND octet_length(wrapped_content_key) BETWEEN 17 AND 1024)
    OR
    (wrapper_type = 'recovery'
      AND kdf_version = 'hkdf-sha256-v1'
      AND octet_length(public_salt_or_input) = 32
      AND octet_length(nonce) = 12
      AND octet_length(auth_tag) = 16
      AND encapsulated_key IS NULL
      AND octet_length(wrapped_content_key) = 32)
  )
);
CREATE UNIQUE INDEX uq_content_key_wrappers_active
  ON content_key_wrappers (user_id, content_key_version, wrapper_type, wrapper_ref)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX uq_content_key_wrappers_active_recovery
  ON content_key_wrappers (user_id, content_key_version)
  WHERE wrapper_type = 'recovery' AND revoked_at IS NULL;
CREATE INDEX idx_content_key_wrappers_user_version
  ON content_key_wrappers (user_id, content_key_version) WHERE revoked_at IS NULL;

CREATE TABLE content_device_approval_requests (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_device_id    UUID NOT NULL REFERENCES content_devices(id) ON DELETE CASCADE,
  confirmation_code_hash BYTEA NOT NULL CHECK (octet_length(confirmation_code_hash) = 32),
  encapsulated_key       BYTEA,
  encrypted_envelope     BYTEA,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL,
  approved_at            TIMESTAMPTZ,
  consumed_at            TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (
    (approved_at IS NULL AND encapsulated_key IS NULL AND encrypted_envelope IS NULL)
    OR
    (approved_at IS NOT NULL
      AND octet_length(encapsulated_key) = 65
      AND octet_length(encrypted_envelope) BETWEEN 17 AND 1024)
  ),
  CHECK (consumed_at IS NULL OR approved_at IS NOT NULL)
);
CREATE INDEX idx_content_approval_pending
  ON content_device_approval_requests (user_id, expires_at)
  WHERE approved_at IS NULL AND consumed_at IS NULL;

ALTER TABLE prompt_records
  ADD COLUMN encryption_scheme TEXT NOT NULL DEFAULT 'server_v1'
    CHECK (encryption_scheme IN ('server_v1', 'e2ee_v1')),
  ADD COLUMN content_owner_id UUID,
  ADD COLUMN content_key_version SMALLINT,
  ADD COLUMN dek_wrap_iv BYTEA,
  ADD COLUMN dek_wrap_auth_tag BYTEA,
  ADD COLUMN aad_version SMALLINT,
  ADD CONSTRAINT prompt_records_content_owner_fk
    FOREIGN KEY (user_id, content_owner_id)
    REFERENCES content_accounts (user_id, content_owner_id),
  ADD CONSTRAINT prompt_records_e2ee_shape CHECK (
    encryption_scheme = 'server_v1'
    OR
    (content_owner_id IS NOT NULL
      AND content_key_version > 0
      AND octet_length(wrapped_dek) = 32
      AND dek_wrap_iv IS NOT NULL
      AND octet_length(dek_wrap_iv) = 12
      AND dek_wrap_auth_tag IS NOT NULL
      AND octet_length(dek_wrap_auth_tag) = 16
      AND octet_length(iv) = 12
      AND octet_length(auth_tag) = 16
      AND octet_length(ciphertext) > 0
      AND aad_version = 1)
  );
CREATE INDEX idx_prompt_records_user_scheme_ts
  ON prompt_records (user_id, encryption_scheme, ts DESC);

-- 모든 E2EE 보조 테이블은 prompt_records와 같은 transaction-local user context를 사용한다.
ALTER TABLE content_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE content_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE content_key_wrappers ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_key_wrappers FORCE ROW LEVEL SECURITY;
ALTER TABLE content_device_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_device_approval_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY content_accounts_owner_select ON content_accounts
  FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_accounts_owner_insert ON content_accounts
  FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_accounts_owner_update ON content_accounts
  FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY content_devices_owner_select ON content_devices
  FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_devices_owner_insert ON content_devices
  FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_devices_owner_update ON content_devices
  FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY content_wrappers_owner_select ON content_key_wrappers
  FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_wrappers_owner_insert ON content_key_wrappers
  FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_wrappers_owner_update ON content_key_wrappers
  FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY content_approvals_owner_select ON content_device_approval_requests
  FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_approvals_owner_insert ON content_device_approval_requests
  FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY content_approvals_owner_update ON content_device_approval_requests
  FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- Down Migration
DROP INDEX IF EXISTS idx_prompt_records_user_scheme_ts;
ALTER TABLE prompt_records
  DROP CONSTRAINT IF EXISTS prompt_records_e2ee_shape,
  DROP CONSTRAINT IF EXISTS prompt_records_content_owner_fk,
  DROP COLUMN IF EXISTS aad_version,
  DROP COLUMN IF EXISTS dek_wrap_auth_tag,
  DROP COLUMN IF EXISTS dek_wrap_iv,
  DROP COLUMN IF EXISTS content_key_version,
  DROP COLUMN IF EXISTS content_owner_id,
  DROP COLUMN IF EXISTS encryption_scheme;
DROP TABLE IF EXISTS content_device_approval_requests;
DROP TABLE IF EXISTS content_key_wrappers;
DROP TABLE IF EXISTS content_devices;
DROP TABLE IF EXISTS content_accounts;
