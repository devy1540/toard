# Rollup 자동 전환·부하 보호 설계

## 목적

ClickHouse 사용량 조회가 정확성을 잃지 않으면서 준비된 rollup을 자동으로 사용하도록 한다. 과거 백필과 신규 수집을 분리해 신규 데이터 때문에 전환 완료가 계속 밀리지 않게 하고, 백필 부하는 서버가 감당할 수 있는 범위에서 자동 조절한다. 관리자는 같은 용어로 백필, 검증, 읽기 전환, 현재 조회 source를 확인한다.

성공 기준은 다음과 같다.

- 신규 수집이 계속돼도 고정된 과거 목표 시점 `T0`까지의 백필·검증이 끝나면 자동 전환된다.
- 준비된 구간만 rollup에서 읽고, 미완료·dirty·최근 미확정 구간은 더 세밀한 source로 대체 조회한다.
- 데이터 불일치는 즉시 rollup 읽기를 해제하고, 일시적인 연결 실패는 연속 실패 임계치 이후에만 해제한다.
- rollup worker는 서로 동시에 무거운 작업을 실행하지 않고 최근 batch 시간에 맞춰 처리량을 자동 조절한다.
- 기존 pause/resume, 물리 테이블, worker ID, 명시적 환경변수 override는 호환된다.
- 원본 TTL은 자동으로 켜지지 않는다. 데이터 삭제 성격이 있으므로 `CLICKHOUSE_ENFORCE_RETENTION_TTL` 설정을 계속 별도로 사용한다.

## 통일 용어

외부 UI·API·로그·문서에서는 아래 용어를 사용한다. DB 테이블 이름과 worker 식별자는 변경하지 않는다.

| 용어 | 내부 대상 | 역할 |
|---|---|---|
| 세밀한 원본 | `usage_events` | 최근 미확정 구간, 경계, 대체 조회와 검증 |
| 15분 기준 rollup | `usage_15m_rollup_v2`, `usage_15m_v2` | 정합성·복구 기준 |
| 시간대별 1시간 rollup | `usage_hourly_timezone_rollup`, timezone hour job | 시간별 일반 조회 |
| 시간대별 1일 rollup | `usage_daily_timezone_rollup`, timezone day job | 일별 장기 조회 |
| 대체 조회 | 기존 fallback | 미완료 구간을 더 세밀한 source에서 읽기 |
| 재계산 필요 | 기존 dirty | 늦은 데이터로 특정 버킷을 다시 생성해야 하는 상태 |

`cache`는 데이터의 재생성 가능성을 설명할 때만 보조적으로 사용하고, 운영 화면의 계층 이름에는 사용하지 않는다.

## 조회 계층

조회 기간만으로 source를 고르지 않고 요청 출력 해상도로 선택한다.

```text
15분·30분 출력 -> 15분 기준 rollup -> 최근/미완료 구간은 usage_events
시간 출력      -> 시간대별 1시간 rollup -> 15분 기준 rollup -> usage_events
일 출력        -> 시간대별 1일 rollup -> 15분 기준 rollup -> usage_events
```

시간대별 rollup은 해당 요청의 전체 범위를 만족할 필요가 없다. durable coverage가 이어지는 준비 구간만 사용하고, 앞·뒤·dirty 구간은 기존 hybrid source 조합으로 대체한다. 이 때문에 읽기 전환은 전체 데이터가 완벽히 준비된 경우에만 가능한 일회성 스위치가 아니라, 검증된 rollup 경로를 조회 후보로 허용하는 전환이다.

## 자동 전환 상태

PostgreSQL에 `clickhouse_rollup_cutover_status`를 추가하고 두 계층을 저장한다.

- `usage_15m_v2`: 15분 기준 rollup 읽기
- `timezone`: 시간대별 1시간·1일 rollup 읽기

각 행은 다음 정보를 가진다.

- `state`: `backfilling | observing | active | fallback`
- `target_watermark`: 관찰을 시작할 때 고정한 T0
- `healthy_seconds`: 신규 데이터와 무관하게 누적되는 정상 관찰 시간
- `last_checked_at`, `last_validation_at`
- `consecutive_failures`
- `last_failure_kind`: `mismatch | lag | unavailable | null`
- `last_failure`: 비밀값을 제거한 운영용 오류
- `activated_at`, `updated_at`

### T0 고정

15분 worker가 현재 시각에서 finalize 지연 30분을 뺀 확정 경계까지 도달하면 그 경계를 `target_watermark`로 저장한다. 이후 신규 데이터는 목표 시점을 움직이지 않는다.

```text
과거 데이터 ---------------- T0 | 신규 데이터 ---------------->
백필·검증·관찰 대상             | 실시간 worker가 계속 처리
```

T0 이전에 늦은 데이터가 들어오면 해당 버킷만 재계산 필요 상태가 된다. 관찰 시간은 문제가 해결되는 동안 증가하지 않지만 0으로 초기화하지 않는다. T0 이후 신규 데이터는 관찰 시간에 영향을 주지 않는다.

### 전환 순서

1. `usage_15m_v2`가 T0까지 도달하고 T0 이전 재계산 필요 버킷이 없으면 데이터 검증을 실행한다.
2. 검증 성공 후 `observing`으로 바꾸고 정상 관찰 시간을 누적한다.
3. 누적 정상 시간이 3,600초에 도달하면 `usage_15m_v2`를 `active`로 바꾼다.
4. 시간대 job의 pending/inflight가 0이고 active timezone의 대표 hour/day 검증이 성공하면 `timezone`도 같은 1시간 관찰을 시작한다.
5. `timezone`은 15분 기준 rollup이 `active`일 때만 `active`가 될 수 있다.

### 검증

15분 기준 rollup은 T0 이전의 보존 범위에서 세밀한 원본과 rollup을 같은 차원으로 집계해 비교한다. 비교 차원은 15분 버킷, provider, user, team, session, model, host, pricing revision, cost status이며 비교 값은 이벤트 수, 네 종류 토큰, 비용이다. 결과 행 수, 합계, 결정론적 fingerprint가 모두 같아야 한다.

시간대별 rollup은 활성 시간대마다 최근 완료 hour와 최근 완료 local day를 15분 기준 rollup에서 다시 계산해 비교한다. DST와 30분·45분 offset은 기존 local boundary resolver 테스트로 전체 범위를 검증하고, 런타임 검증은 현재 활성 시간대의 실제 데이터를 확인한다.

활성 상태에서는 6시간마다 최근 24시간의 15분 rollup과 각 활성 시간대의 최근 완료 hour/day를 재검증한다.

- 실제 데이터 불일치: 한 번이라도 발견하면 즉시 `fallback`
- watermark 지연, pending 과다, 연결 실패: 세 번 연속이면 `fallback`
- 정상 복구: 고정된 새 T0로 `observing`을 다시 수행한 뒤 자동 재전환

`fallback`은 데이터를 변경하지 않고 runtime read policy만 비활성화한다.

## 환경변수 호환성과 runtime read policy

읽기 환경변수는 emergency override로 유지한다.

| 환경변수 상태 | 동작 |
|---|---|
| 명시적 ON | runtime 상태와 관계없이 해당 guarded rollup read 허용 |
| 명시적 OFF | runtime 상태와 관계없이 해당 rollup read 금지 |
| 미설정 | `clickhouse_rollup_cutover_status.state = active`일 때만 허용 |

`ClickHouseStorage`는 runtime 상태를 10초 동안 캐시한다. PostgreSQL 조회 실패 또는 테이블 미존재 시 안전하게 OFF로 처리한다. 기존 coverage·watermark·dirty guard는 그대로 유지되므로 runtime 상태가 ON이어도 준비되지 않은 버킷은 사용하지 않는다.

## Adaptive worker와 부하 보호

기존 `clickhouse_rollup_worker_status`에 아래 정보를 추가한다.

- `adaptive_limit`: 다음 tick에서 요청할 최대 bucket/job 수
- `load_state`: `normal | throttled`

초깃값과 한도는 다음과 같다.

| worker | 초기 | 최소 | 최대 |
|---|---:|---:|---:|
| 15분 기준 rollup | 16 | 1 | 64 |
| 시간대별 rollup | 8 | 1 | 32 |

조절 규칙은 결정론적으로 유지한다.

- batch가 요청 한도를 모두 사용하고 2초 이하이면 `ceil(limit * 1.25)`로 증가
- batch가 10초 이상이거나 실행 오류이면 `floor(limit / 2)`로 감소하고 `throttled`
- 그 외에는 유지
- 성공한 짧은 batch가 backlog 부족으로 한도를 채우지 못하면 증가하지 않음
- 환경변수의 기존 최대 bucket 설정은 adaptive 최대의 추가 상한으로 사용

모든 rollup worker는 PostgreSQL advisory lock `toard:rollup-load-slot` 하나를 공유한다. 한 인스턴스와 여러 replica에서 15분·시간대별 worker가 동시에 무거운 ClickHouse 집계를 실행하지 않는다. 수집 outbox flush는 이 lock을 사용하지 않아 신규 수집을 막지 않는다.

관리자 pause/resume은 adaptive 제어보다 우선한다.

## 관리자 화면

상단에 자동 전환 요약을 표시한다.

- 현재 모드: 자동 / 서버 강제 ON / 서버 강제 OFF
- 계층별 상태: 백필 중 / 검증 관찰 중 / rollup 읽기 사용 / 대체 조회
- 고정 목표 시각 T0
- 정상 관찰 누적 시간 / 60분
- 마지막 검증 시각과 실패 종류

worker 카드에는 다음을 추가한다.

- 현재 adaptive batch 한도
- 부하 상태 normal/throttled
- 처리량과 최근 batch 시간
- 15분 기준 rollup과 시간대별 1시간·1일 rollup 용어

기존 일시 중지/재개와 저장 규모 표시는 유지한다. 관리자 화면에서 읽기 전환이나 TTL을 수동 조작하는 버튼은 추가하지 않는다.

## API와 로그

관리자 status API에 `cutover`와 worker의 `adaptiveLimit`, `loadState`를 추가한다. 내부 enum과 DB ID는 기존 snake_case를 유지하고 UI가 통일된 표시 이름을 사용한다.

전환 로그는 구조화된 한 줄로 기록한다.

```json
{"event":"rollup_cutover_transition","layer":"usage_15m_v2","from":"observing","to":"active","targetWatermark":"..."}
```

오류는 기존 `sanitizeRollupError`를 거쳐 비밀값을 제거한다.

## 비범위

- 원본 TTL 자동 활성화
- 물리 ClickHouse 테이블 이름 변경
- worker ID 변경
- 임의 처리량을 직접 입력하는 관리자 UI
- CPU·메모리별 OS 전용 측정
- rollup 데이터를 정합성 기준 원본으로 승격해 15분 기준 rollup을 조기 삭제하는 변경

## 검증 기준

- 상태 전이, T0 고정, 신규 데이터 비영향, mismatch 즉시 fallback, 일시 오류 3회 fallback을 단위 테스트한다.
- adaptive 증가·유지·감소·최소·최대와 shared load slot을 테스트한다.
- 환경변수 ON/OFF/미설정 runtime policy와 DB 실패 시 OFF를 테스트한다.
- hour/day coverage가 일부만 있을 때 prepared 구간과 대체 조회를 합치는 기존 테스트가 계속 통과한다.
- 한국어·영어 관리자 문구와 UI 타입 검사를 통과한다.
- 전체 `pnpm test`, `pnpm typecheck`, `pnpm build`, `git diff --check`를 통과한다.

