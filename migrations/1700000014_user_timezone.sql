-- Up Migration

-- 사용자별 표시 타임존 (IANA, 예 'Asia/Seoul'). NULL = 자동(브라우저 감지 쿠키 사용).
-- 표출(기간 경계·버킷·시각 포맷) 전용 — Mart 물질화·cron 마감은 계속 ORG_TIMEZONE (ADR-008 개정).
ALTER TABLE users ADD COLUMN timezone TEXT;

-- Down Migration

ALTER TABLE users DROP COLUMN timezone;
