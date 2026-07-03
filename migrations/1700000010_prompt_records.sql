-- Up Migration
-- prompt_records: 프롬프트/응답 본문 (opt-in, 2차).
-- 앱레벨 봉투 암호화(at-rest) + RLS 소유자 전용. DB 에는 암호문만 저장한다(KEK 는 앱 밖 KMS/Vault).
-- 기존 usage_events / ClickHouse 는 무변경 — 별도 테이블, 아직 어떤 경로에도 배선되지 않음.

CREATE TABLE prompt_records (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key     TEXT NOT NULL UNIQUE,               -- 멱등. usage_events.dedup_key 와 소프트 정렬
  user_id       UUID NOT NULL REFERENCES users(id), -- 소유자 = RLS 기준
  session_id    TEXT,
  provider_key  TEXT NOT NULL REFERENCES providers(key),
  turn_role     TEXT NOT NULL,                      -- 'user' | 'assistant' (SQL 예약어 회피로 turn_role)
  ts            TIMESTAMPTZ NOT NULL,
  -- 봉투 암호화 산출물 (평문 필드 없음)
  key_version   SMALLINT NOT NULL DEFAULT 1,        -- KEK 회전 추적
  wrapped_dek   BYTEA NOT NULL,                     -- KEK 로 감싼 레코드별 데이터키
  iv            BYTEA NOT NULL,                     -- AES-GCM nonce (12B)
  ciphertext    BYTEA NOT NULL,                     -- AES-256-GCM(본문)
  auth_tag      BYTEA NOT NULL,                     -- GCM 인증태그 (16B)
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prompt_records_user_ts ON prompt_records (user_id, ts);
CREATE INDEX idx_prompt_records_session ON prompt_records (session_id);

-- RLS: 세션에 심긴 app.current_user_id 와 일치하는 행만 SELECT/INSERT.
-- 미설정 시 current_setting(_, true) → NULL → 정책 false → 0건 (fail-closed).
ALTER TABLE prompt_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_records FORCE  ROW LEVEL SECURITY;   -- 테이블 owner 도 정책 적용(superuser 는 여전히 우회)

CREATE POLICY prompt_owner_select ON prompt_records
  FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY prompt_owner_insert ON prompt_records
  FOR INSERT WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- ┌─ 운영 부트스트랩 (마이그레이션 밖에서 1회) ────────────────────────────────
-- │ RLS 는 앱이 "비-superuser·비-BYPASSRLS 롤" 로 접속할 때만 실제로 강제된다.
-- │ 현재 DATABASE_URL 이 superuser(예: postgres) 면 정책이 무시되므로, 전용 롤을 만들고
-- │ 앱 DATABASE_URL 을 그 롤로 바꿔야 보호가 발효된다:
-- │   CREATE ROLE toard_app LOGIN PASSWORD '...';
-- │   GRANT USAGE ON SCHEMA public TO toard_app;
-- │   GRANT SELECT, INSERT ON prompt_records TO toard_app;
-- │   GRANT SELECT ON providers, users TO toard_app;   -- FK 검증에 필요
-- └───────────────────────────────────────────────────────────────────────────

-- Down Migration
DROP TABLE IF EXISTS prompt_records CASCADE;
