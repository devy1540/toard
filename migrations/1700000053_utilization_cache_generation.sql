-- Up Migration

-- Next incremental cache는 pod-local이므로 tag 무효화만으로는 다른 replica의 stale entry를 막지 못한다.
-- 공유 generation은 cache key를 전 pod에서 전진시키고, 살아 있는 lease가 있으면 cache read를 우회한다.
CREATE TABLE utilization_cache_generations (
  scope TEXT NOT NULL CHECK (scope IN ('organization', 'personal_all', 'personal_user')),
  subject_id TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, subject_id),
  CHECK (
    (scope IN ('organization', 'personal_all') AND subject_id = '*')
    OR (scope = 'personal_user' AND subject_id ~ '^[0-9a-f-]{36}$')
  )
);

CREATE TABLE utilization_cache_change_leases (
  lease_id UUID NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('organization', 'personal_all', 'personal_user')),
  subject_id TEXT NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  externally_changed BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (lease_id, scope, subject_id),
  CHECK (
    (scope IN ('organization', 'personal_all') AND subject_id = '*')
    OR (scope = 'personal_user' AND subject_id ~ '^[0-9a-f-]{36}$')
  )
);
CREATE INDEX utilization_cache_change_leases_heartbeat_idx
  ON utilization_cache_change_leases (heartbeat_at);

INSERT INTO utilization_cache_generations (scope, subject_id)
VALUES ('organization', '*'), ('personal_all', '*');

CREATE FUNCTION read_utilization_cache_generation(p_user_id UUID)
RETURNS TABLE (
  personal_user_generation BIGINT,
  personal_user_pending INTEGER,
  personal_all_generation BIGINT,
  personal_all_pending INTEGER,
  organization_generation BIGINT,
  organization_pending INTEGER
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expired_lease RECORD;
BEGIN
  -- worker가 SIGKILL된 lease는 heartbeat 5분 뒤 회수한다. 회수 scope의 generation도 전진시켜
  -- 종료 직전 mutation 여부를 알 수 없는 경우에도 기존 cache key를 다시 사용하지 않는다.
  FOR expired_lease IN
    DELETE FROM public.utilization_cache_change_leases
    WHERE heartbeat_at < clock_timestamp() - interval '5 minutes'
    RETURNING scope, subject_id
  LOOP
    INSERT INTO public.utilization_cache_generations (scope, subject_id, generation)
    VALUES (expired_lease.scope, expired_lease.subject_id, 1)
    ON CONFLICT (scope, subject_id) DO UPDATE SET
      generation = utilization_cache_generations.generation + 1,
      updated_at = now();
  END LOOP;

  RETURN QUERY SELECT
    COALESCE((SELECT generation FROM public.utilization_cache_generations
              WHERE scope = 'personal_user' AND subject_id = p_user_id::text), 0),
    (SELECT count(*)::integer FROM public.utilization_cache_change_leases
     WHERE scope = 'personal_user' AND subject_id = p_user_id::text),
    (SELECT generation FROM public.utilization_cache_generations
     WHERE scope = 'personal_all' AND subject_id = '*'),
    (SELECT count(*)::integer FROM public.utilization_cache_change_leases
     WHERE scope = 'personal_all' AND subject_id = '*'),
    (SELECT generation FROM public.utilization_cache_generations
     WHERE scope = 'organization' AND subject_id = '*'),
    (SELECT count(*)::integer FROM public.utilization_cache_change_leases
     WHERE scope = 'organization' AND subject_id = '*');
END;
$$;

CREATE FUNCTION begin_user_utilization_cache_change(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lease_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.utilization_cache_generations (scope, subject_id)
  VALUES ('personal_user', p_user_id::text)
  ON CONFLICT (scope, subject_id) DO NOTHING;

  INSERT INTO public.utilization_cache_change_leases (lease_id, scope, subject_id)
  VALUES
    (v_lease_id, 'personal_user', p_user_id::text),
    (v_lease_id, 'organization', '*');
  RETURN v_lease_id;
END;
$$;

CREATE FUNCTION finish_user_utilization_cache_change(
  p_lease_id UUID,
  p_user_id UUID,
  p_changed BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_externally_changed BOOLEAN;
BEGIN
  WITH removed AS (
    DELETE FROM public.utilization_cache_change_leases
    WHERE lease_id = p_lease_id
    RETURNING utilization_cache_change_leases.externally_changed
  )
  SELECT COALESCE(bool_or(removed.externally_changed), false) INTO v_externally_changed
  FROM removed;

  IF p_changed OR v_externally_changed THEN
    UPDATE public.utilization_cache_generations
    SET generation = generation + 1, updated_at = now()
    WHERE scope = 'personal_user' AND subject_id = p_user_id::text;

    UPDATE public.utilization_cache_generations
    SET generation = generation + 1, updated_at = now()
    WHERE scope = 'organization' AND subject_id = '*';
  END IF;
END;
$$;

CREATE FUNCTION begin_all_utilization_cache_change()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lease_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.utilization_cache_change_leases (lease_id, scope, subject_id)
  VALUES
    (v_lease_id, 'personal_all', '*'),
    (v_lease_id, 'organization', '*');
  RETURN v_lease_id;
END;
$$;

CREATE FUNCTION finish_all_utilization_cache_change(p_lease_id UUID, p_changed BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_externally_changed BOOLEAN;
BEGIN
  WITH removed AS (
    DELETE FROM public.utilization_cache_change_leases
    WHERE lease_id = p_lease_id
    RETURNING utilization_cache_change_leases.externally_changed
  )
  SELECT COALESCE(bool_or(removed.externally_changed), false) INTO v_externally_changed
  FROM removed;

  IF p_changed OR v_externally_changed THEN
    UPDATE public.utilization_cache_generations
    SET generation = generation + 1, updated_at = now()
    WHERE scope IN ('personal_all', 'organization') AND subject_id = '*';
  END IF;
END;
$$;

CREATE FUNCTION heartbeat_utilization_cache_change(p_lease_id UUID)
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.utilization_cache_change_leases
  SET heartbeat_at = clock_timestamp()
  WHERE lease_id = p_lease_id
$$;

-- rolling update 중 구 pod는 generation helper를 호출하지 않으므로 canonical mutation table trigger가
-- 같은 generation을 전진시킨다. 신 pod wrapper와 중복 증가해도 cache key 단조성만 강화된다.
CREATE FUNCTION bump_utilization_cache_for_users(p_user_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  filtered_user_ids UUID[];
BEGIN
  -- 신 pod wrapper와 겹친 구 pod mutation은 lease를 dirty로 표시한다. 신 operation이 no-op으로
  -- 끝나도 finish가 generation을 전진시켜 rolling overlap 변경을 잃지 않는다.
  UPDATE public.utilization_cache_change_leases
  SET externally_changed = true
  WHERE scope = 'personal_all' AND subject_id = '*';

  UPDATE public.utilization_cache_change_leases lease
  SET externally_changed = true
  WHERE scope = 'personal_user'
    AND subject_id IN (
      SELECT input_users.user_id::text
      FROM unnest(p_user_ids) AS input_users(user_id)
      WHERE input_users.user_id IS NOT NULL
    );

  -- lease가 없는 구 pod/직접 DB mutation scope만 즉시 bump한다.
  SELECT array_agg(DISTINCT input_users.user_id) INTO filtered_user_ids
  FROM unnest(p_user_ids) AS input_users(user_id)
  WHERE input_users.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.utilization_cache_change_leases
      WHERE scope = 'personal_all' AND subject_id = '*'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.utilization_cache_change_leases
      WHERE scope = 'personal_user' AND subject_id = input_users.user_id::text
    );

  IF filtered_user_ids IS NULL OR cardinality(filtered_user_ids) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.utilization_cache_generations (scope, subject_id, generation)
  SELECT 'personal_user', user_id::text, 1
  FROM (
    SELECT DISTINCT user_id
    FROM unnest(filtered_user_ids) AS input_users(user_id)
    WHERE user_id IS NOT NULL
  ) users
  ON CONFLICT (scope, subject_id) DO UPDATE SET
    generation = utilization_cache_generations.generation + 1,
    updated_at = now();

  UPDATE public.utilization_cache_generations
  SET generation = generation + 1, updated_at = now()
  WHERE scope = 'organization' AND subject_id = '*';
END;
$$;

CREATE FUNCTION bump_all_utilization_cache()
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.utilization_cache_generations
  SET generation = generation + 1, updated_at = now()
  WHERE scope IN ('personal_all', 'organization') AND subject_id = '*'
$$;

CREATE FUNCTION bump_utilization_cache_from_changed_rows()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed_user_ids UUID[];
BEGIN
  SELECT array_agg(DISTINCT user_id) INTO changed_user_ids
  FROM changed_rows
  WHERE user_id IS NOT NULL
    AND (
      TG_TABLE_NAME <> 'tool_activity_events'
      OR provider_key IN ('claude_code', 'codex', 'cursor')
    );
  PERFORM public.bump_utilization_cache_for_users(COALESCE(changed_user_ids, ARRAY[]::uuid[]));
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_utilization_cache_from_outbox_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed_user_ids UUID[];
BEGIN
  SELECT array_agg(DISTINCT delivered.user_id) INTO changed_user_ids
  FROM delivered_rows delivered
  JOIN previous_rows previous USING (dedup_key)
  WHERE previous.delivered_at IS NULL
    AND delivered.delivered_at IS NOT NULL
    AND delivered.user_id IS NOT NULL;
  PERFORM public.bump_utilization_cache_for_users(COALESCE(changed_user_ids, ARRAY[]::uuid[]));
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_utilization_cache_from_pricing_replay()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.reconciled_events > OLD.reconciled_events THEN
    PERFORM public.bump_all_utilization_cache();
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER usage_events_utilization_cache_insert
AFTER INSERT ON usage_events
REFERENCING NEW TABLE AS changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_utilization_cache_from_changed_rows();

CREATE TRIGGER usage_events_utilization_cache_delete
AFTER DELETE ON usage_events
REFERENCING OLD TABLE AS changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_utilization_cache_from_changed_rows();

CREATE TRIGGER tool_activity_utilization_cache_insert
AFTER INSERT ON tool_activity_events
REFERENCING NEW TABLE AS changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_utilization_cache_from_changed_rows();

CREATE TRIGGER clickhouse_outbox_utilization_cache_insert
AFTER INSERT ON clickhouse_usage_outbox
REFERENCING NEW TABLE AS changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_utilization_cache_from_changed_rows();

CREATE TRIGGER clickhouse_outbox_utilization_cache_delete
AFTER DELETE ON clickhouse_usage_outbox
REFERENCING OLD TABLE AS changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_utilization_cache_from_changed_rows();

CREATE TRIGGER clickhouse_outbox_utilization_cache_delivery
AFTER UPDATE ON clickhouse_usage_outbox
REFERENCING OLD TABLE AS previous_rows NEW TABLE AS delivered_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_utilization_cache_from_outbox_delivery();

CREATE TRIGGER pricing_replay_utilization_cache_update
AFTER UPDATE ON pricing_repair_status
FOR EACH ROW EXECUTE FUNCTION bump_utilization_cache_from_pricing_replay();

REVOKE ALL PRIVILEGES ON TABLE utilization_cache_generations, utilization_cache_change_leases FROM PUBLIC;
REVOKE ALL ON FUNCTION read_utilization_cache_generation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_user_utilization_cache_change(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_user_utilization_cache_change(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_all_utilization_cache_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_all_utilization_cache_change(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION heartbeat_utilization_cache_change(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_utilization_cache_for_users(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_all_utilization_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_utilization_cache_from_changed_rows() FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_utilization_cache_from_outbox_delivery() FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_utilization_cache_from_pricing_replay() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE utilization_cache_generations, utilization_cache_change_leases FROM toard_app;
    GRANT EXECUTE ON FUNCTION read_utilization_cache_generation(UUID) TO toard_app;
    GRANT EXECUTE ON FUNCTION begin_user_utilization_cache_change(UUID) TO toard_app;
    GRANT EXECUTE ON FUNCTION finish_user_utilization_cache_change(UUID, UUID, BOOLEAN) TO toard_app;
    GRANT EXECUTE ON FUNCTION begin_all_utilization_cache_change() TO toard_app;
    GRANT EXECUTE ON FUNCTION finish_all_utilization_cache_change(UUID, BOOLEAN) TO toard_app;
    GRANT EXECUTE ON FUNCTION heartbeat_utilization_cache_change(UUID) TO toard_app;
  END IF;
END $$;

-- Down Migration

DROP TRIGGER IF EXISTS pricing_replay_utilization_cache_update ON pricing_repair_status;
DROP TRIGGER IF EXISTS clickhouse_outbox_utilization_cache_delivery ON clickhouse_usage_outbox;
DROP TRIGGER IF EXISTS clickhouse_outbox_utilization_cache_delete ON clickhouse_usage_outbox;
DROP TRIGGER IF EXISTS clickhouse_outbox_utilization_cache_insert ON clickhouse_usage_outbox;
DROP TRIGGER IF EXISTS tool_activity_utilization_cache_insert ON tool_activity_events;
DROP TRIGGER IF EXISTS usage_events_utilization_cache_delete ON usage_events;
DROP TRIGGER IF EXISTS usage_events_utilization_cache_insert ON usage_events;
DROP FUNCTION IF EXISTS bump_utilization_cache_from_pricing_replay();
DROP FUNCTION IF EXISTS bump_utilization_cache_from_outbox_delivery();
DROP FUNCTION IF EXISTS bump_utilization_cache_from_changed_rows();
DROP FUNCTION IF EXISTS bump_all_utilization_cache();
DROP FUNCTION IF EXISTS bump_utilization_cache_for_users(UUID[]);
DROP FUNCTION IF EXISTS heartbeat_utilization_cache_change(UUID);
DROP FUNCTION IF EXISTS finish_all_utilization_cache_change(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS begin_all_utilization_cache_change();
DROP FUNCTION IF EXISTS finish_user_utilization_cache_change(UUID, UUID, BOOLEAN);
DROP FUNCTION IF EXISTS begin_user_utilization_cache_change(UUID);
DROP FUNCTION IF EXISTS read_utilization_cache_generation(UUID);
DROP TABLE IF EXISTS utilization_cache_change_leases;
DROP TABLE IF EXISTS utilization_cache_generations;
