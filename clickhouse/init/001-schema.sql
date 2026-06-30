-- ClickHouse 스키마 (설계 §4.3). 옵트인 모드: 이벤트·집계만, 메타는 PG.
-- 부서 시점 귀속을 위해 department_id 를 비정규화(수집 시점 스냅샷)한다.
CREATE DATABASE IF NOT EXISTS toard;

CREATE TABLE IF NOT EXISTS toard.usage_events
(
  dedup_key             String,
  provider_key          LowCardinality(String),
  user_id               String,            -- 미식별 = '' (빈 문자열)
  department_id         String,            -- 수집 시점 스냅샷(시점 귀속), 없으면 ''
  session_id            String,
  model                 LowCardinality(String),
  ts                    DateTime64(3, 'UTC'),
  input_tokens          UInt64,
  output_tokens         UInt64,
  cache_read_tokens     UInt64,
  cache_creation_tokens UInt64,
  cost_usd              Decimal(18, 8),
  inserted_at           DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(inserted_at)
ORDER BY (user_id, ts, dedup_key);

-- 무손실 원형 보존(프롬프트 제거 후). id 는 앱이 생성해 전달.
CREATE TABLE IF NOT EXISTS toard.raw_events
(
  id           UInt64,
  provider_key LowCardinality(String),
  payload      String,
  received_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (received_at, id);
