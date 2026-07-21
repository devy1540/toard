-- Up Migration

-- Cursor Agent의 user-global stop hook이 제공하는 정확 토큰을 logfile 경로로 수집한다.
-- 기존 설치에도 provider FK가 먼저 준비되도록 seed와 별도로 멱등 등록한다.
INSERT INTO providers (key, display_name, service_name_patterns, collection_method, enabled)
VALUES ('cursor', 'Cursor', ARRAY[]::text[], 'logfile', true)
ON CONFLICT (key) DO UPDATE
SET display_name = EXCLUDED.display_name,
    collection_method = EXCLUDED.collection_method,
    enabled = true;

-- Down Migration

DELETE FROM providers WHERE key = 'cursor';
