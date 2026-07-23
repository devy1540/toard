-- Up Migration

CREATE TABLE device_control_policies (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL CHECK (device_fingerprint ~ '^[a-f0-9]{64}$'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  desired_content_mode TEXT NOT NULL
    CHECK (desired_content_mode IN ('off', 'server_v1', 'e2ee_v1')),
  desired_content_since TIMESTAMPTZ,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ingest_token_id, device_fingerprint)
);

CREATE TABLE device_control_observations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL CHECK (device_fingerprint ~ '^[a-f0-9]{64}$'),
  host TEXT,
  shim_version TEXT NOT NULL CHECK (char_length(shim_version) BETWEEN 1 AND 80),
  daemon_active BOOLEAN NOT NULL,
  applied_generation BIGINT NOT NULL CHECK (applied_generation >= 0),
  applied_content_mode TEXT NOT NULL
    CHECK (applied_content_mode IN ('off', 'server_v1', 'e2ee_v1')),
  applied_content_since TIMESTAMPTZ,
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  last_sync_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ingest_token_id, device_fingerprint)
);

CREATE TABLE device_control_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL CHECK (device_fingerprint ~ '^[a-f0-9]{64}$'),
  command_type TEXT NOT NULL CHECK (command_type IN ('collect', 'doctor')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed', 'expired')),
  result_code TEXT CHECK (result_code IS NULL OR result_code ~ '^[a-z0-9_]{1,80}$'),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_device_control_commands_one_active
  ON device_control_commands (ingest_token_id, device_fingerprint, command_type)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX idx_device_control_commands_claim
  ON device_control_commands (ingest_token_id, device_fingerprint, created_at)
  WHERE status IN ('pending', 'claimed');

CREATE TABLE device_control_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL CHECK (device_fingerprint ~ '^[a-f0-9]{64}$'),
  action TEXT NOT NULL CHECK (action IN ('content_mode_changed', 'command_created')),
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_device_control_audit_user_created
  ON device_control_audit (user_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS device_control_audit;
DROP TABLE IF EXISTS device_control_commands;
DROP TABLE IF EXISTS device_control_observations;
DROP TABLE IF EXISTS device_control_policies;
