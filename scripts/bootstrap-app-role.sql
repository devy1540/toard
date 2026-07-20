-- toard 앱 런타임 롤(toard_app) 부트스트랩.
--
-- prompt_records 의 RLS(소유자 전용)는 앱이 직접 로그인한 exact toard_app 롤로 접속하고,
-- 위험 속성·다른 role membership·RLS relation 소유권이 없을 때만 안전하게 강제된다.
-- superuser/BYPASSRLS/table owner 또는 owner role로 SET ROLE 가능한 연결은 RLS를 우회한다.
-- 이 스크립트로 전용 롤을 만들고, 이후 앱의 DATABASE_URL 만 이 롤로 바꾼다.
-- 마이그레이션·seed 는 계속 관리(슈퍼유저) 롤로 실행한다.
--
-- 실행 (마이그레이션을 소유한 관리 롤로): owner-only (0600) psql input file을 secret manager가 만들고,
-- 그 파일에 PSQL-quoted app_password 변수와 이 파일의 absolute \i 경로만 둔다.
-- 비밀번호를 terminal, shell env, process argv, repository에 넣지 않는다:
--   psql "$ADMIN_DATABASE_URL" -f /secure/bootstrap-app-role.psql
--   → 이후 앱: DATABASE_URL=postgres://toard_app:<비밀번호>@<host>:5432/<db>

\set ON_ERROR_STOP on

\if :{?app_password}
\else
  \echo '오류: app_password 변수가 필요합니다 — owner-only (0600) psql input file에서 PSQL-quoted 값으로 \set 하세요'
  \quit
\endif

BEGIN;

-- 1) 롤 생성 (없을 때만) — 멱등
SELECT format('CREATE ROLE toard_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app')
\gexec

-- 재실행 시 로그인·비밀번호와 모든 위험 role attribute를 exact-safe 상태로 복구한다.
-- NOINHERIT는 membership drift가 revoke되기 전에도 상속 권한이 활성화되지 않게 한다.
ALTER ROLE toard_app
  LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'app_password';

-- SET ROLE도 RLS/권한 경계를 우회할 수 있으므로 명시적으로 부여된 모든 role membership을 제거한다.
DO $$
DECLARE
  granted_role record;
BEGIN
  FOR granted_role IN
    SELECT granted.rolname
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles granted ON granted.oid = membership.roleid
     WHERE member.rolname = 'toard_app'
  LOOP
    EXECUTE format('REVOKE %I FROM toard_app', granted_role.rolname);
  END LOOP;
END $$;

-- 2) 스키마 + 현재 객체 권한
GRANT USAGE ON SCHEMA public TO toard_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO toard_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO toard_app;

-- 보안 민감 migration 객체는 broad table grant 뒤 다시 최소 권한으로 닫는다.
-- to_reg* 조건 덕분에 해당 migration 이전 설치에서도 이 bootstrap은 성공한다.
DO $$
BEGIN
  IF to_regclass('public.content_e2ee_migration_sources') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.content_e2ee_migration_sources FROM toard_app';
  END IF;

  IF to_regclass('public.content_e2ee_migrations') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.content_e2ee_migrations TO toard_app';
    EXECUTE 'REVOKE DELETE ON TABLE public.content_e2ee_migrations FROM toard_app';
  END IF;

  IF to_regprocedure('public.get_content_e2ee_migration_progress(uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.get_content_e2ee_migration_progress(UUID) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_content_e2ee_migration_progress(UUID) TO toard_app';
  END IF;

  IF to_regprocedure('public.capture_content_e2ee_migration_source()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.capture_content_e2ee_migration_source() FROM PUBLIC';
  END IF;

  IF to_regclass('public.content_key_operation_daily') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.content_key_operation_daily FROM toard_app';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.content_key_operation_daily TO toard_app';
    EXECUTE 'GRANT UPDATE (operation_count, total_latency_ms) ON TABLE public.content_key_operation_daily TO toard_app';
  END IF;

  IF to_regclass('public.content_key_security_events') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.content_key_security_events FROM toard_app';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.content_key_security_events TO toard_app';
  END IF;

  IF to_regclass('public.content_key_security_events_id_seq') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON SEQUENCE public.content_key_security_events_id_seq FROM toard_app';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.content_key_security_events_id_seq TO toard_app';
  END IF;

  IF to_regclass('public.managed_content_key_distribution') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.managed_content_key_distribution FROM toard_app';
    EXECUTE 'GRANT SELECT ON TABLE public.managed_content_key_distribution TO toard_app';
  END IF;

  -- singleton은 trigger/owner만 변경하고 app은 상태를 읽기만 한다.
  IF to_regclass('public.installation_identity') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.installation_identity FROM toard_app';
    EXECUTE 'GRANT SELECT ON TABLE public.installation_identity TO toard_app';
  END IF;

  IF to_regclass('public.content_encryption_status') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.content_encryption_status FROM toard_app';
    EXECUTE 'GRANT SELECT ON TABLE public.content_encryption_status TO toard_app';
  END IF;

  -- RLS가 사용자 key 행을 더 제한하고, table-level 권한도 필요한 mutation만 허용한다.
  IF to_regclass('public.managed_content_keys') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.managed_content_keys FROM toard_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.managed_content_keys TO toard_app';
  END IF;

  IF to_regprocedure('public.lock_managed_content_key_distribution()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.lock_managed_content_key_distribution() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.lock_managed_content_key_distribution() TO toard_app';
  END IF;

  IF to_regprocedure('public.latest_managed_content_write_fence()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.latest_managed_content_write_fence() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.latest_managed_content_write_fence() TO toard_app';
  END IF;

  IF to_regclass('public.deployment_release_completions') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.deployment_release_completions FROM toard_app';
    EXECUTE 'GRANT SELECT ON TABLE public.deployment_release_completions TO toard_app';
  END IF;

  IF to_regclass('public.user_team_assignments') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.user_team_assignments FROM toard_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.user_team_assignments TO toard_app';
  END IF;

  IF to_regclass('public.team_attribution_jobs') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.team_attribution_jobs FROM toard_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.team_attribution_jobs TO toard_app';
  END IF;

  IF to_regclass('public.team_attribution_read_fences') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.team_attribution_read_fences FROM toard_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.team_attribution_read_fences TO toard_app';
  END IF;

  IF to_regprocedure('public.complete_team_attribution_fence(uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.complete_team_attribution_fence(UUID) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.complete_team_attribution_fence(UUID) TO toard_app';
  END IF;
END $$;

-- 3) 이후 마이그레이션이 만드는 객체에도 자동 적용
--    (이 스크립트를 실행한 관리 롤이 앞으로 만들 객체의 기본 권한 — 마이그레이션이 같은 롤로 돌 때 유효)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO toard_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO toard_app;

COMMIT;

-- 확인: 위험 속성은 모두 f이고 membership 결과가 없어야 한다.
SELECT rolname,
       rolsuper AS is_superuser,
       rolbypassrls AS bypasses_rls,
       rolcreatedb AS can_create_database,
       rolcreaterole AS can_create_role,
       rolreplication AS can_replicate,
       rolinherit AS inherits_role_privileges
FROM pg_roles
WHERE rolname = 'toard_app';

SELECT granted.rolname AS granted_role
FROM pg_auth_members membership
JOIN pg_roles member ON member.oid = membership.member
JOIN pg_roles granted ON granted.oid = membership.roleid
WHERE member.rolname = 'toard_app';
