-- Up Migration

ALTER TABLE users
  ADD COLUMN team_role TEXT NOT NULL DEFAULT 'member'
  CHECK (team_role IN ('member', 'leader'));

CREATE TABLE tool_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id UUID NOT NULL REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
  source_identity TEXT NOT NULL CHECK (char_length(source_identity) BETWEEN 1 AND 300),
  exact_ref TEXT NOT NULL CHECK (char_length(exact_ref) BETWEEN 1 AND 100),
  source_path TEXT NOT NULL DEFAULT '',
  tree_digest TEXT NOT NULL CHECK (tree_digest ~ '^sha256:[a-f0-9]{64}$'),
  manifest JSONB NOT NULL,
  permission_fingerprint TEXT NOT NULL CHECK (permission_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (catalog_item_id, source_identity, exact_ref, tree_digest)
);

CREATE INDEX idx_tool_versions_catalog_created
  ON tool_versions (catalog_item_id, created_at DESC);

CREATE TABLE team_tool_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
  target_version_id UUID NOT NULL REFERENCES tool_versions(id),
  last_known_good_version_id UUID REFERENCES tool_versions(id),
  tracking_mode TEXT NOT NULL DEFAULT 'auto' CHECK (tracking_mode IN ('auto', 'pinned')),
  rollout_phase TEXT NOT NULL DEFAULT 'preflight'
    CHECK (rollout_phase IN ('preflight', 'canary', 'expand', 'active', 'paused', 'rollback')),
  rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  rollout_seed UUID NOT NULL DEFAULT gen_random_uuid(),
  phase_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, catalog_item_id)
);

CREATE INDEX idx_team_tool_policies_rollout
  ON team_tool_policies (rollout_phase, phase_started_at)
  WHERE enabled = true;

CREATE TABLE user_tool_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('install', 'exclude')),
  install_scope TEXT NOT NULL DEFAULT 'all_devices'
    CHECK (install_scope IN ('all_devices', 'selected_devices')),
  target_version_id UUID REFERENCES tool_versions(id),
  tracking_mode TEXT NOT NULL DEFAULT 'auto' CHECK (tracking_mode IN ('auto', 'pinned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, catalog_item_id),
  CHECK (
    (mode = 'exclude' AND target_version_id IS NULL AND install_scope = 'all_devices')
    OR (mode = 'install' AND target_version_id IS NOT NULL)
  )
);

CREATE TABLE user_tool_preference_devices (
  user_id UUID NOT NULL,
  catalog_item_id UUID NOT NULL,
  device_fingerprint TEXT NOT NULL CHECK (device_fingerprint ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (user_id, catalog_item_id, device_fingerprint),
  FOREIGN KEY (user_id, catalog_item_id)
    REFERENCES user_tool_preferences(user_id, catalog_item_id) ON DELETE CASCADE
);

CREATE TABLE tool_deployment_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL CHECK (device_fingerprint ~ '^[a-f0-9]{64}$'),
  catalog_item_id UUID NOT NULL REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
  desired_version_id UUID REFERENCES tool_versions(id),
  applied_version_id UUID REFERENCES tool_versions(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'applying', 'settings_required', 'installed', 'conflict', 'failed', 'rolled_back', 'excluded', 'unsupported')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  rollout_id UUID,
  first_attempted_at TIMESTAMPTZ,
  last_attempted_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  UNIQUE (ingest_token_id, device_fingerprint, catalog_item_id)
);

CREATE INDEX idx_tool_deployment_reports_rollout
  ON tool_deployment_reports (rollout_id, status)
  WHERE rollout_id IS NOT NULL;

CREATE TABLE tool_deployment_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  team_id UUID REFERENCES teams(id),
  catalog_item_id UUID REFERENCES tool_catalog_items(id),
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tool_deployment_audit_created
  ON tool_deployment_audit (created_at DESC);

-- GitHub App access token과 private artifact는 저장하지 않는다.
CREATE TABLE github_app_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id BIGINT NOT NULL UNIQUE,
  account_login TEXT NOT NULL CHECK (char_length(account_login) BETWEEN 1 AND 200),
  account_id BIGINT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS github_app_installations;
DROP TABLE IF EXISTS tool_deployment_audit;
DROP TABLE IF EXISTS tool_deployment_reports;
DROP TABLE IF EXISTS user_tool_preference_devices;
DROP TABLE IF EXISTS user_tool_preferences;
DROP TABLE IF EXISTS team_tool_policies;
DROP TABLE IF EXISTS tool_versions;
ALTER TABLE users DROP COLUMN IF EXISTS team_role;
