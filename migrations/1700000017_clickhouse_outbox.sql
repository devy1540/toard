-- Up Migration

-- ClickHouse 모드의 정확한 dedup/outbox 게이트.
-- dedup_key UNIQUE 보장은 Postgres 가 맡고, ClickHouse 는 분석 서빙/rollup 전용으로 둔다.
CREATE TABLE clickhouse_usage_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insert_token TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'inflight', 'delivered')),
  attempts     INT NOT NULL DEFAULT 0,
  locked_at    TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ch_usage_batches_pending
  ON clickhouse_usage_batches (status, created_at)
  WHERE delivered_at IS NULL;

CREATE INDEX idx_ch_usage_batches_stale
  ON clickhouse_usage_batches (locked_at)
  WHERE status = 'inflight' AND delivered_at IS NULL;

CREATE TABLE clickhouse_usage_outbox (
  dedup_key             TEXT PRIMARY KEY,
  batch_id              UUID NOT NULL REFERENCES clickhouse_usage_batches(id) ON DELETE CASCADE,
  provider_key          TEXT NOT NULL REFERENCES providers(key),
  user_id               UUID REFERENCES users(id),
  team_id               UUID REFERENCES teams(id),
  session_id            TEXT,
  model                 TEXT,
  ts                    TIMESTAMPTZ NOT NULL,
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd              NUMERIC(18,8) NOT NULL DEFAULT 0,
  log_adapter           TEXT,
  host                  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at          TIMESTAMPTZ
);

CREATE INDEX idx_ch_usage_outbox_batch
  ON clickhouse_usage_outbox (batch_id, dedup_key);

CREATE INDEX idx_ch_usage_outbox_pending
  ON clickhouse_usage_outbox (created_at)
  WHERE delivered_at IS NULL;

-- Down Migration

DROP TABLE IF EXISTS clickhouse_usage_outbox;
DROP TABLE IF EXISTS clickhouse_usage_batches;
