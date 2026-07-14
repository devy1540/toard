-- Up Migration

CREATE TABLE content_legacy_retirement (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  zero_observed_at TIMESTAMPTZ,
  backup_confirmed_at TIMESTAMPTZ,
  backup_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  key_retired_observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO content_legacy_retirement (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

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

-- Down Migration

DROP TABLE IF EXISTS content_legacy_retirement_events;
DROP TABLE IF EXISTS content_legacy_retirement;
