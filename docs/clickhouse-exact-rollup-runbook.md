# ClickHouse Exact Rollup Runbook

이 문서는 ClickHouse rollup을 운영에서 켜기 전에 확인할 절차를 정리한다.
비밀값은 출력하지 않고, production DB에는 쓰지 않는다.

현재 읽기 구조는 가격 provenance를 보존한 15분 v2와 IANA 시간대별 hour/day cache다.
구 `usage_hourly_rollup`은 더 이상 대시보드 source가 아니다. 기존
`CLICKHOUSE_READ_ROLLUP` 값은 `CLICKHOUSE_READ_TIMEZONE_ROLLUP`의 **deprecated
alias**로만 해석되고, registry·coverage·dirty guard를 모두 통과한 cache만 사용한다.
준비되지 않은 구간은 15분 v2 또는 raw exact source로 fallback한다.

legacy 값이 남아 있으면 process당 한 번 구조화된 deprecation warning을 남기며,
`/api/ready`는 DB 연결 정상 시 HTTP 200을 유지하면서
`rollups.legacyFlagMigration=deprecated_alias`, `rollups.timezone=fallback`을 반환한다.
새 flag에 비어 있지 않은 값을 명시하면 새 flag가 legacy alias보다 우선한다.

아래 historical 15분 v1 구조에서는 compactor와 read를 별도 opt-in으로 운영했다.
현재 신규 전환은 9절의 v2 플래그만 사용한다.

## Historical reference: 구 hourly·15분 v1 검증

아래 1~8절은 과거 `usage_hourly_rollup`과 15분 v1의 raw diff 방법을 보존한 참고 자료다.
현재 버전의 enable·rollback 지침이 아니며, 구 hourly source를 다시 활성화하는 데
사용하면 안 된다. 실제 업그레이드는 9절의 v2·시간대 cache 절차만 따른다.

## 1. 현재 중복 상태 확인 (historical)

ClickHouse 컨테이너 안에서 실행한다. 비밀번호는 컨테이너 env를 그대로 사용하고 출력하지 않는다.

```bash
docker compose exec -T clickhouse sh -lc \
  'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT
  count() AS rows,
  uniqExact(dedup_key) AS uniq_keys,
  rows - uniq_keys AS duplicate_rows
FROM toard.usage_events
FORMAT TSV
SQL
```

`duplicate_rows`가 0이어야 rollup 전환을 검토할 수 있다.

## 2. Postgres outbox 상태 확인

```bash
docker compose exec -T postgres psql "$DATABASE_URL" <<'SQL'
SELECT status, count(*) AS batches
FROM clickhouse_usage_batches
GROUP BY status
ORDER BY status;

SELECT count(*) AS pending_rows
FROM clickhouse_usage_outbox
WHERE delivered_at IS NULL;
SQL
```

`pending_rows`가 계속 증가하면 ClickHouse delivery가 막힌 상태다. 현재 v2/timezone 전환을 진행하지 않는다.

## 3. backfill / live writer 겹침 금지

대시보드 숫자에 중복이 있으면 안 되므로 backfill과 live rollup writer가 같은 raw
event를 동시에 처리하면 안 된다.

구 hourly 검증 당시에는 다음 중 하나를 만족해야 했다.

- 짧은 write drain 윈도우를 잡고 앱 수집/flush를 멈춘 뒤, outbox pending rows가 0인
  상태에서 과거 raw 데이터를 rollup에 backfill한다.
- 또는 backfill 대상 기간과 live writer 대상 기간이 절대 겹치지 않는 cutoff를 잡고,
  그 cutoff 기준으로 raw-vs-rollup diff가 0임을 확인한다.

이 조건을 만족하지 못하면 historical raw-vs-hourly 비교 결과를 신뢰하지 않는다.

## 4. raw vs rollup 비교

rollup backfill이 끝난 뒤 같은 기간으로 비교한다.

```sql
WITH raw AS (
  SELECT
    uniqExactIf(session_id, session_id != '') AS sessions,
    uniqExactIf(user_id, user_id != '') AS active_users,
    sum(cost_usd) AS cost,
    sum(input_tokens) AS input,
    sum(output_tokens) AS output,
    sum(cache_read_tokens) AS cache_read,
    sum(cache_creation_tokens) AS cache_creation
  FROM toard.usage_events FINAL
  WHERE ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}
),
rollup AS (
  SELECT
    uniqExactIf(session_id, session_id != '') AS sessions,
    uniqExactIf(user_id, user_id != '') AS active_users,
    sum(cost_usd) AS cost,
    sum(input_tokens) AS input,
    sum(output_tokens) AS output,
    sum(cache_read_tokens) AS cache_read,
    sum(cache_creation_tokens) AS cache_creation
  FROM toard.usage_hourly_rollup
  WHERE bucket_hour >= {from:DateTime64(3)} AND bucket_hour < {to:DateTime64(3)}
)
SELECT
  raw.sessions - rollup.sessions AS sessions_diff,
  raw.active_users - rollup.active_users AS active_users_diff,
  raw.cost - rollup.cost AS cost_diff,
  raw.input - rollup.input AS input_diff,
  raw.output - rollup.output AS output_diff,
  raw.cache_read - rollup.cache_read AS cache_read_diff,
  raw.cache_creation - rollup.cache_creation AS cache_creation_diff
FROM raw CROSS JOIN rollup;
```

모든 diff가 0이어야 한다.

## 5. 로컬 백업 검증

운영 데이터를 로컬에서 검증하려면 production에서 직접 쓰지 말고, export 후 로컬 ClickHouse/Postgres에 import한다.

- ClickHouse `usage_events`는 `FORMAT Native` 또는 `FORMAT JSONEachRow`로 export한다.
- Postgres는 `providers`, `users`, `teams`처럼 label/dedup 검증에 필요한 메타만 dump한다.
- 로컬 import 후 `scripts/verify-clickhouse-exact-rollup.ts`와 raw-vs-rollup 비교 SQL을 실행한다.

## 6. 전환 기준

다음은 historical hourly 비교의 완료 기준이며 현재 read 전환 기준이 아니다.

- ClickHouse raw duplicate count가 0이다.
- Postgres outbox pending rows가 안정적으로 0으로 돌아온다.
- raw vs rollup diff가 0이다.
- `/api/ready`가 200이고 ClickHouse 컨테이너가 healthy다.

## 7. 구 운영 전환 절차 (historical, 실행 금지)

전환은 앱 컨테이너만 재시작한다. ClickHouse/Postgres까지 함께 재생성하는
`docker compose up -d` 형태의 전체 apply는 피한다. ClickHouse가 재시작되는 동안
앱이 먼저 요청을 받으면 대시보드 SSR이 일시적으로 실패할 수 있기 때문이다.

```bash
docker compose ps clickhouse
curl -fsS http://127.0.0.1:${PORT:-3000}/api/ready

# 이 historical 절차의 flag 변경 명령은 제거됐다.
# 현재 버전에서는 9절의 v2/timezone migration만 실행한다.
```

전환 직후 다음을 확인한다.

```bash
docker compose ps app clickhouse
docker compose logs --since=5m app | grep -Ei 'ECONNREFUSED|ENOTFOUND|digest|Error' || true
curl -fsS http://127.0.0.1:${PORT:-3000}/api/ready
```

호스트 `127.0.0.1:${PORT:-3000}`만 connection reset이고 컨테이너 내부 ready는 200이면
Docker 포트 프록시가 꼬인 상태다. 이때는 ClickHouse나 다른 서비스를 건드리지 말고
앱 컨테이너만 재시작한다.

```bash
docker compose restart app
```

구 flag rollback 지침도 폐기됐다. 현재 rollback은 9.3절에서 새 read flag만 비운다.

## 8. 15분 hot/cold v1 전환 절차 (historical, 실행 금지)

15분 rollup은 기존 hourly rollup과 별도 플래그로 단계 전환한다.

### 8.1 스키마 배포

먼저 새 버전을 배포하되 read/compactor 플래그는 켜지 않는다.

```env
CLICKHOUSE_15M_ROLLUP_COMPACTOR=
CLICKHOUSE_READ_15M_ROLLUP=
```

이 상태에서는 `usage_15m_rollup`, `clickhouse_rollup_watermarks`,
`clickhouse_rollup_dirty_buckets` 스키마만 준비되고 대시보드 쿼리는 기존 경로를 쓴다.

### 8.2 compactor만 켜기

```bash
cp .env ".env.bak.15m-rollup-$(date +%Y%m%d%H%M%S)"
if grep -q '^CLICKHOUSE_15M_ROLLUP_COMPACTOR=' .env; then
  sed -i.bak 's/^CLICKHOUSE_15M_ROLLUP_COMPACTOR=.*/CLICKHOUSE_15M_ROLLUP_COMPACTOR=1/' .env
else
  printf '\nCLICKHOUSE_15M_ROLLUP_COMPACTOR=1\n' >> .env
fi

docker compose up -d --no-deps --force-recreate app
```

기본값은 30분보다 오래된 bucket만 확정하고, tick 당 최대 16개 bucket을 처리한다.
저스펙 서버에서 backlog가 크면 `CLICKHOUSE_ROLLUP_MAX_BUCKETS`를 급격히 올리지 말고
query_log와 CPU를 보며 천천히 조정한다.

### 8.3 shadow 검증

Postgres 상태:

```bash
docker compose exec -T postgres psql "$DATABASE_URL" <<'SQL'
SELECT name, watermark, updated_at
FROM clickhouse_rollup_watermarks
ORDER BY name;

SELECT name, count(*) AS dirty_buckets, min(bucket) AS oldest_dirty, max(bucket) AS newest_dirty
FROM clickhouse_rollup_dirty_buckets
GROUP BY name
ORDER BY name;
SQL
```

ClickHouse row 상태:

```bash
docker compose exec -T clickhouse sh -lc \
  'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT
  count() AS rows,
  min(bucket_15m) AS first_bucket,
  max(bucket_15m) AS last_bucket
FROM toard.usage_15m_rollup
FORMAT TSV
SQL
```

같은 기간 raw vs 15분 rollup diff가 0이어야 한다.

```sql
WITH raw AS (
  SELECT
    uniqExactIf(session_id, session_id != '') AS sessions,
    uniqExactIf(user_id, user_id != '') AS active_users,
    sum(cost_usd) AS cost,
    sum(input_tokens) AS input,
    sum(output_tokens) AS output,
    sum(cache_read_tokens) AS cache_read,
    sum(cache_creation_tokens) AS cache_creation
  FROM toard.usage_events FINAL
  WHERE ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}
),
rollup AS (
  SELECT
    uniqExactIf(session_id, session_id != '') AS sessions,
    uniqExactIf(user_id, user_id != '') AS active_users,
    sum(cost_usd) AS cost,
    sum(input_tokens) AS input,
    sum(output_tokens) AS output,
    sum(cache_read_tokens) AS cache_read,
    sum(cache_creation_tokens) AS cache_creation
  FROM (
    SELECT
      bucket_15m,
      provider_key,
      user_id,
      team_id,
      session_id,
      model,
      host,
      argMax(input_tokens, version) AS input_tokens,
      argMax(output_tokens, version) AS output_tokens,
      argMax(cache_read_tokens, version) AS cache_read_tokens,
      argMax(cache_creation_tokens, version) AS cache_creation_tokens,
      argMax(cost_usd, version) AS cost_usd
    FROM toard.usage_15m_rollup
    WHERE bucket_15m >= {from:DateTime64(3)} AND bucket_15m < {to:DateTime64(3)}
    GROUP BY bucket_15m, provider_key, user_id, team_id, session_id, model, host
  )
)
SELECT
  raw.sessions - rollup.sessions AS sessions_diff,
  raw.active_users - rollup.active_users AS active_users_diff,
  raw.cost - rollup.cost AS cost_diff,
  raw.input - rollup.input AS input_diff,
  raw.output - rollup.output AS output_diff,
  raw.cache_read - rollup.cache_read AS cache_read_diff,
  raw.cache_creation - rollup.cache_creation AS cache_creation_diff
FROM raw CROSS JOIN rollup;
```

### 8.4 read 전환

dirty backlog가 안정적으로 줄고 raw-vs-rollup diff가 0이면 시계열 조회만 전환한다.

```bash
if grep -q '^CLICKHOUSE_READ_15M_ROLLUP=' .env; then
  sed -i.bak 's/^CLICKHOUSE_READ_15M_ROLLUP=.*/CLICKHOUSE_READ_15M_ROLLUP=1/' .env
else
  printf '\nCLICKHOUSE_READ_15M_ROLLUP=1\n' >> .env
fi

docker compose up -d --no-deps --force-recreate app
curl -fsS http://localhost:${PORT:-3000}/api/ready
```

이 설명은 v1 당시의 동작 기록이다. 현재 overview·leaderboard·breakdown을 포함한
대시보드 source는 9절의 공통 v2/timezone router를 사용하며 구 hourly로 돌아가지 않는다.

### 8.5 rollback

문제가 있으면 read flag부터 끈다.

```bash
sed -i.bak 's/^CLICKHOUSE_READ_15M_ROLLUP=.*/CLICKHOUSE_READ_15M_ROLLUP=/' .env
docker compose up -d --no-deps --force-recreate app
```

compactor까지 멈추려면 다음을 추가로 적용한다.

```bash
sed -i.bak 's/^CLICKHOUSE_15M_ROLLUP_COMPACTOR=.*/CLICKHOUSE_15M_ROLLUP_COMPACTOR=/' .env
docker compose up -d --no-deps --force-recreate app
```

rollback 때 `usage_15m_rollup` 테이블은 drop하지 않는다.

## 9. 다중 해상도 v2·시간대 cache 전환

### 기존 legacy flag 설치의 필수 업그레이드 순서

`CLICKHOUSE_READ_ROLLUP`이 남은 설치는 다음 순서를 지킨다.

1. **schema**를 먼저 배포하고 read flag는 바꾸지 않는다.
2. `pnpm rollup:activate-timezones` **activation CLI**를 실행한다.
3. v2/timezone **worker**를 켜고 registry·job·durable **coverage**를 확인한다.
4. exact verifier와 HTTP **benchmark**를 통과한다.
5. `CLICKHOUSE_READ_TIMEZONE_ROLLUP`, `CLICKHOUSE_READ_15M_V2_ROLLUP` 새 read flag를 켠다.
6. 마지막으로 `CLICKHOUSE_READ_ROLLUP` legacy 값을 **unset**하고 앱만 재생성한다.

legacy alias 기간에도 ready coverage가 없으면 exact fallback하므로 구
`usage_hourly_rollup`을 읽지 않는다. `/api/ready`의 migration 상태가 null이 된 뒤에만
legacy 정리가 완료된 것으로 본다.

아래 다섯 환경변수는 모두 기본 off다. shadow writer와 read router를 독립적으로 전환한다.

| 환경변수 | 켜는 시점 | 효과 |
|---|---|---|
| `CLICKHOUSE_15M_V2_COMPACTOR` | 15분 v2 shadow | 가격 revision/status를 보존한 `usage_15m_rollup_v2` 생성 |
| `CLICKHOUSE_READ_15M_V2_ROLLUP` | 시간대 cache read 검증 뒤 | 15분 v2 + 미확정 raw tail 조회 |
| `CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR` | 활성 시간대 shadow | 조직 기본·저장 사용자 IANA 시간대의 hour/day cache 작업 처리 |
| `CLICKHOUSE_READ_TIMEZONE_ROLLUP` | raw diff·benchmark 통과 뒤 | 완료된 시간대별 day/hour cache 조회, 나머지는 15분 v2 fallback |
| `CLICKHOUSE_ENFORCE_RETENTION_TTL` | 모든 read 전환·관찰 뒤 마지막 | raw `usage_events`에 물리 97일 TTL(논리 90일 + safety grace 7일) 적용 |

### 9.1 고정 rollout 순서

1. **schema 배포** — 다섯 플래그를 빈 값으로 둔 채 앱을 배포한다.
2. **15분 v2 shadow** — `CLICKHOUSE_15M_V2_COMPACTOR=1`만 켜고 watermark·dirty bucket을 관찰한다.
3. **활성 시간대 shadow** — `CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR=1`을 켠다. 앱 startup이 `ORG_TIMEZONE`과 `SELECT DISTINCT timezone FROM users`를 canonicalize·capability-check해 비동기로 활성화한다. 아래 비대화형 seed와 SQL로 registry/job/coverage를 확인한다.
4. **raw diff·benchmark** — 지원하는 다섯 시간대의 exactness와 400일·100만 이벤트 성능 gate를 통과한다.
5. **timezone day/hour read** — `CLICKHOUSE_READ_TIMEZONE_ROLLUP=1`을 켠다.
6. **15분 v2 read** — `CLICKHOUSE_READ_15M_V2_ROLLUP=1`을 켠다.
7. **raw TTL** — 최소 한 관찰 기간 동안 오류·diff·성능 회귀가 없을 때만 `CLICKHOUSE_ENFORCE_RETENTION_TTL=1`을 켠다.

각 플래그 변경은 앱 컨테이너에만 적용한다.

```bash
docker compose up -d --no-deps --force-recreate app
curl -fsS http://127.0.0.1:${PORT:-3000}/api/ready
```

startup activation 실패는 서버 기동과 요청을 막지 않는다. 같은 process의 viewer read(saved user timezone, browser cookie, `ORG_TIMEZONE`)가 다시 activation을 시도하고, 실패 gate는 해제되므로 다음 read/startup에서 재시도된다. rollout에서 대기하지 않고 즉시 seed하려면 소스 checkout 또는 운영 도구 컨테이너에서 다음을 실행한다.

```bash
STORAGE_BACKEND=clickhouse \
DATABASE_URL=postgres://toard:toard@localhost:5432/toard \
CLICKHOUSE_URL=http://localhost:8123 \
ORG_TIMEZONE=UTC \
pnpm rollup:activate-timezones
```

성공 출력은 `{"ok":true,"activated":[...],"skipped":[],"failed":[]}` 형식이다. `failed`가 있으면 종료 코드 1이며 DB/ClickHouse 연결을 복구한 뒤 같은 명령을 그대로 재실행한다. activation은 최대 64개 canonical IANA 시간대를 등록한다. 신규 또는 durable coverage가 없는 bucket에만 `ON CONFLICT DO NOTHING`으로 작업을 추가하며, day는 최근 400 local days, hour는 최근 32 local days를 각각 16-bucket chunk로 prewarm한다. 정상 `done` job과 coverage는 재시작·replica activation에서 유지되고, v2 dirty propagation만 coverage 삭제와 `pending` 전환을 수행한다.

```sql
SELECT timezone, activated_at, last_requested_at
FROM clickhouse_rollup_timezones
ORDER BY timezone;

SELECT resolution, status, count(*)
FROM clickhouse_timezone_rollup_jobs
GROUP BY resolution, status
ORDER BY resolution, status;

SELECT resolution, timezone, count(*) AS covered_buckets
FROM clickhouse_timezone_rollup_coverage
GROUP BY resolution, timezone
ORDER BY resolution, timezone;
```

`/api/ready`의 `rollups.timezone`은 read flag가 꺼졌으면 `disabled`, finalize 지연을 뺀 최신 15분 기준점 대비 watermark backlog가 30분 이내이고 pending 작업이 10,000개 이하면 `healthy`, watermark가 없거나 backlog가 30분을 넘거나 pending 작업이 10,000개를 넘으면 `fallback`이다. `fallback`이어도 Postgres와 ClickHouse 연결이 정상이면 HTTP 200을 유지하고 더 세밀한 소스로 읽는다. 함께 반환되는 `timezoneWatermark`, `timezoneLagSeconds`, `timezonePendingJobs`로 원인을 확인한다.

### 9.2 shadow와 성능 gate

```bash
DATABASE_URL=postgres://toard:toard@localhost:5432/toard \
CLICKHOUSE_URL=http://localhost:8123 \
pnpm exec tsx scripts/verify-clickhouse-exact-rollup.ts

pnpm benchmark:dashboard-http
```

릴리스 gate는 `docker-compose.benchmark.yml`의 전용 profile로 tmpfs 기반 app·Postgres·ClickHouse를 실제 기동한다. host runner가 Docker inspect의 `NanoCpus`/quota와 `Memory`를 검증해 app 1.5 vCPU/2 GiB, Postgres 1 vCPU/2 GiB, ClickHouse 1.5 vCPU/4 GiB가 정확히 적용된 경우에만 app 컨테이너 내부 측정을 시작한다. app도 자기 cgroup의 `cpu.max`와 `memory.max`를 다시 확인한다. 제한이 다르거나 컨테이너가 없으면 fixture 생성 전에 실패한다.

매 실행마다 격리된 Postgres schema와 ClickHouse database를 만들고 400일·이벤트 1,000,000건·사용자 100명·provider 5개·model 10개·고정 UUID 사용자/팀 fixture를 검증한다. cache는 direct INSERT하지 않고 raw → 15분 v2 compactor → 다섯 IANA 시간대 activation → bounded worker → durable coverage의 production code path로 만든다. 종료 시 benchmark schema/database와 전용 Compose 컨테이너를 정리한다. Postgres/ClickHouse 데이터 디렉터리는 benchmark tmpfs라 운영 volume에 접근하지 않는다.

스크립트는 임의 local credentials admin과 JWT 세션을 만들어 `AUTH_MODE=oauth`, `AUTH_CREDENTIALS_ENABLED=true`인 production `next build/start`를 localhost 별도 포트(기본 3117)에 띄운다. 비밀번호·`AUTH_SECRET`은 출력하지 않는다. `Asia/Seoul`, `America/Los_Angeles`, `Asia/Kolkata`, `Asia/Kathmandu`, `Europe/London`의 조직 최근 12개월, provider filter, 팀, 개인 대시보드를 각각 100회 요청한다. 각 요청 전에 ClickHouse query/uncompressed/mark cache를 비우고 고유 cache-busting URL과 `no-cache` header를 사용한다. 로그인 redirect, HTTP 200 이외 응답, 기대 page marker 누락은 즉시 실패다. 응답 본문을 끝까지 읽은 duration을 정렬해 `p50=sorted[49]`, `p95=sorted[94]`로 판정하고 하나라도 P50 1,000ms 또는 P95 2,000ms를 넘으면 종료 코드 1이다.

release 실행과 merged Compose 확인은 다음과 같다.

```bash
docker compose -f docker-compose.benchmark.yml --profile benchmark config
pnpm benchmark:dashboard-http
```

`pnpm benchmark:dashboard-http:diagnostic`은 같은 HTTP fixture를 host localhost에서 점검하지만 결과를 `DIAGNOSTIC_PASS`로만 출력한다. `pnpm benchmark:rollup:micro`는 timezone cache table의 ClickHouse SQL만 100회 재는 하위 진단 도구다. 둘 다 reference resource limit 전체를 검증하지 않으므로 release 통과 근거로 사용하지 않는다.

wrapper는 active Docker child에 `SIGINT`/`SIGTERM`을 전달한 뒤 idempotent `docker compose down --remove-orphans`를 기다리고 각각 exit 130/143으로 종료한다. 같은 signal이 반복되거나 정상 `finally`와 signal handler가 경쟁해도 down은 한 번만 실행한다. 정상 benchmark 뒤 down이 실패하면 exit 1이고, benchmark와 down이 모두 실패하면 `AggregateError`에 두 원인을 보존한다. 실제 제한 stack을 중단한 뒤 container/network가 남지 않는지는 다음으로 검증한다.

```bash
pnpm test:benchmark-dashboard-signal
```

exact verifier는 localhost에서 raw TTL을 잠시 97일로 적용한 뒤 원래 상태로 복원한다. 실제 90일 경계 이벤트를 저장하고 TTL merge 후 raw 생존과 15분 v2 반영을 확인하므로, 운영 DB가 아닌 격리된 로컬 데이터에서만 실행한다.

### 9.3 read rollback

불일치, watermark 정지, 성능 기준 초과가 발생하면 문제가 생긴 read flag만 비우고 앱 컨테이너만 재생성한다. writer, Postgres, ClickHouse, cache table은 유지해 원인 분석과 재검증에 사용한다.

```bash
# 시간대별 day/hour read 문제
sed -i.bak 's/^CLICKHOUSE_READ_TIMEZONE_ROLLUP=.*/CLICKHOUSE_READ_TIMEZONE_ROLLUP=/' .env
docker compose up -d --no-deps --force-recreate app

# 15분 v2 read 문제
sed -i.bak 's/^CLICKHOUSE_READ_15M_V2_ROLLUP=.*/CLICKHOUSE_READ_15M_V2_ROLLUP=/' .env
docker compose up -d --no-deps --force-recreate app
```

`CLICKHOUSE_ENFORCE_RETENTION_TTL`은 원본 삭제가 시작되기 전 마지막 단계에서만 켠다. 이 플래그는 API·쿼리의 90일 논리 경계를 바꾸지 않고, 정확히 90일 경계에서 수락된 이벤트가 outbox/compactor에 반영되도록 raw에 7일 safety grace를 더한 물리 97일 TTL만 적용한다. 이미 TTL로 삭제된 원본은 read flag rollback으로 복구되지 않으므로 shadow·read gate를 건너뛰지 않는다.

background retention cleanup은 canonical 보정 근거인 delivered outbox/batch를 raw와 같은 97일 뒤 FK 순서대로, `done` timezone job을 7일 뒤 삭제한다. `pending`·`inflight`는 삭제하지 않는다. 완료 job을 정리해도 12개월 cache 판정이 사라지지 않도록 migration `1700000023`이 durable `clickhouse_timezone_rollup_coverage`를 backfill하고, worker 성공 시 coverage를 기록한다. 같은 bucket이 v2 dirty propagation으로 다시 pending이 될 때만 coverage를 먼저 무효화하므로 오래된 cache를 완료로 오인하지 않는다.
