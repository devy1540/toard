-- log_adapter 컬럼 (설계 §4.2 v3 — logfile 수집 경로의 어댑터 식별자).
-- 신규 볼륨은 001-schema.sql 에 이미 포함돼 no-op. 기존 배포는 이 문장을 수동 적용:
--   docker exec <ch> clickhouse-client --query "$(cat clickhouse/init/002-log-adapter.sql)"
ALTER TABLE toard.usage_events ADD COLUMN IF NOT EXISTS log_adapter LowCardinality(String) DEFAULT '' AFTER cost_usd;
