-- Up Migration

-- logfile 수집 경로(§5.6 v3): shim 이 어떤 벤더 어댑터로 읽었는지 식별 (설계 §4.2).
-- otel 경로는 NULL. 번호 1700000007 은 main 의 팀 리네임 마이그레이션과의 충돌 회피로 건너뜀.
ALTER TABLE usage_events ADD COLUMN log_adapter TEXT;

-- Down Migration

ALTER TABLE usage_events DROP COLUMN log_adapter;
