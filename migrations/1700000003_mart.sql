-- Up Migration

-- 일별 사용자 집계. SUM 지표는 당일 증분, DISTINCT(sessions)는 마감 재계산 (설계 §4.4)
CREATE TABLE usage_daily_user (
  user_id               UUID NOT NULL REFERENCES users(id),
  day                   DATE NOT NULL,                 -- KST: (ts AT TIME ZONE 'Asia/Seoul')::date
  provider_key          TEXT NOT NULL REFERENCES providers(key),
  request_count         BIGINT NOT NULL DEFAULT 0,
  sessions              INT NOT NULL DEFAULT 0,
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd              NUMERIC(16,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, provider_key)
);
CREATE INDEX idx_udu_day_provider ON usage_daily_user (day, provider_key);

-- 일별 부서 집계. active_users·sessions(DISTINCT)는 마감 재계산
CREATE TABLE usage_daily_department (
  department_id UUID NOT NULL REFERENCES departments(id),
  day           DATE NOT NULL,
  provider_key  TEXT NOT NULL REFERENCES providers(key),
  request_count BIGINT NOT NULL DEFAULT 0,
  active_users  INT NOT NULL DEFAULT 0,
  sessions      INT NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(16,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (department_id, day, provider_key)
);
CREATE INDEX idx_udd_day_provider ON usage_daily_department (day, provider_key);

-- Down Migration
DROP TABLE IF EXISTS usage_daily_user, usage_daily_department CASCADE;
