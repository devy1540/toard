-- ClickHouse 스키마 (설계 §4.3). 옵트인 모드: 이벤트·집계만, 메타는 PG.
-- 팀 시점 귀속을 위해 team_id 를 비정규화(수집 시점 스냅샷)한다.
-- raw TTL은 init에서 켜지 않는다. runtime opt-in 플래그가 90일 논리 기간 + 7일 grace = 97일을 적용한다.
CREATE DATABASE IF NOT EXISTS toard;

CREATE TABLE IF NOT EXISTS toard.usage_events
(
  dedup_key             String,
  provider_key          LowCardinality(String),
  user_id               String,            -- 미식별 = '' (빈 문자열)
  team_id               String,            -- 수집 시점 스냅샷(시점 귀속), 없으면 ''
  session_id            String,
  model                 LowCardinality(String),
  ts                    DateTime64(3, 'UTC'),
  input_tokens          UInt64,
  output_tokens         UInt64,
  cache_read_tokens     UInt64,
  cache_creation_tokens UInt64,
  cost_usd              Decimal(18, 8),
  pricing_revision_id   String DEFAULT '',
  cost_status           LowCardinality(String) DEFAULT 'legacy',
  log_adapter           LowCardinality(String) DEFAULT '',  -- logfile 경로 전용(§5.6), otel = ''
  host                  LowCardinality(String) DEFAULT '',  -- 발생 컴퓨터(호스트) 라벨, 미상 = ''
  inserted_at           DateTime64(3, 'UTC') DEFAULT now64(3)
)
-- ORDER BY = dedup_key 로 ReplacingMergeTree dedup 단위를 dedup_key 에 고정(같은 dedup_key 가
-- 다른 ts 로 와도 병합 보장). 시간범위 쿼리는 월 파티션으로 가지치기.
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (dedup_key);

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
