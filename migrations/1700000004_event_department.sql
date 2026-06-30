-- Up Migration

-- 부서 시점 귀속(설계 §4.3): 이벤트에 수집 시점 department_id 를 비정규화 →
-- ClickHouse 모드와 동등(시점 귀속) + getLeaderboard/getDailyTimeseries(scope=department)를
-- 크로스 조인 없이 처리. (현재 소속 JOIN 은 부서 이동 시 과거 비용을 현 부서로 잘못 귀속했음)
ALTER TABLE usage_events ADD COLUMN department_id UUID REFERENCES departments(id);
CREATE INDEX idx_usage_events_dept_ts ON usage_events (department_id, ts);

-- cost_usd 정밀도 통일 (events 14,8 / mart 16,8 / CH 18,8 → 전부 18,8)
ALTER TABLE usage_events            ALTER COLUMN cost_usd TYPE NUMERIC(18,8);
ALTER TABLE usage_daily_user        ALTER COLUMN cost_usd TYPE NUMERIC(18,8);
ALTER TABLE usage_daily_department  ALTER COLUMN cost_usd TYPE NUMERIC(18,8);

-- Down Migration
DROP INDEX IF EXISTS idx_usage_events_dept_ts;
ALTER TABLE usage_events DROP COLUMN IF EXISTS department_id;
ALTER TABLE usage_events            ALTER COLUMN cost_usd TYPE NUMERIC(14,8);
ALTER TABLE usage_daily_user        ALTER COLUMN cost_usd TYPE NUMERIC(16,8);
ALTER TABLE usage_daily_department  ALTER COLUMN cost_usd TYPE NUMERIC(16,8);
