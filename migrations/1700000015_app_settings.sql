-- Up Migration

-- 서버 전역 설정 (key-value JSONB). 첫 사용처: 내장 가격 자동 동기화 on/off (admin 시스템 탭 토글).
-- env 가 아니라 DB 에 두는 이유 — 관리자가 재시작·재배포 없이 화면에서 바꾸고 즉시 반영돼야 한다.
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE app_settings;
