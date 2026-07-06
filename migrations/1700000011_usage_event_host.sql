-- Up Migration

-- 발생 컴퓨터(호스트) 라벨 (설계 design-host-breakdown). 같은 계정이 여러 컴퓨터에서
-- 써도 컴퓨터별로 사용량을 구분해 볼 수 있게, shim 이 채우는 표시용 hostname.
-- NULL = 미상(마이그레이션 이전 이벤트·구 shim·미식별). dedup_key 미포함(순수 서술 차원).
ALTER TABLE usage_events ADD COLUMN host TEXT;

-- "내 사용량" 컴퓨터별 분해(byHost, 기간-스코프)와 "내 기기 목록"(getUserHosts, 언바운드
-- MAX(ts)) 양쪽을 커버: user_id → host → ts 순.
CREATE INDEX idx_usage_events_user_host_ts ON usage_events (user_id, host, ts);

-- Down Migration

DROP INDEX IF EXISTS idx_usage_events_user_host_ts;
ALTER TABLE usage_events DROP COLUMN host;
