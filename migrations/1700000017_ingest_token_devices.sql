-- Up Migration

-- 기기별 토큰 관리를 위한 표시 메타데이터.
-- 평문 토큰·해시는 노출하지 않고, 사용자가 붙이는 라벨과 마지막으로 관측된 host 만 저장한다.
ALTER TABLE ingest_tokens ADD COLUMN device_label TEXT;
ALTER TABLE ingest_tokens ADD COLUMN last_host TEXT;

-- 설정 화면의 활성 토큰 목록 조회: user_id + active + 최신 발급순.
CREATE INDEX idx_ingest_tokens_user_active_created
  ON ingest_tokens (user_id, revoked_at, created_at DESC);

-- Down Migration

DROP INDEX IF EXISTS idx_ingest_tokens_user_active_created;
ALTER TABLE ingest_tokens DROP COLUMN IF EXISTS last_host;
ALTER TABLE ingest_tokens DROP COLUMN IF EXISTS device_label;
