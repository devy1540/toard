# HTTP Dashboard SLO Gate Fix Report

## Scope

- 기존 `scripts/benchmark-timezone-rollup.ts`는 direct ClickHouse SQL microbenchmark로 유지하고 release gate에서 분리했다.
- `scripts/benchmark-dashboard-http.ts`를 추가해 credentials JWT 로그인, production Next build/start, 실제 dashboard HTTP body 완료까지 측정한다.
- fixture는 실행마다 localhost 전용 Postgres schema와 ClickHouse database에 격리한다.
- 100만 raw event를 15분 v2 compactor와 timezone activation/worker로 처리하고 durable coverage를 검증한다. timezone cache direct INSERT는 사용하지 않는다.
- 조직 5개 시간대, provider filter, team, individual 페이지를 각각 100회 측정한다.

## TDD Evidence

- RED: localhost/production 차단, fixed fixture 인자, percentile index, login redirect/body marker 계약을 구현 전 실패로 확인했다.
- GREEN: benchmark helper 테스트 6개가 통과한다.
- RED: 동시 7개 dashboard 집계가 readiness SQL을 각각 7회 실행함을 확인했다.
- GREEN: 동일 process의 concurrent in-flight snapshot만 공유해 registry/watermark/dirty/jobs/coverage를 각 1회 읽는다. settle 또는 reject 즉시 제거하고 다음 순차 호출은 새 DB 상태를 읽는다.
- RED: 같은 timezone/date range의 400일 calendar bucket을 집계마다 다시 계산함을 확인했다.
- GREEN: 순수 day calendar plan만 최대 64개 재사용하고 hour plan은 보관하지 않는다. user usage 4개 집계도 병렬화했다.

## Fixture and Auth Verification

- raw fixture: events 1,000,000 / days 400 / users 100 / providers 5 / models 10 / teams 1.
- 고정 valid UUID benchmark admin과 team을 Postgres와 ClickHouse 양쪽에 사용했다.
- 5개 timezone 모두 day 400 bucket과 hour 768 bucket을 activation으로 enqueue했다.
- bounded production worker가 5,840개 job을 처리하고 durable coverage를 기록했다.
- `AUTH_MODE=oauth`, `AUTH_CREDENTIALS_ENABLED=true`로 임의 local-only credentials admin을 로그인했다. `AUTH_MODE=open`은 사용하지 않았다.
- secret/password는 출력하지 않았다.
- 종료 뒤 benchmark Postgres schema와 ClickHouse database가 남지 않았음을 확인했다.

## HTTP Baseline Before Optimization

| Scenario | P50 ms | P95 ms | Result |
| --- | ---: | ---: | --- |
| org Asia/Seoul | 1615.08 | 1943.16 | FAIL P50 |
| org America/Los_Angeles | 1698.85 | 1836.45 | FAIL P50 |
| org Asia/Kolkata | 1655.20 | 1811.70 | FAIL P50 |
| org Asia/Kathmandu | 1664.65 | 1804.60 | FAIL P50 |
| org Europe/London | 1687.14 | 1830.80 | FAIL P50 |
| org provider filter | 1667.12 | 1813.41 | FAIL P50 |
| team | 1713.01 | 1865.67 | FAIL P50 |
| individual | 1415.03 | 1549.15 | FAIL P50 |

ClickHouse query log에서 핵심 집계 SQL은 평균 26~31ms, P95 34~42ms였다. 반복 timezone calendar plan과 source readiness가 server-side 병목이었다.

## HTTP Result After Optimization

각 요청 전에 `SYSTEM DROP QUERY CACHE`, `SYSTEM DROP UNCOMPRESSED CACHE`, `SYSTEM DROP MARK CACHE`를 완료한 뒤 stopwatch를 시작했다. 고유 URL과 no-cache headers로 Next response cache를 우회했고, HTTP 200과 route marker를 확인한 다음 response body를 끝까지 읽었다.

| Scenario | P50 ms | P95 ms | Result |
| --- | ---: | ---: | --- |
| org Asia/Seoul | 43.63 | 76.67 | PASS |
| org America/Los_Angeles | 41.88 | 52.94 | PASS |
| org Asia/Kolkata | 42.52 | 50.58 | PASS |
| org Asia/Kathmandu | 43.36 | 48.97 | PASS |
| org Europe/London | 46.58 | 56.33 | PASS |
| org provider filter | 45.44 | 52.30 | PASS |
| team | 61.48 | 74.28 | PASS |
| individual | 43.82 | 49.40 | PASS |

최악 P50은 team 61.48ms, 최악 P95는 org Asia/Seoul 76.67ms로 P50 1,000ms / P95 2,000ms 기준을 모두 통과했다.

## Verification

- `node --import tsx --test scripts/benchmark-dashboard-http.test.ts`: 6/6 PASS.
- `pnpm -r test`: PASS. web 132, storage-clickhouse 38 등 전체 workspace tests 통과.
- `pnpm -r typecheck`: PASS.
- `pnpm benchmark:dashboard-http`: production build/login/full 8 scenarios x 100 runs PASS.
- `git diff --check`: PASS.

## Environment Note

실측 localhost host process에는 Docker Compose 4 vCPU / 8 GiB 상한이 직접 적용되지 않았다. `docker-compose.benchmark.yml`은 app 1.5 vCPU/2 GiB, Postgres 1 vCPU/2 GiB, ClickHouse 1.5 vCPU/4 GiB의 참조 상한을 선언한다. release 직전 동일 제한 환경에서 재실행해야 한다. 현재 host 실측은 이 차이를 시작 시 명확히 출력했다.
