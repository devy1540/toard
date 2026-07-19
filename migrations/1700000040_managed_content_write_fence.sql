-- Up Migration

-- Provider migration audit은 admin actor에게만 RLS로 공개된다. 일반 content writer가
-- audit 본문이나 actor를 읽지 않고 durable write fence identity만 얻도록 제한한다.
-- FORCE RLS에서는 NOSUPERUSER/NOBYPASSRLS table owner도 정책을 통과해야 한다. 함수 owner가
-- 실제 table owner일 때만 이 정책을 통과하므로 app role의 직접 audit 조회는 계속 막힌다.
CREATE POLICY content_key_security_events_fence_owner_select
  ON content_key_security_events
  FOR SELECT
  USING (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.content_key_security_events'::pg_catalog.regclass
    )
  );

CREATE FUNCTION latest_managed_content_write_fence()
RETURNS TABLE (
  provider TEXT,
  provider_fingerprint TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT event.provider, event.provider_fingerprint
    FROM content_key_security_events event
   WHERE event.event_type='provider_migration_started'
   -- started insert는 distribution advisory lock 아래 직렬화된다. id가 canonical
   -- fence revision이며 transaction-start created_at은 ordering에 사용하지 않는다.
   ORDER BY event.id DESC
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION latest_managed_content_write_fence() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    REVOKE ALL PRIVILEGES ON FUNCTION latest_managed_content_write_fence() FROM toard_app;
    GRANT EXECUTE ON FUNCTION latest_managed_content_write_fence() TO toard_app;
  END IF;
END $$;

-- Down Migration

REVOKE ALL ON FUNCTION latest_managed_content_write_fence() FROM toard_app;
DROP FUNCTION latest_managed_content_write_fence();
DROP POLICY content_key_security_events_fence_owner_select ON content_key_security_events;
