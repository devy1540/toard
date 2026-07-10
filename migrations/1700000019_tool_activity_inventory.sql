-- Up Migration

CREATE TABLE tool_activity_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  provider_key TEXT NOT NULL REFERENCES providers(key),
  user_id UUID NOT NULL REFERENCES users(id),
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id),
  session_id TEXT,
  host TEXT,
  ts TIMESTAMPTZ NOT NULL,
  activity_kind TEXT NOT NULL CHECK (activity_kind IN ('mcp', 'skill')),
  item_key TEXT NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 200),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  plugin_key TEXT CHECK (plugin_key IS NULL OR char_length(plugin_key) BETWEEN 1 AND 200),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'unknown')),
  detection TEXT NOT NULL CHECK (detection IN ('explicit', 'derived_load'))
);
CREATE INDEX idx_tool_activity_user_ts ON tool_activity_events (user_id, ts DESC);
CREATE INDEX idx_tool_activity_org_ts_kind ON tool_activity_events (ts, activity_kind);

CREATE TABLE device_tool_inventory_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id),
  host TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ingest_token_id, host)
);

CREATE TABLE device_tool_inventory_items (
  snapshot_id BIGINT NOT NULL REFERENCES device_tool_inventory_snapshots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mcp', 'skill', 'plugin')),
  item_key TEXT NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 200),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  source_provider TEXT NOT NULL CHECK (char_length(source_provider) BETWEEN 1 AND 100),
  plugin_key TEXT CHECK (plugin_key IS NULL OR char_length(plugin_key) BETWEEN 1 AND 200),
  version TEXT CHECK (version IS NULL OR char_length(version) BETWEEN 1 AND 100),
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (snapshot_id, kind, item_key, source_provider)
);

-- Down Migration

DROP TABLE IF EXISTS device_tool_inventory_items;
DROP TABLE IF EXISTS device_tool_inventory_snapshots;
DROP TABLE IF EXISTS tool_activity_events;
