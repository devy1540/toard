-- host 컬럼 (설계 design-host-breakdown — 발생 컴퓨터별 사용량 구분).
-- 신규 볼륨은 001-schema.sql 에 이미 포함돼 no-op. 기존 배포는 이 문장을 수동 적용:
--   docker exec <ch> clickhouse-client --query "$(cat clickhouse/init/003-host.sql)"
ALTER TABLE toard.usage_events ADD COLUMN IF NOT EXISTS host LowCardinality(String) DEFAULT '' AFTER log_adapter;
