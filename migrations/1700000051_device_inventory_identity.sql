-- Up Migration

-- 기기 제어의 권위 식별자는 shim이 생성한 안정적인 fingerprint다.
-- 이전 (token, host) 키로 쌓인 동일 기기 중복은 가장 최근 스냅샷만 보존한다.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY ingest_token_id, fingerprint
           ORDER BY received_at DESC, id DESC
         ) AS position
  FROM device_tool_inventory_snapshots
)
DELETE FROM device_tool_inventory_snapshots snapshot
USING ranked
WHERE snapshot.id = ranked.id
  AND ranked.position > 1;

ALTER TABLE device_tool_inventory_snapshots
  DROP CONSTRAINT device_tool_inventory_snapshots_ingest_token_id_host_key;

ALTER TABLE device_tool_inventory_snapshots
  ADD CONSTRAINT device_tool_inventory_snapshots_token_fingerprint_key
  UNIQUE (ingest_token_id, fingerprint);

-- Down Migration

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY ingest_token_id, host
           ORDER BY received_at DESC, id DESC
         ) AS position
  FROM device_tool_inventory_snapshots
)
DELETE FROM device_tool_inventory_snapshots snapshot
USING ranked
WHERE snapshot.id = ranked.id
  AND ranked.position > 1;

ALTER TABLE device_tool_inventory_snapshots
  DROP CONSTRAINT device_tool_inventory_snapshots_token_fingerprint_key;

ALTER TABLE device_tool_inventory_snapshots
  ADD CONSTRAINT device_tool_inventory_snapshots_ingest_token_id_host_key
  UNIQUE (ingest_token_id, host);
