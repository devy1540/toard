-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE departments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  parent_id  UUID REFERENCES departments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- users: Auth.js(@auth/pg-adapter) 스키마 + toard 컬럼(role, department_id) 통합
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT,
  email           TEXT NOT NULL UNIQUE,
  "emailVerified" TIMESTAMPTZ,
  image           TEXT,
  department_id   UUID REFERENCES departments(id),
  role            TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'admin'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auth.js 어댑터 테이블
CREATE TABLE accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,
  provider            TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  refresh_token       TEXT,
  access_token        TEXT,
  expires_at          BIGINT,
  token_type          TEXT,
  scope               TEXT,
  id_token            TEXT,
  session_state       TEXT,
  UNIQUE (provider, "providerAccountId")
);

CREATE TABLE sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sessionToken" TEXT NOT NULL UNIQUE,
  "userId"       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires        TIMESTAMPTZ NOT NULL
);

CREATE TABLE verification_token (
  identifier TEXT NOT NULL,
  token      TEXT NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- 부서 이동 이력 (1차 비활성, users.department_id 로 운영)
CREATE TABLE user_department_assignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  department_id  UUID NOT NULL REFERENCES departments(id),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  UNIQUE (user_id, effective_from)
);

CREATE TABLE providers (
  key                   TEXT PRIMARY KEY,
  display_name          TEXT NOT NULL,
  service_name_patterns TEXT[] NOT NULL,        -- OTLP service.name → provider 식별
  collection_method     TEXT NOT NULL,          -- 'otel' | 'logfile'
  enabled               BOOLEAN NOT NULL DEFAULT true
);

-- shim 인증 토큰 (SHA-256 해시, 평문 1회 노출)
CREATE TABLE ingest_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- 가격(per-million USD)
CREATE TABLE pricing_models (
  model_id                        TEXT NOT NULL,
  input_price_per_mtok            NUMERIC NOT NULL,
  output_price_per_mtok           NUMERIC NOT NULL,
  cache_read_price_per_mtok       NUMERIC,
  cache_creation_price_per_mtok   NUMERIC,
  input_price_above_200k_per_mtok NUMERIC,
  output_price_above_200k_per_mtok NUMERIC,
  fast_multiplier                 NUMERIC NOT NULL DEFAULT 1,
  effective_date                  DATE NOT NULL,
  source                          TEXT NOT NULL DEFAULT 'litellm',
  PRIMARY KEY (model_id, effective_date)
);

-- Down Migration
DROP TABLE IF EXISTS pricing_models, ingest_tokens, providers, user_department_assignments,
  verification_token, sessions, accounts, users, departments CASCADE;
