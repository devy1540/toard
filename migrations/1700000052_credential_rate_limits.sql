-- Up Migration

-- raw IP/email은 저장하지 않고 AUTH_SECRET HMAC-SHA256 digest만 key로 사용한다.
CREATE TABLE credential_rate_limits (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'ip', 'account')),
  key_hash BYTEA NOT NULL CHECK (octet_length(key_hash) = 32),
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key_hash)
);

CREATE INDEX credential_rate_limits_updated_idx ON credential_rate_limits (updated_at);
REVOKE ALL PRIVILEGES ON TABLE credential_rate_limits FROM PUBLIC;

CREATE FUNCTION consume_credential_rate_limit(p_scope TEXT, p_key_hash BYTEA)
RETURNS TABLE (is_allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_limit INTEGER;
  v_attempts INTEGER;
  v_window_started_at TIMESTAMPTZ;
  v_blocked_until TIMESTAMPTZ;
  v_backoff_seconds INTEGER;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('global', 'ip', 'account')
     OR p_key_hash IS NULL OR octet_length(p_key_hash) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid credential rate-limit key';
  END IF;

  v_limit := CASE p_scope
    WHEN 'account' THEN 5
    WHEN 'ip' THEN 60
    ELSE 300
  END;

  -- blocked hot path는 cleanup scan과 새 row 생성을 건너뛴다. FOR UPDATE 아래에서 한 번 더 재검사한다.
  SELECT blocked_until INTO v_blocked_until
    FROM public.credential_rate_limits
   WHERE scope = p_scope AND key_hash = p_key_hash;
  IF v_blocked_until IS NOT NULL AND v_blocked_until > v_now THEN
    RETURN QUERY SELECT false,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_blocked_until - v_now)))::INTEGER);
    RETURN;
  END IF;

  -- 공격자가 key를 계속 바꿔도 오래된 digest row가 무한히 쌓이지 않게 허용 후보 호출에서 최대 100개만 정리한다.
  DELETE FROM public.credential_rate_limits
   WHERE ctid IN (
     SELECT ctid FROM public.credential_rate_limits
      WHERE updated_at < v_now - interval '1 day'
      ORDER BY updated_at
      LIMIT 100
   );

  INSERT INTO public.credential_rate_limits
    (scope, key_hash, window_started_at, attempts, blocked_until, updated_at)
  VALUES (p_scope, p_key_hash, v_now, 0, NULL, v_now)
  ON CONFLICT (scope, key_hash) DO NOTHING;

  SELECT attempts, window_started_at, blocked_until
    INTO v_attempts, v_window_started_at, v_blocked_until
    FROM public.credential_rate_limits
   WHERE scope = p_scope AND key_hash = p_key_hash
   FOR UPDATE;

  IF v_blocked_until IS NOT NULL AND v_blocked_until > v_now THEN
    RETURN QUERY SELECT false,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_blocked_until - v_now)))::INTEGER);
    RETURN;
  END IF;

  IF v_window_started_at <= v_now - interval '15 minutes' THEN
    v_attempts := 1;
    v_window_started_at := v_now;
  ELSE
    v_attempts := v_attempts + 1;
  END IF;

  IF v_attempts > v_limit THEN
    v_backoff_seconds := LEAST(
      900,
      (30 * POWER(2, LEAST(GREATEST(v_attempts - v_limit - 1, 0), 5)))::INTEGER
    );
    v_blocked_until := v_now + make_interval(secs => v_backoff_seconds);
  ELSE
    v_backoff_seconds := 0;
    v_blocked_until := NULL;
  END IF;

  UPDATE public.credential_rate_limits
     SET window_started_at = v_window_started_at,
         attempts = v_attempts,
         blocked_until = v_blocked_until,
         updated_at = v_now
   WHERE scope = p_scope AND key_hash = p_key_hash;

  RETURN QUERY SELECT v_backoff_seconds = 0, v_backoff_seconds;
END;
$$;

CREATE FUNCTION clear_credential_account_rate_limit(p_key_hash BYTEA)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_key_hash IS NULL OR octet_length(p_key_hash) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid credential rate-limit key';
  END IF;
  DELETE FROM public.credential_rate_limits WHERE scope = 'account' AND key_hash = p_key_hash;
END;
$$;

-- 이미 차단된 어느 scope도 다른 counter/key를 건드리지 않도록 세 budget을 한 호출에서 처리한다.
CREATE FUNCTION consume_credential_rate_limits(
  p_global_key BYTEA,
  p_ip_key BYTEA,
  p_account_key BYTEA
)
RETURNS TABLE (is_allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_allowed BOOLEAN;
  v_retry INTEGER;
  v_blocked_scope TEXT;
  v_blocked_key BYTEA;
BEGIN
  IF p_global_key IS NULL OR octet_length(p_global_key) <> 32
     OR p_ip_key IS NULL OR octet_length(p_ip_key) <> 32
     OR p_account_key IS NULL OR octet_length(p_account_key) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid credential rate-limit key';
  END IF;

  -- blocked scope가 이미 있으면 single-scope 함수의 INSERT/cleanup/update를 전혀 호출하지 않는다.
  SELECT COALESCE(MAX(
    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (blocked_until - v_now)))::INTEGER)
  ), 0)
    INTO v_retry
    FROM public.credential_rate_limits
   WHERE blocked_until > v_now
     AND (
       (scope = 'global' AND key_hash = p_global_key)
       OR (scope = 'ip' AND key_hash = p_ip_key)
       OR (scope = 'account' AND key_hash = p_account_key)
     );
  IF v_retry > 0 THEN
    RETURN QUERY SELECT false, v_retry;
    RETURN;
  END IF;

  -- 고정 lock 순서(account→IP→global)로 소비한다. 후행 scope가 threshold를 넘으면 이 subtransaction의
  -- 선행 INSERT/UPDATE/cleanup을 모두 rollback하고, 차단 scope 하나만 밖에서 다시 소비해 backoff를 남긴다.
  BEGIN
    SELECT result.is_allowed, result.retry_after_seconds INTO v_allowed, v_retry
      FROM public.consume_credential_rate_limit('account', p_account_key) result;
    IF NOT v_allowed THEN
      v_blocked_scope := 'account'; v_blocked_key := p_account_key;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credential rate limited';
    END IF;

    SELECT result.is_allowed, result.retry_after_seconds INTO v_allowed, v_retry
      FROM public.consume_credential_rate_limit('ip', p_ip_key) result;
    IF NOT v_allowed THEN
      v_blocked_scope := 'ip'; v_blocked_key := p_ip_key;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credential rate limited';
    END IF;

    SELECT result.is_allowed, result.retry_after_seconds INTO v_allowed, v_retry
      FROM public.consume_credential_rate_limit('global', p_global_key) result;
    IF NOT v_allowed THEN
      v_blocked_scope := 'global'; v_blocked_key := p_global_key;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credential rate limited';
    END IF;

    RETURN QUERY SELECT true, 0;
    RETURN;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    -- 위 subtransaction의 선행 scope mutation은 이 시점에 이미 rollback됐다.
    SELECT result.is_allowed, result.retry_after_seconds INTO v_allowed, v_retry
      FROM public.consume_credential_rate_limit(v_blocked_scope, v_blocked_key) result;
    RETURN QUERY SELECT false, v_retry;
    RETURN;
  END;
END;
$$;

REVOKE ALL ON FUNCTION consume_credential_rate_limit(TEXT, BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_credential_rate_limits(BYTEA, BYTEA, BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION clear_credential_account_rate_limit(BYTEA) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toard_app') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.credential_rate_limits FROM toard_app';
    EXECUTE 'REVOKE ALL ON FUNCTION public.consume_credential_rate_limit(TEXT, BYTEA) FROM toard_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.consume_credential_rate_limits(BYTEA, BYTEA, BYTEA) TO toard_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.clear_credential_account_rate_limit(BYTEA) TO toard_app';
  END IF;
END $$;

-- Down Migration

DROP FUNCTION IF EXISTS clear_credential_account_rate_limit(BYTEA);
DROP FUNCTION IF EXISTS consume_credential_rate_limits(BYTEA, BYTEA, BYTEA);
DROP FUNCTION IF EXISTS consume_credential_rate_limit(TEXT, BYTEA);
DROP TABLE IF EXISTS credential_rate_limits;
