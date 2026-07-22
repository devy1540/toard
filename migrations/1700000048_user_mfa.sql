-- Up Migration

CREATE TABLE user_mfa_settings (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  login_required   BOOLEAN NOT NULL DEFAULT false,
  history_required BOOLEAN NOT NULL DEFAULT false,
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_passkeys (
  credential_id    TEXT PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key        BYTEA NOT NULL,
  counter           BIGINT NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports        TEXT[] NOT NULL DEFAULT '{}',
  device_type       TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up         BOOLEAN NOT NULL DEFAULT false,
  label             TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ
);

CREATE INDEX user_passkeys_user_id ON user_passkeys (user_id, created_at);

CREATE TABLE user_passkey_challenges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('registration', 'login', 'history', 'settings')),
  challenge  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX user_passkey_challenges_user_expiry
  ON user_passkey_challenges (user_id, expires_at);

REVOKE ALL PRIVILEGES ON TABLE user_mfa_settings, user_passkeys, user_passkey_challenges FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      user_mfa_settings, user_passkeys, user_passkey_challenges
    TO toard_app;
  END IF;
END $$;

-- Down Migration

DROP TABLE IF EXISTS user_passkey_challenges;
DROP TABLE IF EXISTS user_passkeys;
DROP TABLE IF EXISTS user_mfa_settings;
