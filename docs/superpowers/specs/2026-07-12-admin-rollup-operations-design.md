# 관리자 Rollup 운영 화면 설계

작성일: 2026-07-12<br>
상태: 사용자 승인 설계

## 1. 목적

VPN이나 SSH 없이도 toard 관리자 화면에서 ClickHouse 다중 해상도 rollup의 진행 상태를 확인하고, 서버 부하나 오류가 발생하면 백필 worker를 안전하게 일시중지하거나 재개할 수 있게 한다.

이번 변경은 shadow writer의 운영 가능성을 높이는 것이 목적이다. 새 rollup 읽기 전환과 raw TTL 적용은 관리자 화면에서 제어하지 않는다.

## 2. 결정 사항

- 관리자 `/admin?tab=system`에 `데이터 Rollup` 영역을 추가한다.
- `usage_15m_v2`, `timezone` 두 worker를 독립적으로 표시하고 제어한다.
- 일시중지 상태는 Postgres에 저장하며 서버 재시작과 앱 업데이트 뒤에도 유지한다.
- 현재 실행 중인 batch는 강제 취소하지 않고 완료시킨 뒤 다음 tick부터 멈춘다.
- 재개 요청은 HTTP 요청 안에서 ClickHouse 작업을 실행하지 않는다. 다음 scheduler tick부터 처리한다.
- ClickHouse 배포에서 두 shadow worker는 기본 ON으로 바꾼다. 환경변수 값이 `0`, `false`, `off`이면 hard disable한다.
- `CLICKHOUSE_READ_15M_V2_ROLLUP`, `CLICKHOUSE_READ_TIMEZONE_ROLLUP`, `CLICKHOUSE_ENFORCE_RETENTION_TTL`은 계속 기본 OFF다.
- 초기 15분 v2 백필 시작점은 가장 오래된 raw와 최근 400일 경계 중 더 늦은 시각으로 제한한다.
- 정규화 전 디버깅 payload인 `raw_events`는 ClickHouse와 Postgres에서 7일만 보관한다.
- 구 `usage_hourly_rollup`에는 전환 기간 400일 TTL을 적용하고, read 전환과 롤백 관찰이 끝나기 전까지 호환성 쓰기를 유지한다.
- 시간대 durable coverage는 hour 32일, day 400일 범위 밖을 각 IANA 시간대의 로컬 경계 기준으로 정리한다.
- 관리자 화면은 한국어와 영어를 모두 지원한다.

## 3. 범위 밖

- 관리자 화면에서 read flag 전환
- 관리자 화면에서 raw TTL 활성화 또는 비활성화
- 실행 중인 ClickHouse 쿼리 강제 취소
- 호스트 전체의 CPU, 메모리, Docker 제어
- 임의 처리량 조절
- rollup 테이블 삭제나 재생성
- 구 hourly writer의 즉시 제거. 안전한 구 버전 롤백 관찰이 끝난 뒤 별도 배포에서 제거한다.

## 4. 런타임 우선순위

각 worker는 tick 시작 전에 다음 순서로 실행 가능 여부를 판단한다.

1. `STORAGE_BACKEND=clickhouse`가 아니면 `not_applicable`
2. 해당 환경변수가 `0`, `false`, `off`이면 `disabled`
3. 영구 제어 상태가 `paused=true`이면 `paused`
4. 그 외에는 작은 batch를 실행

환경변수 hard disable은 관리자 제어보다 우선한다. hard disable 상태에서는 관리자 화면의 재개 버튼을 비활성화하고 서버 설정을 변경해야 한다고 안내한다.

명시적인 true 값과 환경변수 미설정 또는 빈 값은 shadow worker 실행으로 해석한다. 이는 기존 Compose가 미설정 값을 빈 문자열로 전달하는 경우도 포함한다.

## 5. 데이터 모델

새 Postgres 테이블 `clickhouse_rollup_worker_status`를 추가한다.

| 컬럼 | 용도 |
|---|---|
| `worker` | `usage_15m_v2` 또는 `timezone`, 기본 키 |
| `paused` | 재시작 뒤에도 유지되는 관리자 일시중지 상태 |
| `last_started_at` | 가장 최근 tick 시작 시각 |
| `last_finished_at` | 가장 최근 tick 종료 시각 |
| `last_success_at` | 가장 최근 성공 시각 |
| `last_progress_at` | 처리 단위가 실제로 전진한 최근 시각 |
| `last_error_at` | 가장 최근 실패 시각 |
| `last_error` | 정제되고 길이가 제한된 최근 오류 |
| `last_duration_ms` | 최근 tick 실행시간 |
| `last_processed_units` | 최근 처리 bucket 또는 job 수 |
| `last_processed_rows` | 최근 생성 row 수 |
| `processed_units_total` | 원자적으로 누적한 처리 단위 수 |
| `processed_rows_total` | 원자적으로 누적한 row 수 |
| `throughput_units_per_minute` | 최근 실행을 반영한 이동평균 처리 속도 |
| `updated_at` | 상태 행 갱신 시각 |

`running` boolean은 저장하지 않는다. 프로세스가 작업 도중 종료되거나 여러 replica가 실행되면 stale 상태가 될 수 있기 때문이다. 화면 상태는 제어 상태, 남은 작업, 최근 진행 시각, 성공과 오류 시각으로 계산한다.

마이그레이션은 두 worker 행을 `paused=false`로 멱등 생성한다. 기존 배포는 새 이미지가 시작되면 shadow writer가 실행될 수 있으므로 read와 TTL이 꺼져 있다는 사실을 운영 화면에 함께 표시한다.

## 6. worker 상태 기록

worker tick은 다음 순서로 동작한다.

1. hard disable과 영구 pause 상태 확인
2. `last_started_at` 기록
3. 기존 advisory lock, watermark, job claim 계약으로 작은 batch 처리
4. 성공 시 완료 시각, 처리량, 누적값, 이동평균 갱신
5. 실제 처리 단위가 1개 이상이면 `last_progress_at` 갱신
6. 실패 시 완료 시각과 정제된 오류 기록

상태 기록 실패가 데이터 transaction의 정합성을 깨뜨리지 않게 rollup 작업과 관측 갱신의 책임을 분리한다. 다만 pause 상태를 읽지 못하거나 Postgres가 불능이면 해당 tick은 실행하지 않는다. 두 worker 모두 watermark와 job 관리에 Postgres가 필요하므로 이는 안전한 fail-closed 동작이다.

여러 replica가 실행해도 누적값은 SQL 증분으로 원자적으로 갱신한다. 15분 compactor는 기존 advisory lock을 유지하고, 시간대 worker는 기존 deduplicated job claim과 bucket advisory lock을 유지한다.

오류 문자열은 자격증명, URL 사용자 정보, SQL 파라미터를 제거하고 500자로 제한한다. 관리자 API는 stack trace를 반환하지 않는다.

## 7. 진행률과 ETA

### 7.1 15분 v2

- 목표 종료점: 현재 시각에서 finalize delay를 뺀 뒤 15분 경계로 내린 시각
- 목표 시작점: `max(raw 최초 bucket, 목표 종료점 - 400일)`
- 현재점: `usage_15m_v2` watermark
- 별도 표시: dirty bucket 수
- 남은 작업: watermark 이후 연속 bucket과 dirty bucket
- 진행률: 목표 구간에서 watermark가 전진한 비율, 0~100%로 제한

초기 watermark도 같은 400일 제한을 사용한다. 400일보다 오래된 raw를 집계한 뒤 TTL로 즉시 버리는 낭비를 방지한다.

### 7.2 시간대 hour/day cache

- 활성 시간대 registry를 기준으로 현재 prewarm 범위를 생성한다.
- day는 최근 400 local days, hour는 최근 32 local days다.
- durable coverage와 pending/inflight job을 resolution별로 집계한다.
- v2 dirty 전파로 coverage가 무효화되면 다시 남은 작업으로 계산한다.
- 완료 job이 7일 뒤 정리돼도 durable coverage를 완료 근거로 사용한다.

### 7.3 예상 완료 시간

ETA는 `남은 작업 / throughput_units_per_minute`로 계산한다. 이동평균 표본이 부족하거나 0이면 scheduler 기본 상한을 사용하고 화면에 `기본 처리량 기준`이라고 표시한다.

ETA는 보장 시간이 아니라 현재 처리 속도 기준 추정치다. paused, disabled, stalled, error 상태에서는 완료 시각 대신 해당 상태를 표시한다.

## 8. 파생 화면 상태

순간적인 `실행 중` 대신 운영 판단에 유용한 상태를 파생한다.

| 상태 | 조건 |
|---|---|
| `not_applicable` | Postgres storage backend |
| `disabled` | 환경변수 hard disable |
| `paused` | 관리자 영구 일시중지 |
| `starting` | 활성화됐지만 성공 기록이 아직 없고 시작 유예 시간 이내 |
| `catching_up` | 남은 작업이 있고 최근 3분 안에 진행 |
| `ready` | watermark와 coverage가 현재 목표에 도달 |
| `stalled` | 남은 작업이 있지만 3분 넘게 진행이 없음 |
| `error` | 최근 오류가 최근 성공보다 새로움 |

오류가 발생한 뒤 다음 tick이 성공하면 `error`에서 진행 상태로 복구한다. paused와 disabled는 오류보다 우선 표시하되 최근 오류 내용은 상세에 남긴다.

## 9. 관리자 API

### `GET /api/admin/rollups/status`

- 매 요청에서 admin 세션을 검증한다.
- worker 상태, 진행률, ETA, 활성 시간대, job/coverage, read mode, raw TTL 상태를 반환한다.
- raw, 15분, hour/day 테이블의 행 수와 디스크 크기를 반환한다.
- raw 최초·최신 시각을 반환한다.
- ClickHouse 데이터 규모 snapshot은 프로세스별로 30초 캐시한다.
- ClickHouse snapshot query에는 짧은 실행시간 상한을 둔다.
- 일부 관측 query가 실패하면 성공한 부분과 `degraded` 원인을 함께 반환한다.
- 비밀값, SQL, stack trace, 사용자별 원본 데이터는 반환하지 않는다.

### `POST /api/admin/rollups/control`

요청 본문:

```json
{
  "worker": "usage_15m_v2",
  "action": "pause"
}
```

- `worker`는 `usage_15m_v2`, `timezone`만 허용한다.
- `action`은 `pause`, `resume`만 허용한다.
- 매 요청에서 admin 세션을 검증한다.
- 같은 요청을 반복해도 같은 결과가 되는 멱등 UPSERT를 사용한다.
- hard disabled worker의 resume은 `409`와 안전한 사유를 반환한다.
- 성공 응답에는 갱신된 제어 상태를 포함한다.
- pause는 현재 query를 취소하지 않으며, resume은 요청 안에서 worker를 직접 실행하지 않는다.

## 10. 관리자 화면

기존 시스템 탭의 서버 버전, 가격 동기화, 본문 수집 영역과 같은 `SettingsRow` 문법을 사용한다. `데이터 Rollup` 영역은 초기 서버 렌더링 후 client panel이 상태 API를 갱신한다.

### 요약

- 전체 상태 badge
- 마지막 갱신 시각
- 현재 read source: exact, 15분 v2, 시간대 cache
- raw 97일 TTL 상태
- 수동 새로고침
- 화면이 보일 때만 10초 자동 갱신

### 15분 canonical

- 진행률
- 시작, watermark, 목표 시각
- 남은 bucket과 dirty bucket
- 최근 속도와 ETA
- 최근 batch bucket, row, 실행시간
- 마지막 성공과 최근 오류
- pause 또는 resume 버튼

### 시간대 cache

- 활성 시간대 목록
- hour/day coverage
- pending, inflight job
- 최근 속도와 ETA
- 최근 batch job, row, 실행시간
- 마지막 성공과 최근 오류
- pause 또는 resume 버튼

### 데이터 규모

- raw 데이터 최초·최신 시각
- raw, 15분 v2, hour/day cache의 행 수와 디스크 크기
- 정규화 전 `raw_events`, 구 `usage_hourly_rollup`, 시간대 coverage의 행 수와 디스크 크기 또는 Postgres 행 수
- snapshot 시각과 degraded 상태

hard disabled worker는 resume 버튼을 비활성화한다. 제어 요청 중에는 버튼을 중복 실행할 수 없게 하고, 성공 후 즉시 상태를 다시 조회한다.

## 11. 오류 처리

- 상태 API 일부 실패는 시스템 탭 전체 오류로 전파하지 않는다.
- Postgres 상태 조회 실패는 전체 rollup 영역에 `상태 확인 실패`로 표시한다.
- ClickHouse 규모 조회만 실패하면 진행률과 제어는 유지하고 데이터 규모 영역만 degraded로 표시한다.
- 제어 API 실패는 기존 pause 상태를 유지하고 사용자에게 안전한 메시지를 표시한다.
- worker 오류는 다음 tick에 자동 재시도하며 최근 오류와 시각을 관리자 화면에 남긴다.
- 상태가 stalled 또는 error여도 대시보드 read는 exact fallback을 유지한다.

## 12. 보조 데이터 retention

일일 retention tick은 worker 운영 상태와 별도로 다음 데이터를 정리한다.

| 데이터 | 정책 | 안전 조건 |
|---|---|---|
| ClickHouse `raw_events` | `received_at + 7일` TTL | 정규화 `usage_events`와 무관한 디버깅 payload |
| Postgres `raw_events` | 7일 초과 행을 bounded batch 삭제 | 같은 transaction에서 `usage_events.raw_event_id`를 먼저 `NULL`로 분리하고 정규화 행은 유지 |
| 구 `usage_hourly_rollup` | 전환 기간 400일 TTL | 호환성 writer는 read 전환·롤백 관찰 완료 전까지 유지 |
| 시간대 hour coverage | 최근 32 local days 밖 삭제 | IANA 시간대별 실제 시작 경계 계산 |
| 시간대 day coverage | 최근 400 local days 밖 삭제 | IANA 시간대별 실제 시작 경계 계산 |
| 완료 시간대 job | 기존대로 7일 뒤 삭제 | pending·inflight 제외 |

coverage cleanup은 해당 resolution과 timezone의 현재 prewarm 범위 밖만 삭제한다. DST 전환일에도 고정 24시간을 빼지 않고 기존 local-date resolver를 사용한다. retention 일부가 실패해도 다른 cleanup과 수집·대시보드를 중단하지 않으며 다음 일일 tick에 재시도한다.

## 13. 검증

### 단위 테스트

- 환경변수 기본 ON과 명시적 false hard disable
- pause가 hard disable보다 낮은 우선순위임을 검증
- 재시작 뒤 pause 상태 복원
- paused worker가 storage 작업이나 job claim을 호출하지 않음
- 현재 batch 완료 뒤 다음 tick부터 정지
- resume 뒤 다음 tick에서 재개
- 진행률, dirty bucket, ETA, 이동평균 계산
- 최근 성공과 오류 시각에 따른 상태 파생
- 오류 문자열 정제와 길이 제한
- 400일 초기 watermark clamp
- 7일 `raw_events` cutoff, Postgres 참조 분리, 정규화 행 보존
- 구 hourly 400일 TTL
- IANA local boundary 기반 hour 32일·day 400일 coverage cleanup

### API 테스트

- 비로그인 401, 비관리자 403
- status 응답에서 비밀값과 원본 사용 데이터가 없음
- pause/resume 입력 검증과 멱등성
- hard disable resume 409
- ClickHouse 부분 실패 시 degraded 응답

### UI 테스트

- Postgres backend의 not applicable 표시
- worker 상태별 badge와 버튼
- read와 TTL이 표시 전용이며 제어 버튼이 없음
- `raw_events`, 구 hourly, coverage 규모 표시
- 10초 갱신은 탭이 보일 때만 동작
- 제어 중 중복 클릭 방지와 성공 후 refresh
- 한국어와 영어 메시지 shape 일치

### 회귀 검증

- 전체 workspace typecheck와 test
- production Next.js build
- exact rollup verifier
- 100만 event 인증 HTTP release benchmark
- read flag와 TTL 기본 OFF 회귀 테스트
- 보조 데이터 retention 실패가 다른 cleanup과 수집을 막지 않는 회귀 테스트

## 14. 성공 기준

- 관리자는 VPN 없이 시스템 탭에서 두 worker의 상태, 진행률, ETA, 최근 오류를 확인한다.
- 상태는 화면이 보이는 동안 10초 이내에 갱신된다.
- pause는 현재 batch 이후 새 작업을 시작하지 않으며 재시작과 업데이트 뒤에도 유지된다.
- resume은 다음 scheduler tick, 최대 60초 안에 작업을 다시 시작한다.
- hard disable은 관리자 resume보다 우선한다.
- 초기 백필은 최근 400일보다 오래된 raw를 처리하지 않는다.
- 상태 수집 실패가 수집 API와 일반 대시보드를 중단하지 않는다.
- 관리자 화면에서는 read source와 TTL을 변경할 수 없다.
- 정규화 전 `raw_events`는 7일, 구 hourly는 전환 기간 400일, coverage는 hour 32일·day 400일로 제한된다.
- 보조 데이터 cleanup 뒤에도 정규화 사용량, 15분 canonical, 현재 시간대 cache 결과가 변하지 않는다.

## 15. 배포 순서

1. 최신 `origin/main`을 기능 브랜치에 통합하고 전체 회귀를 확인한다.
2. worker 상태와 보조 retention migration 및 앱 코드를 배포한다.
3. 앱 시작 뒤 시스템 탭에서 두 worker가 starting 또는 catching_up인지 확인한다.
4. 부하나 오류가 보이면 관리자 화면에서 해당 worker를 pause한다.
5. `raw_events` 7일 TTL, 구 hourly 400일 TTL, coverage cleanup 결과를 관리자 데이터 규모에서 확인한다.
6. 백필 완료 전에는 정규화 `usage_events`의 97일 TTL과 새 read flag를 켜지 않는다.
7. VPN 접근이 가능해지면 서버 관측값과 관리자 화면 값을 교차 검증한다.
8. exact 검증과 관찰 기간을 통과한 뒤 read flag를 순차 전환한다.
9. 정규화 `usage_events` raw TTL은 마지막 별도 운영 결정으로 남긴다.
10. 구 버전 롤백 관찰이 끝난 뒤 별도 배포에서 legacy hourly writer와 테이블 제거를 결정한다.

## 16. 롤백

- 관리자 pause는 즉시 영구 저장되며 다음 tick부터 작업을 멈춘다.
- 긴급 hard stop은 환경변수를 `0`으로 설정하고 앱을 재시작한다.
- 화면이나 상태 API 문제는 worker 데이터 테이블과 rollup 결과를 삭제하지 않고 앱 버전만 롤백한다.
- read flag와 TTL이 기본 OFF이므로 shadow writer 롤백이 일반 대시보드의 데이터 source를 변경하지 않는다.
- `raw_events`와 coverage는 canonical source가 아니므로 cleanup 뒤에도 정규화 데이터로 운영을 계속한다.
- 구 hourly writer는 롤백 관찰 기간 동안 유지하므로 구 앱으로 롤백해도 신규 시간 구간이 비지 않는다.
