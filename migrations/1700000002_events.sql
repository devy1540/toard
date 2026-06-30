-- Up Migration

-- OTLP 원형 보존(프롬프트 제거 후) — 무손실 재처리 근거
CREATE TABLE raw_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_key TEXT NOT NULL,
  payload      JSONB NOT NULL,
  processed    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_raw_events_unprocessed ON raw_events (processed, received_at);

-- 정규화된 사용 이벤트 (대시보드 쿼리 대상)
CREATE TABLE usage_events (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key             TEXT NOT NULL UNIQUE,          -- request_id 기반 (설계 §4.4)
  provider_key          TEXT NOT NULL REFERENCES providers(key),
  user_id               UUID REFERENCES users(id),
  session_id            TEXT,
  model                 TEXT,
  ts                    TIMESTAMPTZ NOT NULL,
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd              NUMERIC(14,8) NOT NULL DEFAULT 0,
  raw_event_id          BIGINT REFERENCES raw_events(id)
);
CREATE INDEX idx_usage_events_user_ts ON usage_events (user_id, ts);
CREATE INDEX idx_usage_events_provider_ts ON usage_events (provider_key, ts);
CREATE INDEX idx_usage_events_recompute ON usage_events (ts, provider_key, user_id);
CREATE INDEX idx_usage_events_session ON usage_events (session_id);

-- Down Migration
DROP TABLE IF EXISTS usage_events, raw_events CASCADE;
