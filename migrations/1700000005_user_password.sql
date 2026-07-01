-- Up Migration

-- credentials(id/pw) 인증(ADR-007): 비밀번호 로그인 사용자만 해시 보유.
-- OAuth 전용 사용자는 NULL — authorize 에서 NULL 이면 credentials 로그인 거부.
ALTER TABLE users ADD COLUMN password_hash TEXT;

-- Down Migration
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
