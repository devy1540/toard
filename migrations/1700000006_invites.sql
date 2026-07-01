-- Up Migration

-- 관리자 초대(초대 링크). 이메일 지정 + 1회용·만료. 평문 토큰은 sha256 해시로만 저장.
CREATE TABLE invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'admin'
  created_by  UUID REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 이메일당 미수락 초대는 하나만(재발급 시 이전 것 폐기하는 로직과 함께 조회용)
CREATE INDEX idx_invites_pending_email ON invites (email) WHERE accepted_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS invites;
