-- toard 앱 런타임 롤(toard_app) 부트스트랩.
--
-- prompt_records 의 RLS(소유자 전용)는 앱이 "비-superuser·비-BYPASSRLS" 롤로 접속할 때만
-- 실제로 강제된다. superuser 접속은 RLS 를 우회한다(= 의도된 "DB 직접 접근" 탈출구).
-- 이 스크립트로 전용 롤을 만들고, 이후 앱의 DATABASE_URL 만 이 롤로 바꾼다.
-- 마이그레이션·seed 는 계속 관리(슈퍼유저) 롤로 실행한다.
--
-- 실행 (마이그레이션을 소유한 관리 롤로) — 비밀번호는 따옴표 없이 원문으로 전달한다
-- (스크립트가 :'app_password' 로 자동 인용하므로 안쪽에 작은따옴표를 넣지 말 것):
--   psql "$ADMIN_DATABASE_URL" -v app_password="교체할-강력한-비밀번호" \
--        -f scripts/bootstrap-app-role.sql
--   → 이후 앱: DATABASE_URL=postgres://toard_app:<비밀번호>@<host>:5432/<db>

\set ON_ERROR_STOP on

\if :{?app_password}
\else
  \echo '오류: app_password 변수가 필요합니다 (따옴표 없이 원문) —  -v app_password="강력한-비밀번호"  로 실행하세요'
  \quit
\endif

BEGIN;

-- 1) 롤 생성 (없을 때만) — 멱등
SELECT format('CREATE ROLE toard_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app')
\gexec

-- 재실행 시 비밀번호 갱신도 반영
ALTER ROLE toard_app LOGIN PASSWORD :'app_password';

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
END $$;

-- 3) 이후 마이그레이션이 만드는 객체에도 자동 적용
--    (이 스크립트를 실행한 관리 롤이 앞으로 만들 객체의 기본 권한 — 마이그레이션이 같은 롤로 돌 때 유효)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO toard_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO toard_app;

COMMIT;

-- 확인: RLS 가 발효되려면 rolsuper·rolbypassrls 가 모두 f 여야 한다
SELECT rolname, rolsuper AS is_superuser, rolbypassrls AS bypasses_rls
FROM pg_roles
WHERE rolname = 'toard_app';
