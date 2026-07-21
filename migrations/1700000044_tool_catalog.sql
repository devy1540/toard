-- Up Migration

CREATE TABLE tool_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  kind TEXT NOT NULL CHECK (kind IN ('mcp', 'skill', 'plugin')),
  source_url TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  supported_clients TEXT[] NOT NULL,
  required_env TEXT[] NOT NULL DEFAULT '{}',
  network_hosts TEXT[] NOT NULL DEFAULT '{}',
  install_notes TEXT NOT NULL DEFAULT '',
  uninstall_notes TEXT NOT NULL DEFAULT '',
  inventory_item_key TEXT NOT NULL CHECK (char_length(inventory_item_key) BETWEEN 1 AND 200),
  inventory_source_provider TEXT NOT NULL CHECK (inventory_source_provider IN ('codex', 'claude_code')),
  trust_status TEXT NOT NULL DEFAULT 'community' CHECK (trust_status IN ('community', 'verified')),
  lifecycle_status TEXT NOT NULL DEFAULT 'published' CHECK (lifecycle_status IN ('published', 'deprecated', 'blocked', 'archived')),
  status_reason TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tool_catalog_visible ON tool_catalog_items (lifecycle_status, kind, updated_at DESC);
CREATE INDEX idx_tool_catalog_owner ON tool_catalog_items (owner_user_id, updated_at DESC);

-- Down Migration

DROP TABLE IF EXISTS tool_catalog_items;
