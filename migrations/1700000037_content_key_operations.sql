-- Up Migration

-- 사용자나 key payload 없이 provider 호출량만 일 단위로 집계한다.
CREATE TABLE content_key_operation_daily (
  day                  DATE NOT NULL,
  provider             TEXT NOT NULL CHECK (provider IN (
    'local', 'aws-kms', 'gcp-kms', 'azure-key-vault', 'vault-transit', 'openbao-transit'
  )),
  provider_fingerprint TEXT NOT NULL CHECK (
    char_length(provider_fingerprint) <= 128
    AND provider_fingerprint ~ ('^' || provider || ':[0-9a-f]{24}$')
  ),
  operation             TEXT NOT NULL CHECK (operation IN ('wrap', 'unwrap', 'health')),
  outcome               TEXT NOT NULL CHECK (outcome IN (
    'success', 'throttled', 'unavailable', 'auth', 'invalid'
  )),
  cache_result          TEXT NOT NULL CHECK (cache_result IN (
    'none', 'hit', 'miss', 'single_flight'
  )),
  operation_count       BIGINT NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
  total_latency_ms      BIGINT NOT NULL DEFAULT 0 CHECK (total_latency_ms >= 0),
  PRIMARY KEY (day, provider, provider_fingerprint, operation, outcome, cache_result)
);

-- 관리 키 lifecycle의 고정된 비밀 비포함 필드만 저장한다.
CREATE TABLE content_key_security_events (
  id                   BIGSERIAL PRIMARY KEY,
  event_type           TEXT NOT NULL CHECK (event_type IN (
    'user_key_created',
    'user_key_rewrapped',
    'provider_migration_started',
    'provider_migration_completed',
    'e2ee_migration_blocked',
    'e2ee_migration_resumed'
  )),
  user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  provider             TEXT CHECK (provider IN (
    'local', 'aws-kms', 'gcp-kms', 'azure-key-vault', 'vault-transit', 'openbao-transit'
  )),
  provider_fingerprint TEXT,
  key_version          SMALLINT CHECK (key_version > 0),
  actor_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  app_instance_id      TEXT NOT NULL CHECK (
    char_length(app_instance_id) BETWEEN 1 AND 128
    AND app_instance_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_key_security_events_provider_identity_check CHECK (
    (provider IS NULL AND provider_fingerprint IS NULL)
    OR (
      provider IS NOT NULL
      AND provider_fingerprint IS NOT NULL
      AND char_length(provider_fingerprint) <= 128
      AND provider_fingerprint ~ ('^' || provider || ':[0-9a-f]{24}$')
    )
  ),
  CONSTRAINT content_key_security_events_shape_check CHECK (
    (
      event_type IN ('user_key_created', 'user_key_rewrapped')
      AND user_id IS NOT NULL
      AND provider IS NOT NULL
      AND key_version IS NOT NULL
      AND actor_user_id IS NULL
    )
    OR (
      event_type IN ('provider_migration_started', 'provider_migration_completed')
      AND user_id IS NULL
      AND provider IS NOT NULL
      AND key_version IS NULL
      AND actor_user_id IS NOT NULL
    )
    OR (
      event_type IN ('e2ee_migration_blocked', 'e2ee_migration_resumed')
      AND user_id IS NOT NULL
      AND provider IS NULL
      AND key_version IS NULL
      AND actor_user_id IS NULL
    )
  )
);

CREATE INDEX content_key_security_events_created
  ON content_key_security_events (created_at DESC);

ALTER TABLE content_key_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_key_security_events FORCE ROW LEVEL SECURITY;

CREATE POLICY content_key_security_events_owner_select
  ON content_key_security_events
  FOR SELECT USING (
    (
      event_type NOT IN ('provider_migration_started', 'provider_migration_completed')
      AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
    OR (
      event_type IN ('provider_migration_started', 'provider_migration_completed')
      AND actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND role = 'admin'
      )
    )
  );

CREATE POLICY content_key_security_events_owner_insert
  ON content_key_security_events
  FOR INSERT WITH CHECK (
    (
      event_type NOT IN ('provider_migration_started', 'provider_migration_completed')
      AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
    OR (
      event_type IN ('provider_migration_started', 'provider_migration_completed')
      AND actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND role = 'admin'
      )
    )
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE
      content_key_operation_daily,
      content_key_security_events
    FROM toard_app;
    GRANT SELECT, INSERT ON TABLE
      content_key_operation_daily,
      content_key_security_events
    TO toard_app;
    GRANT UPDATE (operation_count, total_latency_ms)
      ON content_key_operation_daily TO toard_app;

    REVOKE ALL PRIVILEGES ON SEQUENCE content_key_security_events_id_seq FROM toard_app;
    GRANT USAGE ON SEQUENCE content_key_security_events_id_seq TO toard_app;
  END IF;
END $$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content_key_operation_daily)
     OR EXISTS (SELECT 1 FROM content_key_security_events) THEN
    RAISE EXCEPTION 'migration 37 rollback blocked: key operation or security event data exists';
  END IF;
END $$;

DROP TABLE content_key_security_events;
DROP TABLE content_key_operation_daily;
