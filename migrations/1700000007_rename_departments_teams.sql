-- Up Migration

-- 범용 리네임 (오픈소스 재포지셔닝): 부서(departments) → 팀(teams).
-- "부서"는 회사 조직 전제가 강해 커뮤니티·스터디 등 범용 사용처에 맞지 않음.
-- 운영 배포 전(pre-1.0)이라 데이터 이동 없는 RENAME 으로 처리.
ALTER TABLE departments RENAME TO teams;
ALTER TABLE users RENAME COLUMN department_id TO team_id;
ALTER TABLE usage_events RENAME COLUMN department_id TO team_id;

ALTER TABLE user_department_assignments RENAME TO user_team_assignments;
ALTER TABLE user_team_assignments RENAME COLUMN department_id TO team_id;

ALTER TABLE usage_daily_department RENAME TO usage_daily_team;
ALTER TABLE usage_daily_team RENAME COLUMN department_id TO team_id;

ALTER INDEX idx_usage_events_dept_ts RENAME TO idx_usage_events_team_ts;
ALTER INDEX idx_udd_day_provider RENAME TO idx_udt_day_provider;

-- Down Migration
ALTER INDEX idx_udt_day_provider RENAME TO idx_udd_day_provider;
ALTER INDEX idx_usage_events_team_ts RENAME TO idx_usage_events_dept_ts;

ALTER TABLE usage_daily_team RENAME COLUMN team_id TO department_id;
ALTER TABLE usage_daily_team RENAME TO usage_daily_department;

ALTER TABLE user_team_assignments RENAME COLUMN team_id TO department_id;
ALTER TABLE user_team_assignments RENAME TO user_department_assignments;

ALTER TABLE usage_events RENAME COLUMN team_id TO department_id;
ALTER TABLE users RENAME COLUMN team_id TO department_id;
ALTER TABLE teams RENAME TO departments;
